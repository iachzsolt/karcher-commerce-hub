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
  'ACTIVATING',
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

export const campaignTypeEnum = pgEnum('campaign_type', [
  'STANDARD',
  'DISCOUNT',
  'SOURCING',
  'OTHER',
])

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

export const platformAccounts = pgTable(
  'platform_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    platformId: uuid('platform_id')
      .notNull()
      .references(() => platforms.id),

    code: text('code').notNull(),
    name: text('name').notNull(),

    externalAccountId: text('external_account_id'),

    marketplace: text('marketplace'),

    environment: text('environment')
      .notNull()
      .default('SANDBOX'),

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
    uniqueIndex('platform_account_unique').on(
      table.platformId,
      table.code,
    ),
  ],
)

export const platformAccountCredentials = pgTable(
  'platform_account_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    accountId: uuid('account_id')
      .notNull()
      .references(() => platformAccounts.id),

    accessTokenEncrypted: text(
      'access_token_encrypted',
    ).notNull(),

    refreshTokenEncrypted: text(
      'refresh_token_encrypted',
    ).notNull(),

    accessTokenExpiresAt: timestamp(
      'access_token_expires_at',
      {
        withTimezone: true,
      },
    ).notNull(),

    tokenType: text('token_type'),
    scope: text('scope'),

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
    uniqueIndex(
      'platform_account_credentials_account_unique',
    ).on(table.accountId),
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

    accountId: uuid('account_id')
      .notNull()
      .references(() => platformAccounts.id),

    externalListingId: text('external_listing_id').notNull(),

    externalProductId: text('external_product_id'),

    externalReference: text('external_reference'),

    marketplace: text('marketplace'),

    categoryId: text('category_id'),

    listingName: text('listing_name'),

    listingUrl: text('listing_url'),

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
      table.accountId,
      table.externalListingId,
    ),

    index('platform_listings_product_index').on(
      table.productId,
    ),
  ],
)

export const listingRemoteStates = pgTable(
  'listing_remote_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),


    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    priceMinor: integer('price_minor'),

    currency: text('currency')
      .notNull()
      .default('HUF'),

    stockAvailable: integer('stock_available'),

    stockSold: integer('stock_sold'),

    publicationStatus: listingStatusEnum('publication_status')
      .notNull()
      .default('UNKNOWN'),

    publicationStartingAt: timestamp('publication_starting_at', {
      withTimezone: true,
    }),

    publicationEndingAt: timestamp('publication_ending_at', {
      withTimezone: true,
    }),

    priceAutomationRuleId: text('price_automation_rule_id'),

    priceAutomationRuleType: text('price_automation_rule_type'),

    isFulfillment: boolean('is_fulfillment')
      .notNull()
      .default(false),

    sourceUpdatedAt: timestamp('source_updated_at', {
      withTimezone: true,
    }),

    lastSyncedAt: timestamp('last_synced_at', {
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
    uniqueIndex('listing_remote_state_unique').on(
      table.listingId,
    ),
  ],
)

export const listingPriceHistory = pgTable(
  'listing_price_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    priceMinor: integer('price_minor')
      .notNull(),

    basePriceMinor: integer('base_price_minor'),

    priceType: text('price_type')
      .notNull()
      .default('REGULAR'),

    externalCampaignId: text(
      'external_campaign_id',
    ),

    currency: text('currency')
      .notNull()
      .default('HUF'),

    source: text('source')
      .notNull()
      .default('ALLEGRO_SYNC'),

    observedAt: timestamp('observed_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index(
      'listing_price_history_listing_observed_index',
    ).on(
      table.listingId,
      table.observedAt,
    ),
  ],
)
export const listingDesiredStates = pgTable(
  'listing_desired_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),


    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    listPriceMinor: integer('list_price_minor'),

    regularPriceMinor: integer('regular_price_minor'),

    desiredStock: integer('desired_stock'),

    desiredPublicationStatus:
      listingStatusEnum('desired_publication_status')
        .notNull()
        .default('UNKNOWN'),

    priceLocked: boolean('price_locked')
      .notNull()
      .default(false),

    stockLocked: boolean('stock_locked')
      .notNull()
      .default(false),

    autoPriceSync: boolean('auto_price_sync')
      .notNull()
      .default(false),

    autoStockSync: boolean('auto_stock_sync')
      .notNull()
      .default(false),

    updatedBy: text('updated_by'),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('listing_desired_state_unique').on(
      table.listingId,
    ),
  ],
)

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    externalCampaignId: text('external_campaign_id'),

    name: text('name').notNull(),

    campaignType: campaignTypeEnum('campaign_type')
      .notNull()
      .default('OTHER'),

    marketplace: text('marketplace'),

    status: text('status')
      .notNull()
      .default('DRAFT'),

    validFrom: timestamp('valid_from', {
      withTimezone: true,
    }),

    validTo: timestamp('valid_to', {
      withTimezone: true,
    }),

    autoSync: boolean('auto_sync')
      .notNull()
      .default(false),

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
    index('campaigns_marketplace_index').on(
      table.marketplace,
    ),

    index('campaigns_status_index').on(
      table.status,
    ),
  ],
)
export const listingCampaigns = pgTable(
  'listing_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    campaignId: uuid('campaign_id')
      .references(() => campaigns.id),

    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    externalCampaignId: text('external_campaign_id').notNull(),

    campaignName: text('campaign_name'),

    campaignType: campaignTypeEnum('campaign_type')
      .notNull()
      .default('OTHER'),

    marketplace: text('marketplace'),

    desiredPriceMinor: integer('desired_price_minor'),

    remotePriceMinor: integer('remote_price_minor'),

    referencePriceMinor: integer('reference_price_minor'),

    dedicatedStock: integer('dedicated_stock'),

    priceLocked: boolean('price_locked')
      .notNull()
      .default(false),

    autoSync: boolean('auto_sync')
      .notNull()
      .default(false),

    applicationStatus: text('application_status'),

    externalApplicationId: text(
      'external_application_id',
    ),

    applicationError: text(
      'application_error',
    ),

    finishOperationId: text(
      'finish_operation_id',
    ),

    finishError: text(
      'finish_error',
    ),

    finishRetryAfter: timestamp(
      'finish_retry_after',
      {
        withTimezone: true,
      },
    ),

    finishRetryCount: integer(
      'finish_retry_count',
    )
      .notNull()
      .default(0),

    retryAfter: timestamp('retry_after', {
      withTimezone: true,
    }),

    retryCount: integer('retry_count')
      .notNull()
      .default(0),

    campaignStatus: text('campaign_status'),

    validFrom: timestamp('valid_from', {
      withTimezone: true,
    }),

    validTo: timestamp('valid_to', {
      withTimezone: true,
    }),

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
    uniqueIndex('listing_campaign_unique').on(
      table.listingId,
      table.externalCampaignId,
    ),

    index('listing_campaigns_listing_index').on(
      table.listingId,
    ),
  ],
)