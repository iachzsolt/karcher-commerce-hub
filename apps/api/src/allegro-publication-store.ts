import { and, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { allegroChangeEvents, createDatabase, listingDesiredStates, listingRemoteStates, platformAccounts, platformListings, platforms, products, schedulerLeases } from '@karcher-commerce-hub/database'
import { PUBLICATION_LEASE_MS, type PublicationAudit, type PublicationCommand, type PublicationLeaseStore, type PublicationObservation, type PublicationSnapshot, type PublicationTarget } from './allegro-publication-operation.js'

type Database = ReturnType<typeof createDatabase>
export function createPublicationLeaseStore(database: Database): PublicationLeaseStore {
  const expiry = sql<Date>`now() + (${PUBLICATION_LEASE_MS} * interval '1 millisecond')`
  return {
    acquire: async (name, ownerId) => {
      const rows = await database.insert(schedulerLeases).values({ name, ownerId, lockedUntil: expiry, updatedAt: sql`now()` })
        .onConflictDoUpdate({ target: schedulerLeases.name,
          set: { ownerId, lockedUntil: expiry, updatedAt: sql`now()` },
          setWhere: lte(schedulerLeases.lockedUntil, sql`now()`),
        }).returning({ ownerId: schedulerLeases.ownerId })
      return rows[0]?.ownerId === ownerId
    },
    renew: async (name, ownerId) => {
      const rows = await database.update(schedulerLeases).set({ lockedUntil: expiry, updatedAt: sql`now()` })
        .where(and(eq(schedulerLeases.name, name), eq(schedulerLeases.ownerId, ownerId), gt(schedulerLeases.lockedUntil, sql`now()`)))
        .returning({ ownerId: schedulerLeases.ownerId })
      return rows[0]?.ownerId === ownerId
    },
    release: async (name, ownerId) => {
      await database.delete(schedulerLeases).where(and(eq(schedulerLeases.name, name), eq(schedulerLeases.ownerId, ownerId)))
    },
  }
}

export async function readPublicationSnapshot(database: Database, listingId: string, accountId: string, environment: string): Promise<PublicationSnapshot | null> {
  const [row] = await database.select({
    listingId: platformListings.id, offerId: platformListings.externalListingId, accountId: platformListings.accountId,
    desiredPublication: listingDesiredStates.desiredPublicationStatus,
    intentVersion: sql<string>`to_jsonb(${listingDesiredStates})::text`,
    cachedPublication: listingRemoteStates.publicationStatus, observedAt: listingRemoteStates.updatedAt,
    productActive: products.active,
    freshManualIntent: sql<boolean>`${listingDesiredStates.updatedBy} = 'COMMERCE_HUB_UI' and ${listingDesiredStates.updatedAt} > now() - interval '15 minutes'`,
    legacyPublicationPending: sql<boolean>`coalesce((select
      ((e.old_value in ('END','ACTIVATE','STOCK_UPDATE_AND_ACTIVATE') and e.new_value='PENDING') or e.new_value='REACTIVATION_IN_PROGRESS')
      from allegro_change_events e where e.listing_id=${platformListings.id} and e.event_type='SYNC' and e.source='INVENTORY_AUTOMATION'
      order by e.occurred_at desc,e.id desc limit 1),false)`,
    duplicateCount: sql<number>`(select count(*)::int from platform_listings x where x.product_id=${platformListings.productId}
      and x.account_id=${platformListings.accountId} and x.marketplace=${platformListings.marketplace})`,
    campaignBlocked: sql<boolean>`exists(select 1 from listing_campaigns c where c.listing_id=${platformListings.id}
      and coalesce(c.campaign_status,'') not in ('FINISHED','DECLINED') and coalesce(c.application_status,'') <> 'DECLINED'
      and not (c.external_application_id is null and coalesce(c.application_status,'') in ('PREPARED','SCHEDULED') and coalesce(c.campaign_status,'')='PREPARED'))`,
  }).from(platformListings)
    .innerJoin(listingDesiredStates, eq(listingDesiredStates.listingId, platformListings.id))
    .leftJoin(listingRemoteStates, eq(listingRemoteStates.listingId, platformListings.id))
    .innerJoin(products, eq(products.id, platformListings.productId))
    .innerJoin(platforms, eq(platforms.id, platformListings.platformId))
    .innerJoin(platformAccounts, eq(platformAccounts.id, platformListings.accountId))
    .where(and(eq(platformListings.id, listingId), eq(platformListings.accountId, accountId), eq(platformListings.marketplace, 'allegro-hu'),
      eq(platforms.code, 'ALLEGRO'), eq(platformAccounts.active, true), eq(platformAccounts.environment, environment))).limit(1)
  return row ?? null
}

export async function recordPublicationAudit(database: Database, target: PublicationTarget, event: PublicationAudit) {
  await database.insert(allegroChangeEvents).values({
    listingId: target.listingId, eventType: event.commandId ? 'PUBLICATION_OPERATION' : 'PUBLICATION_CHECK',
    source: 'COMMERCE_HUB_PUBLICATION', oldValue: event.action, newValue: event.status,
    metadataJson: JSON.stringify({ ...event, offerId: target.offerId, accountId: target.accountId }), occurredAt: sql`now()`,
  })
}

export async function latestPublicationCommand(database: Database, target: PublicationTarget): Promise<PublicationCommand | null> {
  const [row] = await database.select({ action: allegroChangeEvents.oldValue, status: allegroChangeEvents.newValue, metadata: allegroChangeEvents.metadataJson })
    .from(allegroChangeEvents).where(and(eq(allegroChangeEvents.listingId, target.listingId), eq(allegroChangeEvents.eventType, 'PUBLICATION_OPERATION'),
      sql`${allegroChangeEvents.metadataJson}::jsonb->>'offerId' = ${target.offerId}`))
    .orderBy(desc(allegroChangeEvents.occurredAt), desc(allegroChangeEvents.id)).limit(1)
  if (!row) return null
  const metadata = JSON.parse(row.metadata ?? '{}') as { commandId?: string }
  if (!metadata.commandId || !['END', 'ACTIVATE'].includes(row.action ?? '')) throw new Error('PUBLICATION_JOURNAL_INVALID')
  return { commandId: metadata.commandId, action: row.action as 'END' | 'ACTIVATE', status: row.status ?? 'PENDING' }
}

/** Partial observation: deliberately does not advance full stock/price lastSyncedAt. */
export async function persistPublicationObservation(database: Database, target: PublicationTarget, observation: PublicationObservation) {
  if (!['ACTIVE', 'ACTIVATING', 'INACTIVE', 'ENDED'].includes(observation.status)) throw new Error('UNEXPECTED_PUBLICATION_STATE')
  const result = await database.execute(sql`
    with previous as (
      select r.listing_id, r.publication_status, d.desired_publication_status
      from listing_remote_states r join platform_listings p on p.id=r.listing_id
      join listing_desired_states d on d.listing_id=p.id
      where p.id=${target.listingId}::uuid and p.external_listing_id=${target.offerId} and p.account_id=${target.accountId}::uuid
      for update of r
    ), changed as (
      update listing_remote_states r set publication_status=${observation.status}, updated_at=${observation.observedAt}
      from previous where r.listing_id=previous.listing_id returning r.listing_id
    ), audit as (
      insert into allegro_change_events(listing_id,event_type,source,old_value,new_value,metadata_json,occurred_at)
      select changed.listing_id,'PUBLICATION_CHECK','ALLEGRO_PUBLICATION_OBSERVATION','END','EXTERNAL_REACTIVATION',
        ${JSON.stringify({ offerId: target.offerId, publicationStatus: observation.status, observedAt: observation.observedAt.toISOString() })},now()
      from changed join previous on previous.listing_id=changed.listing_id
      where previous.desired_publication_status='INACTIVE' and previous.publication_status in ('ENDED','INACTIVE') and ${observation.status}='ACTIVE'
      returning id
    ) select listing_id from changed`)
  if (result.rows.length !== 1) throw new Error('MAPPING_OR_SCOPE_CHANGED')
}

/** Existing intent-save semantics plus an atomic audit event; no lock or quantity writes. */
export async function savePublicationIntent(database: Database, listingId: string, desiredStatus: 'ACTIVE' | 'INACTIVE') {
  const result = await database.execute(sql`
    with previous as (select listing_id,desired_publication_status from listing_desired_states
      where listing_id=${listingId}::uuid for update),
    changed as (update listing_desired_states d
      set desired_publication_status=${desiredStatus},stock_auto_paused=false,updated_by='COMMERCE_HUB_UI',updated_at=now()
      from previous where d.listing_id=previous.listing_id
      returning d.listing_id,d.desired_publication_status,d.updated_by,d.updated_at,previous.desired_publication_status as old_status),
    audit as (insert into allegro_change_events(listing_id,event_type,source,old_value,new_value,metadata_json,occurred_at)
      select listing_id,'PUBLICATION_INTENT','COMMERCE_HUB_UI',old_status::text,desired_publication_status::text,
        '{"action":"PUBLICATION_INTENT_SAVED"}',updated_at from changed returning id)
    select listing_id as "listingId",desired_publication_status as "desiredPublicationStatus",updated_by as "updatedBy",updated_at as "updatedAt" from changed`)
  return result.rows[0] ?? null
}
