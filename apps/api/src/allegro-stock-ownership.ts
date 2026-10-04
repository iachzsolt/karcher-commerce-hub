import { and, desc, eq, isNull, notInArray, or, sql } from 'drizzle-orm'
import { allegroChangeEvents, createDatabase, listingDesiredStates, platformListings } from '@karcher-commerce-hub/database'
import { evaluateAutoPauseOwnership } from './allegro-stock-policy.js'

type Database = ReturnType<typeof createDatabase>
export async function readStockOwnershipSnapshot(database: Database, listingId: string) {
  const [row] = await database.select({
    listingId: listingDesiredStates.listingId,
    desiredStock: listingDesiredStates.desiredStock,
    desiredPublicationStatus: listingDesiredStates.desiredPublicationStatus,
    stockAutoPaused: listingDesiredStates.stockAutoPaused,
    stockLocked: listingDesiredStates.stockLocked,
    autoStockSync: listingDesiredStates.autoStockSync,
    desiredUpdatedAt: listingDesiredStates.updatedAt,
    // Preserve exact timestamp precision and all desired fields for the CAS.
    version: sql<string>`to_jsonb(${listingDesiredStates})::text`,
    duplicateOfferCount: sql<number>`(select count(*)::int from platform_listings siblings
      where siblings.product_id=${platformListings.productId}
      and siblings.account_id=${platformListings.accountId}
      and siblings.marketplace=${platformListings.marketplace})`,
  }).from(listingDesiredStates).innerJoin(platformListings, eq(platformListings.id, listingDesiredStates.listingId))
    .where(eq(listingDesiredStates.listingId, listingId)).limit(1)
  return row ?? null
}

/** Only called after a fresh targeted GET and successful observation persistence. */
export async function reconcileStockOwnership(
  database: Database,
  snapshot: Awaited<ReturnType<typeof readStockOwnershipSnapshot>>,
  observation: { publicationStatus: string; stockAvailable: number | null; lastSyncedAt: Date },
) {
  if (!snapshot?.stockAutoPaused) return { cleared: false, reason: 'NOT_AUTOMATION_OWNED' }
  const [event] = await database.select({ id: allegroChangeEvents.id, action: allegroChangeEvents.oldValue,
    status: allegroChangeEvents.newValue, occurredAt: allegroChangeEvents.occurredAt })
    .from(allegroChangeEvents).where(and(
      eq(allegroChangeEvents.listingId, snapshot.listingId), eq(allegroChangeEvents.eventType, 'SYNC'),
      eq(allegroChangeEvents.source, 'INVENTORY_AUTOMATION'),
      // Informational ownership checks must not supersede actual transitions.
      or(isNull(allegroChangeEvents.newValue), notInArray(allegroChangeEvents.newValue, ['OWNERSHIP_RECONCILIATION_REQUIRED', 'OWNERSHIP_UNRESOLVED'])),
    )).orderBy(desc(allegroChangeEvents.occurredAt), desc(allegroChangeEvents.id)).limit(1)
  const decision = evaluateAutoPauseOwnership({ ...snapshot, publicationStatus: observation.publicationStatus,
    observedStock: observation.stockAvailable }, event ?? null, true, snapshot.desiredUpdatedAt)
  if (!decision.clear || !event) return { cleared: false, reason: decision.reason }

  // One atomic statement: recheck complete desired snapshot, latest transition,
  // fresh observation, duplicates and running scheduled inventory jobs. Audit
  // insertion and the flag-only update commit or roll back together.
  const result = await database.execute(sql`
    with cleared as (
      update listing_desired_states d set stock_auto_paused=false
      where d.listing_id=${snapshot.listingId}::uuid
        and to_jsonb(d)=${snapshot.version}::jsonb
        and d.stock_auto_paused=true and d.stock_locked=false and d.auto_stock_sync=true
        and d.desired_publication_status='ACTIVE' and d.desired_stock>0
        and exists (select 1 from allegro_change_events proof where proof.id=${event.id}::uuid
          and proof.listing_id=d.listing_id and proof.occurred_at>=d.updated_at)
        and exists (select 1 from listing_remote_states r where r.listing_id=d.listing_id
          and r.publication_status='ACTIVE' and r.stock_available=d.desired_stock
          and r.last_synced_at=${observation.lastSyncedAt})
        and (select count(*) from platform_listings siblings join platform_listings target
          on siblings.product_id=target.product_id and siblings.account_id=target.account_id
          and siblings.marketplace=target.marketplace where target.id=d.listing_id)=1
        and (select e.id from allegro_change_events e where e.listing_id=d.listing_id
          and e.event_type='SYNC' and e.source='INVENTORY_AUTOMATION'
          and (e.new_value is null or e.new_value not in ('OWNERSHIP_RECONCILIATION_REQUIRED','OWNERSHIP_UNRESOLVED'))
          order by e.occurred_at desc,e.id desc limit 1)=${event.id}::uuid
        and not exists (select 1 from data_connection_runs run join data_connections c on c.id=run.connection_id
          where c.purpose='INVENTORY' and c.is_active=true and run.status='RUNNING')
      returning d.listing_id
    )
    insert into allegro_change_events (listing_id,event_type,source,old_value,new_value,metadata_json)
      select listing_id,'OWNERSHIP','ALLEGRO_REMOTE_RECONCILIATION','true','false',
        ${JSON.stringify({ reason: decision.reason, evidenceEventId: event.id, observedAt: observation.lastSyncedAt.toISOString() })}
      from cleared returning listing_id`)
  return { cleared: result.rows.length === 1, reason: result.rows.length ? decision.reason : 'CONCURRENT_OR_RUNNING_TRANSITION' }
}
