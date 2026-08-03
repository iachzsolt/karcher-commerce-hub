import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const productLineEnum = pgEnum('product_line', [
  'HG',
  'PROFESSIONAL',
  'UNASSIGNED',
])

export const listingStatusEnum = pgEnum('listing_status', [
  'ACTIVE',
  'INACTIVE',
  'ENDED',
  'UNKNOWN',
])

export const productIdentifierTypeEnum = pgEnum(
  'product_identifier_type',
  [
    'EAN',
    'MANUFACTURER_SKU',
    'SAP_ID',
    'OTHER',
  ],
)

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    sku: text('sku').notNull(),
    name: text('name').notNull(),

    productLine: productLineEnum('product_line')
      .notNull()
      .default('UNASSIGNED'),

    category: text('category'),

    active: boolean('active')
      .notNull()
      .default(true),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('products_sku_unique').on(table.sku),
  ],
)

export const productIdentifiers = pgTable(
  'product_identifiers',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),

    type: productIdentifierTypeEnum('type').notNull(),

    value: text('value').notNull(),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('product_identifier_unique').on(
      table.type,
      table.value,
    ),

    index('product_identifiers_product_index').on(
      table.productId,
    ),
  ],
)

export const platforms = pgTable(
  'platforms',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    code: text('code').notNull(),
    name: text('name').notNull(),

    active: boolean('active')
      .notNull()
      .default(true),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('platforms_code_unique').on(table.code),
  ],
)

export const platformListings = pgTable(
  'platform_listings',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),

    platformId: uuid('platform_id')
      .notNull()
      .references(() => platforms.id),

    externalListingId: text('external_listing_id').notNull(),
    externalProductId: text('external_product_id'),

    marketplace: text('marketplace'),

    status: listingStatusEnum('status')
      .notNull()
      .default('UNKNOWN'),

    currentPriceMinor: integer('current_price_minor'),
    currentStock: integer('current_stock'),

    currency: text('currency')
      .notNull()
      .default('HUF'),

    listingUrl: text('listing_url'),

    lastSyncedAt: timestamp('last_synced_at', {
      withTimezone: true,
    }),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('platform_listing_unique').on(
      table.platformId,
      table.externalListingId,
    ),

    index('platform_listings_product_index').on(
      table.productId,
    ),
  ],
)