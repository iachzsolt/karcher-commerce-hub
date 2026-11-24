/**
 * Durable publication intent and evidence-based auto-pause ownership.
 *
 * Every state change is one atomic SQL statement (compare-and-set). The
 * database (migration 0029) enforces valid intent values and clears the
 * intent when an unaware writer changes the publication status or the
 * auto-pause flag, so unknown writers fail closed.
 *
 * Ownership classes:
 * - CONFIRMED_AUTOMATIC: stock_auto_paused, AUTOMATIC intent.
 * - LEGACY_AUTO_PAUSED: stock_auto_paused without intent (pre-0029 rows);
 *   keeps existing behavior, gains no new privileges.
 * - PENDING_AUTOMATIC: desired INACTIVE by an AUTOMATIC intent, not yet
 *   confirmed by command evidence.
 * - MANUAL: desired INACTIVE by a MANUAL intent.
 * - UNRESOLVED: desired INACTIVE without intent (legacy or cleared by an
 *   unaware writer); treated like manual, never claimed automatically.
 * - NONE: no inactive publication decision to own.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { createDatabase } from '@karcher-commerce-hub/database'

type Database = ReturnType<typeof createDatabase>

export type PublicationIntentSource = 'AUTOMATIC' | 'MANUAL'

export type PublicationOwnership =
  | 'CONFIRMED_AUTOMATIC'
  | 'LEGACY_AUTO_PAUSED'
  | 'PENDING_AUTOMATIC'
  | 'MANUAL'
  | 'UNRESOLVED'
  | 'NONE'

export type PublicationOwnershipInput = {
  stockAutoPaused: boolean
  desiredPublicationStatus: string | null
  publicationIntentSource?: string | null
  publicationIntentId?: string | null
}

export function classifyPublicationOwnership(row: PublicationOwnershipInput): PublicationOwnership {
  const source = row.publicationIntentId ? row.publicationIntentSource ?? null : null

  if (row.stockAutoPaused) {
    if (source === 'AUTOMATIC') return 'CONFIRMED_AUTOMATIC'
    if (source === null) return 'LEGACY_AUTO_PAUSED'
    // A manual intent always clears the flag; anything else is inconsistent.
    return 'UNRESOLVED'
  }

  if (row.desiredPublicationStatus !== 'INACTIVE') return 'NONE'
  if (source === 'AUTOMATIC') return 'PENDING_AUTOMATIC'
  if (source === 'MANUAL') return 'MANUAL'
  return 'UNRESOLVED'
}

/**
 * Column values for a manual publication decision. Every manual writer
 * spreads these into its update, so a new MANUAL intent is recorded even
 * when the desired publication status does not change.
 */
export function manualPublicationIntent(now = new Date()) {
  return {
    publicationIntentSource: 'MANUAL' as const,
    publicationIntentId: randomUUID(),
    publicationIntentAt: now,
  }
}

/**
 * Intent-preserving transitions advance publication_intent_at strictly, so
 * the 0029 guard trigger recognizes them as intent-aware even when two
 * statements share a transaction timestamp.
 */
export const PRESERVE_INTENT_AT = sql.raw(
  `greatest(clock_timestamp(), d.publication_intent_at + interval '1 microsecond')`,
)

type Expected = {
  desiredPublicationStatus: string | null
  publicationIntentId: string | null
}

const firstValue = (result: { rows: unknown[] }) => {
  const row = result.rows[0] as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : undefined
  return typeof value === 'string' ? value : null
}

/**
 * Record an AUTOMATIC END intent (desired INACTIVE) before any END command.
 *
 * CAS on the observed desired status and intent id. A still-pending
 * automatic END keeps its intent id (and intent time) so command evidence
 * stays bound to it; that case is a read, not a write, because any write of
 * desired_publication_status without a new intent is cleared by the 0029
 * guard. Refused for stock locks, disabled automation, an existing
 * auto-pause and any INACTIVE decision that is not a pending automatic one
 * (manual, unresolved or legacy). Returns the intent id or null.
 */
export async function beginAutomaticEndIntent(
  database: Database,
  listingId: string,
  expected: Expected,
): Promise<string | null> {
  const result = await database.execute(sql`
    with created as (
      update listing_desired_states d set
        desired_publication_status = 'INACTIVE',
        publication_intent_source = 'AUTOMATIC',
        publication_intent_id = gen_random_uuid(),
        publication_intent_at = now(),
        updated_by = 'COMMERCE_HUB_INVENTORY',
        updated_at = now()
      where d.listing_id = ${listingId}::uuid
        and d.stock_auto_paused = false
        and d.stock_locked = false
        and d.auto_stock_sync = true
        and d.desired_publication_status::text is not distinct from ${expected.desiredPublicationStatus}
        and d.publication_intent_id is not distinct from ${expected.publicationIntentId}::uuid
        and d.desired_publication_status <> 'INACTIVE'
      returning d.publication_intent_id::text as intent_id
    ),
    kept as (
      select d.publication_intent_id::text as intent_id
      from listing_desired_states d
      where d.listing_id = ${listingId}::uuid
        and d.stock_auto_paused = false
        and d.stock_locked = false
        and d.auto_stock_sync = true
        and d.desired_publication_status::text is not distinct from ${expected.desiredPublicationStatus}
        and d.publication_intent_id is not distinct from ${expected.publicationIntentId}::uuid
        and d.desired_publication_status = 'INACTIVE'
        and d.publication_intent_source = 'AUTOMATIC'
        and d.publication_intent_id is not null
    )
    select intent_id from created
    union all
    select intent_id from kept`)
  return firstValue(result)
}

/**
 * Record an AUTOMATIC ACTIVATE intent for an auto-paused listing (legacy
 * auto-pause included, as before). Keeps stock_auto_paused until the
 * existing ownership reconciliation releases it. A pending automatic
 * activation keeps its intent (read, not write). Returns the intent id.
 */
export async function beginAutomaticActivateIntent(
  database: Database,
  listingId: string,
  expected: Expected,
): Promise<string | null> {
  const result = await database.execute(sql`
    with created as (
      update listing_desired_states d set
        desired_publication_status = 'ACTIVE',
        publication_intent_source = 'AUTOMATIC',
        publication_intent_id = gen_random_uuid(),
        publication_intent_at = now(),
        updated_by = 'COMMERCE_HUB_INVENTORY',
        updated_at = now()
      where d.listing_id = ${listingId}::uuid
        and d.stock_auto_paused = true
        and d.stock_locked = false
        and d.auto_stock_sync = true
        and d.desired_publication_status::text is not distinct from ${expected.desiredPublicationStatus}
        and d.publication_intent_id is not distinct from ${expected.publicationIntentId}::uuid
        and d.publication_intent_source is distinct from 'MANUAL'
        and not (d.publication_intent_source = 'AUTOMATIC' and d.desired_publication_status = 'ACTIVE')
      returning d.publication_intent_id::text as intent_id
    ),
    kept as (
      select d.publication_intent_id::text as intent_id
      from listing_desired_states d
      where d.listing_id = ${listingId}::uuid
        and d.stock_auto_paused = true
        and d.stock_locked = false
        and d.auto_stock_sync = true
        and d.desired_publication_status::text is not distinct from ${expected.desiredPublicationStatus}
        and d.publication_intent_id is not distinct from ${expected.publicationIntentId}::uuid
        and d.publication_intent_source = 'AUTOMATIC'
        and d.desired_publication_status = 'ACTIVE'
        and d.publication_intent_id is not null
    )
    select intent_id from created
    union all
    select intent_id from kept`)
  return firstValue(result)
}

export type OwnershipScope = {
  accountId: string
  environment: string
}

/**
 * Confirm automatic ownership of a pending END intent.
 *
 * Requires, in one statement: the same AUTOMATIC intent still current;
 * the listing in the given account, environment and marketplace; a FRESH
 * persisted remote observation of ENDED/INACTIVE (same window as the
 * publication operation's cached match); and journal evidence that an END
 * command created for exactly this intent (ATTEMPTED with this intentId)
 * was reported SUCCESS by Allegro's own task report for this offer
 * (commandEvidence = ALLEGRO_TASK_SUCCESS), for this listing, offer and
 * account, after the intent was recorded. An ENDED observation alone - even
 * one journaled as SUCCESS of our command (REMOTE_STATE_ONLY) - a stale
 * observation, or a command of another intent never confirms ownership.
 */
export async function confirmAutomaticEndOwnership(
  database: Database,
  listingId: string,
  intentId: string,
  scope: OwnershipScope,
): Promise<boolean> {
  const result = await database.execute(sql`
    with confirmed as (
      update listing_desired_states d set
        stock_auto_paused = true,
        publication_intent_at = ${PRESERVE_INTENT_AT},
        updated_by = 'COMMERCE_HUB_INVENTORY',
        updated_at = now()
      from platform_listings pl
      join platform_accounts pa on pa.id = pl.account_id
      where d.listing_id = ${listingId}::uuid
        and pl.id = d.listing_id
        and pl.account_id = ${scope.accountId}::uuid
        and pl.marketplace = 'allegro-hu'
        and pa.environment = ${scope.environment}
        and d.publication_intent_source = 'AUTOMATIC'
        and d.publication_intent_id = ${intentId}::uuid
        and d.desired_publication_status = 'INACTIVE'
        and d.stock_auto_paused = false
        and exists (
          select 1 from listing_remote_states r
          where r.listing_id = d.listing_id and r.publication_status in ('ENDED', 'INACTIVE')
            and r.updated_at > now() - interval '15 minutes'
        )
        and exists (
          select 1
          from allegro_change_events ok
          join allegro_change_events att
            on att.listing_id = ok.listing_id
            and att.event_type = 'PUBLICATION_OPERATION'
            and att.old_value = 'END'
            and att.new_value = 'ATTEMPTED'
            and att.metadata_json::jsonb ->> 'commandId' = ok.metadata_json::jsonb ->> 'commandId'
            and att.metadata_json::jsonb ->> 'intentId' = ${intentId}
            and att.occurred_at >= d.publication_intent_at
          where ok.listing_id = d.listing_id
            and ok.event_type = 'PUBLICATION_OPERATION'
            and ok.old_value = 'END'
            and ok.new_value = 'SUCCESS'
            and ok.metadata_json::jsonb ->> 'commandId' is not null
            and ok.metadata_json::jsonb ->> 'commandEvidence' = 'ALLEGRO_TASK_SUCCESS'
            and ok.metadata_json::jsonb ->> 'intentId' = ${intentId}
            and ok.metadata_json::jsonb ->> 'offerId' = pl.external_listing_id
            and ok.metadata_json::jsonb ->> 'accountId' = ${scope.accountId}
            and ok.occurred_at >= att.occurred_at
        )
      returning d.listing_id
    ),
    audit as (
      insert into allegro_change_events (listing_id, event_type, source, old_value, new_value, metadata_json, occurred_at)
      select listing_id, 'OWNERSHIP', 'INVENTORY_AUTOMATION', 'false', 'true',
        json_build_object('reason', 'AUTOMATIC_END_CONFIRMED', 'intentId', ${intentId}::text)::text, now()
      from confirmed
      returning id
    )
    select listing_id::text as listing_id from confirmed`)
  return result.rows.length === 1
}

/**
 * Abandon a pending automatic END intent whose END never took effect
 * (remote still ACTIVE, positive target): desired goes back to ACTIVE under
 * a new AUTOMATIC intent. Refused while the listing's latest publication
 * command is unresolved, and for any intent other than the given one.
 */
export async function revertAutomaticEndIntent(
  database: Database,
  listingId: string,
  intentId: string,
): Promise<boolean> {
  const result = await database.execute(sql`
    update listing_desired_states d set
      desired_publication_status = 'ACTIVE',
      publication_intent_source = 'AUTOMATIC',
      publication_intent_id = gen_random_uuid(),
      publication_intent_at = now(),
      updated_by = 'COMMERCE_HUB_INVENTORY',
      updated_at = now()
    where d.listing_id = ${listingId}::uuid
      and d.publication_intent_source = 'AUTOMATIC'
      and d.publication_intent_id = ${intentId}::uuid
      and d.desired_publication_status = 'INACTIVE'
      and d.stock_auto_paused = false
      and coalesce((
        select e.new_value from allegro_change_events e
        where e.listing_id = d.listing_id and e.event_type = 'PUBLICATION_OPERATION'
        order by e.occurred_at desc, e.id desc
        limit 1
      ), 'SUCCESS') in ('SUCCESS', 'FAILED', 'CANCELLED_BEFORE_SEND')
    returning d.listing_id::text as listing_id`)
  return result.rows.length === 1
}
