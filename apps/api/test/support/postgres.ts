/*
 * Reusable PostgreSQL test database for behavioral SQL tests.
 *
 * PGlite (development dependency only) runs real PostgreSQL in-process.
 * Every repository migration is applied in journal order, exactly as
 * written for Neon, so triggers, constraints, CTEs and CAS statements are
 * exercised with real semantics. No network, no production data.
 *
 * Limitations (see docs/ALLEGRO_PUBLICATION_OPERATIONS.md):
 * - single connection: concurrent statements are serialized, so races are
 *   tested as interleavings, not true parallel sessions;
 * - PGlite's PostgreSQL major version may differ from Neon's;
 * - no Neon HTTP driver: queries run through drizzle's PGlite driver.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { createDatabase } from '@karcher-commerce-hub/database'

export type Database = ReturnType<typeof createDatabase>

const migrationsDirectory = new URL('../../../../packages/database/drizzle/', import.meta.url)

function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationsDirectory), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map(entry => entry.tag)
}

async function applyMigrations(pg: PGlite, tags: string[]) {
  for (const tag of tags) {
    const text = readFileSync(new URL(`${tag}.sql`, migrationsDirectory), 'utf8')
    await pg.exec(text.split('--> statement-breakpoint').join('\n'))
  }
}

export type TestDatabase = {
  pg: PGlite
  db: Database
  /** Apply the remaining migrations (when created with `stopBefore`). */
  migrateRest: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Create a migrated database. With `stopBefore`, migrations from that tag
 * on are held back so legacy rows can be written before they apply.
 */
export async function createTestDatabase(options: { stopBefore?: string } = {}): Promise<TestDatabase> {
  const pg = new PGlite()
  const tags = migrationTags()
  const cut = options.stopBefore ? tags.indexOf(options.stopBefore) : -1
  if (options.stopBefore && cut < 0) throw new Error(`Unknown migration ${options.stopBefore}`)
  await applyMigrations(pg, cut >= 0 ? tags.slice(0, cut) : tags)

  return {
    pg,
    db: drizzle({ client: pg }) as unknown as Database,
    migrateRest: async () => {
      if (cut >= 0) await applyMigrations(pg, tags.slice(cut))
    },
    close: () => pg.close(),
  }
}

export type SeededListing = {
  platformId: string
  accountId: string
  productId: string
  listingId: string
  offerId: string
  environment: string
}

/** One Allegro HU listing with desired and remote state. */
export async function seedListing(pg: PGlite, options: {
  offerId?: string
  environment?: string
  accountId?: string
  platformId?: string
  productId?: string
  sku?: string
  desiredPublicationStatus?: 'ACTIVE' | 'INACTIVE' | 'ENDED' | 'UNKNOWN'
  desiredStock?: number
  stockAutoPaused?: boolean
  stockLocked?: boolean
  autoStockSync?: boolean
  remotePublicationStatus?: 'ACTIVE' | 'INACTIVE' | 'ENDED' | 'ACTIVATING'
  remoteStock?: number
} = {}): Promise<SeededListing> {
  const environment = options.environment ?? 'PRODUCTION'
  const accountId = options.accountId ?? randomUUID()
  const productId = options.productId ?? randomUUID()
  const listingId = randomUUID()
  const offerId = options.offerId ?? String(10_000_000_000 + Math.floor(Math.random() * 1_000_000_000))

  // platforms.code is unique: reuse the single ALLEGRO platform.
  await pg.query(`insert into platforms (id, code, name) values ($1, 'ALLEGRO', 'Allegro') on conflict do nothing`, [randomUUID()])
  const platformId = options.platformId ??
    (await pg.query<{ id: string }>(`select id::text as id from platforms where code = 'ALLEGRO'`)).rows[0].id
  if (!options.accountId) {
    await pg.query(
      `insert into platform_accounts (id, platform_id, code, name, environment, active) values ($1, $2, $3, 'Test', $4, true)`,
      [accountId, platformId, `TEST_${accountId.slice(0, 8)}`, environment],
    )
  }
  if (!options.productId) {
    await pg.query(`insert into products (id, sku, name) values ($1, $2, 'Test product')`, [productId, options.sku ?? `SKU-${productId.slice(0, 8)}`])
  }
  await pg.query(
    `insert into platform_listings (id, product_id, platform_id, account_id, external_listing_id, marketplace) values ($1, $2, $3, $4, $5, 'allegro-hu')`,
    [listingId, productId, platformId, accountId, offerId],
  )
  await pg.query(
    `insert into listing_desired_states (listing_id, desired_publication_status, desired_stock, stock_auto_paused, stock_locked, auto_stock_sync)
     values ($1, $2, $3, $4, $5, $6)`,
    [listingId, options.desiredPublicationStatus ?? 'ACTIVE', options.desiredStock ?? 5, options.stockAutoPaused ?? false,
      options.stockLocked ?? false, options.autoStockSync ?? true],
  )
  await pg.query(
    `insert into listing_remote_states (listing_id, publication_status, stock_available, last_synced_at, updated_at)
     values ($1, $2, $3, now(), now())`,
    [listingId, options.remotePublicationStatus ?? 'ACTIVE', options.remoteStock ?? 5],
  )

  return { platformId, accountId, productId, listingId, offerId, environment }
}

export type DesiredRow = {
  desired_publication_status: string
  stock_auto_paused: boolean
  stock_locked: boolean
  publication_intent_source: string | null
  publication_intent_id: string | null
  publication_intent_at: Date | null
  updated_by: string | null
}

export async function readDesired(pg: PGlite, listingId: string): Promise<DesiredRow> {
  const { rows } = await pg.query<DesiredRow>(
    `select desired_publication_status, stock_auto_paused, stock_locked, publication_intent_source,
       publication_intent_id::text as publication_intent_id, publication_intent_at, updated_by
     from listing_desired_states where listing_id = $1`,
    [listingId],
  )
  return rows[0]
}

export async function setRemotePublication(pg: PGlite, listingId: string, status: string) {
  await pg.query(`update listing_remote_states set publication_status = $2, updated_at = now() where listing_id = $1`, [listingId, status])
}

export async function journal(pg: PGlite, listingId: string) {
  const { rows } = await pg.query<{ event_type: string; old_value: string | null; new_value: string | null; metadata: Record<string, unknown> }>(
    `select event_type, old_value, new_value, metadata_json::jsonb as metadata
     from allegro_change_events where listing_id = $1 order by occurred_at, id`,
    [listingId],
  )
  return rows
}
