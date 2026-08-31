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

export const feedInclusionModeEnum = pgEnum(
  'feed_inclusion_mode',
  [
    'INHERIT',
    'FORCE_INCLUDE',
    'FORCE_EXCLUDE',
  ],
)

export const feedDecisionEnum = pgEnum('feed_decision', [
  'INCLUDED',
  'REVIEW',
  'EXCLUDED',
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

export const platformInventorySyncSettings = pgTable(
  'platform_inventory_sync_settings',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    accountId: uuid('account_id')
      .notNull()
      .references(() => platformAccounts.id),

    enabled: boolean('enabled')
      .notNull()
      .default(false),

    triggerMode: text('trigger_mode')
      .notNull()
      .default('INVENTORY_REFRESH'),

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
      'platform_inventory_sync_settings_account_unique',
    ).on(table.accountId),
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

export const allegroChangeEvents = pgTable(
  'allegro_change_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    eventType: text('event_type').notNull(),

    source: text('source')
      .notNull()
      .default('ALLEGRO_SYNC'),

    oldValue: text('old_value'),

    newValue: text('new_value'),

    currency: text('currency'),

    externalCampaignId: text('external_campaign_id'),

    metadataJson: text('metadata_json'),

    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('allegro_change_events_occurred_index').on(
      table.occurredAt,
    ),

    index('allegro_change_events_listing_index').on(
      table.listingId,
    ),

    index('allegro_change_events_type_index').on(
      table.eventType,
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

    stockAutoPaused: boolean('stock_auto_paused')
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

export const listingAcceptedStates = pgTable(
  'listing_accepted_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    acceptedPriceMinor: integer(
      'accepted_price_minor',
    ),

    acceptedStockAvailable: integer(
      'accepted_stock_available',
    ),

    acceptedPublicationStatus:
      listingStatusEnum(
        'accepted_publication_status',
      )
        .notNull()
        .default('UNKNOWN'),

    acceptedAt: timestamp('accepted_at', {
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
      'listing_accepted_state_unique',
    ).on(table.listingId),
  ],
)
export const listingPriceSchedules = pgTable(
  'listing_price_schedules',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    listingId: uuid('listing_id')
      .notNull()
      .references(() => platformListings.id),

    promotionalPriceMinor: integer(
      'promotional_price_minor',
    ).notNull(),

    validFrom: timestamp('valid_from', {
      withTimezone: true,
    }).notNull(),

    validTo: timestamp('valid_to', {
      withTimezone: true,
    }).notNull(),

    enabled: boolean('enabled')
      .notNull()
      .default(true),

    startAppliedAt: timestamp('start_applied_at', {
      withTimezone: true,
    }),

    endAppliedAt: timestamp('end_applied_at', {
      withTimezone: true,
    }),

    lastError: text('last_error'),

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
    index(
      'listing_price_schedules_listing_index',
    ).on(table.listingId),

    index(
      'listing_price_schedules_period_index',
    ).on(
      table.validFrom,
      table.validTo,
    ),

    index(
      'listing_price_schedules_enabled_index',
    ).on(table.enabled),
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

/* ============================================================
   COMMERCE HUB DATA CONNECTIONS
   ============================================================ */

export const dataConnections = pgTable(
  'data_connections',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    name: text('name')
      .notNull(),

    sourceType: text('source_type')
      .notNull(),

    purpose: text('purpose')
      .notNull()
      .default('INVENTORY'),

    isActive: boolean('is_active')
      .notNull()
      .default(false),

    status: text('status')
      .notNull()
      .default('NOT_CONFIGURED'),

    lastSuccessfulAt: timestamp(
      'last_successful_at',
      {
        withTimezone: true,
      },
    ),

    lastError: text('last_error'),

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
    index(
      'data_connections_purpose_index',
    ).on(table.purpose),

    index(
      'data_connections_source_type_index',
    ).on(table.sourceType),

    index(
      'data_connections_active_index',
    ).on(table.isActive),
  ],
)


export const inventoryConnectionConfigs = pgTable(
  'inventory_connection_configs',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    spreadsheetId: text('spreadsheet_id')
      .notNull(),

    spreadsheetUrl: text('spreadsheet_url'),

    sheetName: text('sheet_name')
      .notNull(),

    headerRow: integer('header_row')
      .notNull()
      .default(1),

    skuSourceField: text('sku_source_field')
      .notNull(),

    stockSourceField: text('stock_source_field')
      .notNull(),

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
      'inventory_connection_config_unique',
    ).on(table.connectionId),
  ],
)


export const inventoryImportRuns = pgTable(
  'inventory_import_runs',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    status: text('status')
      .notNull()
      .default('RUNNING'),

    rowsRead: integer('rows_read')
      .notNull()
      .default(0),

    rowsImported: integer('rows_imported')
      .notNull()
      .default(0),

    rowsNormalizedToZero: integer(
      'rows_normalized_to_zero',
    )
      .notNull()
      .default(0),

    duplicateSkuCount: integer(
      'duplicate_sku_count',
    )
      .notNull()
      .default(0),

    changedItemCount: integer(
      'changed_item_count',
    )
      .notNull()
      .default(0),

    sourceFingerprint: text(
      'source_fingerprint',
    ),

    error: text('error'),

    startedAt: timestamp('started_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp('finished_at', {
      withTimezone: true,
    }),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index(
      'inventory_import_runs_connection_index',
    ).on(table.connectionId),

    index(
      'inventory_import_runs_started_index',
    ).on(table.startedAt),
  ],
)


export const inventorySourceItems = pgTable(
  'inventory_source_items',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    sku: text('sku')
      .notNull(),

    stock: integer('stock')
      .notNull()
      .default(0),

    sourceStockValue: text(
      'source_stock_value',
    ),

    normalizedToZero: boolean(
      'normalized_to_zero',
    )
      .notNull()
      .default(false),

    lastImportRunId: uuid(
      'last_import_run_id',
    )
      .references(() => inventoryImportRuns.id),

    observedAt: timestamp('observed_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

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
      'inventory_source_item_unique',
    ).on(
      table.connectionId,
      table.sku,
    ),

    index(
      'inventory_source_items_sku_index',
    ).on(table.sku),

    index(
      'inventory_source_items_connection_index',
    ).on(table.connectionId),
  ],
)

/* ============================================================
   DATA CONNECTION RUNS
   End-to-end adatkapcsolati futások naplója
   ============================================================ */

export const dataConnectionRuns = pgTable(
  'data_connection_runs',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    triggerType: text('trigger_type')
      .notNull()
      .default('SCHEDULED'),

    status: text('status')
      .notNull()
      .default('RUNNING'),

    importStatus: text('import_status'),

    rowsImported: integer('rows_imported')
      .notNull()
      .default(0),

    changedItemCount: integer(
      'changed_item_count',
    )
      .notNull()
      .default(0),


    error: text('error'),

    startedAt: timestamp('started_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp('finished_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    index(
      'data_connection_runs_connection_started_index',
    ).on(
      table.connectionId,
      table.startedAt,
    ),

    index(
      'data_connection_runs_status_index',
    ).on(table.status),
  ],
)


/* ============================================================
   DATA CONNECTION SCHEDULES
   ============================================================ */

export const dataConnectionSchedules = pgTable(
  'data_connection_schedules',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    enabled: boolean('enabled')
      .notNull()
      .default(false),

    mode: text('mode')
      .notNull()
      .default('DAILY_TIMES'),

    intervalMinutes: integer(
      'interval_minutes',
    ),

    dailyTimesJson: text(
      'daily_times_json',
    )
      .notNull()
      .default('[]'),

    timeZone: text('time_zone')
      .notNull()
      .default('Europe/Budapest'),

    weekdaysOnly: boolean(
      'weekdays_only',
    )
      .notNull()
      .default(true),

    lastRunAt: timestamp(
      'last_run_at',
      {
        withTimezone: true,
      },
    ),

    nextRunAt: timestamp(
      'next_run_at',
      {
        withTimezone: true,
      },
    ),

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
      'data_connection_schedule_unique',
    ).on(table.connectionId),

    index(
      'data_connection_schedule_enabled_index',
    ).on(table.enabled),

    index(
      'data_connection_schedule_next_run_index',
    ).on(table.nextRunAt),
  ],
)

/* ============================================================
   SCHEDULER LEASES
   Cross-runtime lock for at-least-once cron delivery
   ============================================================ */

export const schedulerLeases = pgTable(
  'scheduler_leases',
  {
    name: text('name')
      .primaryKey(),

    ownerId: uuid('owner_id')
      .notNull(),

    lockedUntil: timestamp('locked_until', {
      withTimezone: true,
    }).notNull(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('scheduler_leases_locked_until_index').on(
      table.lockedUntil,
    ),
  ],
)

/* ============================================================
   CATALOG SYNC RUNS
   Persisted results of automatic and manual Allegro catalog
   sync runs (new-offer import), visible in the web UI
   ============================================================ */

export const catalogSyncRuns = pgTable(
  'catalog_sync_runs',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    trigger: text('trigger')
      .notNull()
      .default('AUTOMATIC'),

    status: text('status')
      .notNull(),

    totalOffers: integer('total_offers')
      .notNull()
      .default(0),

    newOffers: integer('new_offers')
      .notNull()
      .default(0),

    renamedOffers: integer('renamed_offers')
      .notNull()
      .default(0),

    offersWithoutSku: integer('offers_without_sku')
      .notNull()
      .default(0),

    syncedOffers: integer('synced_offers')
      .notNull()
      .default(0),

    initializedBaselines: integer('initialized_baselines')
      .notNull()
      .default(0),

    error: text('error'),

    startedAt: timestamp('started_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp('finished_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    index('catalog_sync_runs_started_at_index').on(
      table.startedAt,
    ),
  ],
)

/* ============================================================
   FEED CHANNEL SOURCE PROJECTIONS
   Current catalog and pricing source state for feed channels
   ============================================================ */

export const catalogSourceItems = pgTable(
  'catalog_source_items',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    productId: uuid('product_id')
      .references(() => products.id),

    sourceItemKey: text('source_item_key')
      .notNull(),

    identifier: text('identifier'),
    eanCode: text('ean_code'),
    manufacturer: text('manufacturer'),
    name: text('name'),
    description: text('description'),
    category: text('category'),
    productUrl: text('product_url'),
    imageUrl: text('image_url'),
    imageUrl2: text('image_url_2'),

    additionalImageUrlsJson: text(
      'additional_image_urls_json',
    )
      .notNull()
      .default('[]'),

    sourceFingerprint: text(
      'source_fingerprint',
    ),

    rawDataJson: text('raw_data_json'),

    matchStatus: text('match_status')
      .notNull()
      .default('UNMATCHED'),

    matchError: text('match_error'),

    observedAt: timestamp('observed_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

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
      'catalog_source_items_connection_key_unique',
    ).on(
      table.connectionId,
      table.sourceItemKey,
    ),

    index(
      'catalog_source_items_connection_index',
    ).on(table.connectionId),

    index(
      'catalog_source_items_product_index',
    ).on(table.productId),

    index(
      'catalog_source_items_identifier_index',
    ).on(table.identifier),

    index(
      'catalog_source_items_ean_index',
    ).on(table.eanCode),
  ],
)

export const pricingSourceItems = pgTable(
  'pricing_source_items',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    productId: uuid('product_id')
      .references(() => products.id),

    sourceItemKey: text('source_item_key')
      .notNull(),

    identifier: text('identifier'),

    marketCode: text('market_code')
      .notNull(),

    currency: text('currency')
      .notNull(),

    ownPriceMinor: integer('own_price_minor'),
    effectivePriceMinor: integer(
      'effective_price_minor',
    ),

    marketMinimumPriceMinor: integer(
      'market_minimum_price_minor',
    ),

    marketAveragePriceMinor: integer(
      'market_average_price_minor',
    ),

    marketMedianPriceMinor: integer(
      'market_median_price_minor',
    ),

    priceDifferenceBps: integer(
      'price_difference_bps',
    ),

    priceIndexBps: integer('price_index_bps'),
    medianIndexBps: integer('median_index_bps'),
    averageIndexBps: integer('average_index_bps'),

    pricePosition: integer('price_position'),
    offerCount: integer('offer_count'),

    dealerMinimumPriceMinor: integer(
      'dealer_minimum_price_minor',
    ),

    dealerMedianPriceMinor: integer(
      'dealer_median_price_minor',
    ),

    dealerIndexBps: integer('dealer_index_bps'),

    retailMinimumPriceMinor: integer(
      'retail_minimum_price_minor',
    ),

    retailMedianPriceMinor: integer(
      'retail_median_price_minor',
    ),

    retailIndexBps: integer('retail_index_bps'),

    promotionActive: boolean('promotion_active'),
    promotionName: text('promotion_name'),
    promotionPriceMinor: integer(
      'promotion_price_minor',
    ),

    promotionStartsAt: timestamp(
      'promotion_starts_at',
      {
        withTimezone: true,
      },
    ),

    promotionEndsAt: timestamp(
      'promotion_ends_at',
      {
        withTimezone: true,
      },
    ),

    promotionJson: text('promotion_json'),

    dataStatus: text('data_status')
      .notNull()
      .default('UNKNOWN'),

    sourceFingerprint: text(
      'source_fingerprint',
    ),

    rawDataJson: text('raw_data_json'),

    observedAt: timestamp('observed_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

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
      'pricing_source_items_scope_unique',
    ).on(
      table.connectionId,
      table.sourceItemKey,
      table.marketCode,
      table.currency,
    ),

    index(
      'pricing_source_items_connection_index',
    ).on(table.connectionId),

    index(
      'pricing_source_items_product_index',
    ).on(table.productId),

    index(
      'pricing_source_items_identifier_index',
    ).on(table.identifier),
  ],
)

/* ============================================================
   GENERIC FEED CHANNELS
   Feed-based destinations such as Arukereso, Google or Meta
   ============================================================ */

export const feedChannels = pgTable(
  'feed_channels',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    platformId: uuid('platform_id')
      .notNull()
      .references(() => platforms.id),

    code: text('code')
      .notNull(),

    name: text('name')
      .notNull(),

    targetCountry: text('target_country')
      .notNull(),

    contentLanguage: text('content_language')
      .notNull(),

    currency: text('currency')
      .notNull(),

    format: text('format')
      .notNull(),

    deliveryMode: text('delivery_mode'),
    externalChannelId: text('external_channel_id'),

    isActive: boolean('is_active')
      .notNull()
      .default(false),

    status: text('status')
      .notNull()
      .default('NOT_CONFIGURED'),

    settingsJson: text('settings_json')
      .notNull()
      .default('{}'),

    lastSuccessfulAt: timestamp(
      'last_successful_at',
      {
        withTimezone: true,
      },
    ),

    lastError: text('last_error'),

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
      'feed_channels_platform_code_unique',
    ).on(
      table.platformId,
      table.code,
    ),

    index('feed_channels_platform_index').on(
      table.platformId,
    ),

    index('feed_channels_active_index').on(
      table.isActive,
    ),
  ],
)

export const feedChannelSources = pgTable(
  'feed_channel_sources',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    channelId: uuid('channel_id')
      .notNull()
      .references(() => feedChannels.id),

    connectionId: uuid('connection_id')
      .notNull()
      .references(() => dataConnections.id),

    role: text('role')
      .notNull(),

    priority: integer('priority')
      .notNull()
      .default(0),

    isActive: boolean('is_active')
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
    uniqueIndex('feed_channel_source_unique').on(
      table.channelId,
      table.connectionId,
      table.role,
    ),

    index(
      'feed_channel_sources_channel_role_index',
    ).on(
      table.channelId,
      table.role,
      table.priority,
    ),

    index(
      'feed_channel_sources_connection_index',
    ).on(table.connectionId),
  ],
)

export const feedProductOverrides = pgTable(
  'feed_product_overrides',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    channelId: uuid('channel_id')
      .notNull()
      .references(() => feedChannels.id),

    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),

    inclusionMode: feedInclusionModeEnum(
      'inclusion_mode',
    )
      .notNull()
      .default('INHERIT'),

    externalItemId: text('external_item_id'),

    priceOverrideMinor: integer(
      'price_override_minor',
    ),

    netPriceOverrideMinor: integer(
      'net_price_override_minor',
    ),

    deliveryCostOverrideMinor: integer(
      'delivery_cost_override_minor',
    ),

    deliveryTimeOverrideDays: integer(
      'delivery_time_override_days',
    ),

    attributesJson: text('attributes_json'),
    reason: text('reason'),
    updatedBy: text('updated_by'),

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
    uniqueIndex('feed_product_override_unique').on(
      table.channelId,
      table.productId,
    ),

    uniqueIndex(
      'feed_product_override_external_unique',
    ).on(
      table.channelId,
      table.externalItemId,
    ),

    index(
      'feed_product_overrides_product_index',
    ).on(table.productId),
  ],
)

/* ============================================================
   FEED GENERATION RUN SNAPSHOTS
   Immutable run and per-product decision history
   ============================================================ */

export const feedRuns = pgTable(
  'feed_runs',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    channelId: uuid('channel_id')
      .notNull()
      .references(() => feedChannels.id),

    triggerType: text('trigger_type')
      .notNull(),

    status: text('status')
      .notNull()
      .default('RUNNING'),

    generatorVersion: text('generator_version'),
    ruleVersion: text('rule_version'),

    itemsEvaluated: integer('items_evaluated')
      .notNull()
      .default(0),

    itemsIncluded: integer('items_included')
      .notNull()
      .default(0),

    itemsReview: integer('items_review')
      .notNull()
      .default(0),

    itemsExcluded: integer('items_excluded')
      .notNull()
      .default(0),

    itemsFailed: integer('items_failed')
      .notNull()
      .default(0),

    inputFingerprint: text('input_fingerprint'),
    outputFingerprint: text('output_fingerprint'),

    channelSnapshotJson: text(
      'channel_snapshot_json',
    )
      .notNull(),

    sourceSnapshotJson: text(
      'source_snapshot_json',
    )
      .notNull(),

    ruleSnapshotJson: text('rule_snapshot_json')
      .notNull(),

    artifactFileName: text('artifact_file_name'),
    artifactContentType: text('artifact_content_type'),
    artifactFingerprint: text('artifact_fingerprint'),

    error: text('error'),

    startedAt: timestamp('started_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp('finished_at', {
      withTimezone: true,
    }),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('feed_runs_channel_started_index').on(
      table.channelId,
      table.startedAt,
    ),

    index('feed_runs_status_index').on(
      table.status,
    ),
  ],
)

export const feedRunItems = pgTable(
  'feed_run_items',
  {
    id: uuid('id')
      .defaultRandom()
      .primaryKey(),

    runId: uuid('run_id')
      .notNull()
      .references(() => feedRuns.id),

    productId: uuid('product_id')
      .references(() => products.id),

    itemIndex: integer('item_index'),
    externalItemId: text('external_item_id'),

    sku: text('sku')
      .notNull(),

    identifier: text('identifier'),
    eanCode: text('ean_code'),
    name: text('name'),

    decision: feedDecisionEnum('decision')
      .notNull(),

    reasonCodesJson: text('reason_codes_json')
      .notNull(),

    stock: integer('stock'),
    priceMinor: integer('price_minor'),
    netPriceMinor: integer('net_price_minor'),
    deliveryCostMinor: integer('delivery_cost_minor'),
    deliveryTimeDays: integer('delivery_time_days'),
    currency: text('currency'),

    manualOverrideApplied: boolean(
      'manual_override_applied',
    )
      .notNull()
      .default(false),

    inputSnapshotJson: text('input_snapshot_json')
      .notNull(),

    overrideSnapshotJson: text(
      'override_snapshot_json',
    ),

    decisionDetailsJson: text(
      'decision_details_json',
    )
      .notNull(),

    resolvedItemJson: text('resolved_item_json'),
    payloadFingerprint: text('payload_fingerprint'),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('feed_run_item_unique').on(
      table.runId,
      table.productId,
    ),

    uniqueIndex('feed_run_item_external_unique').on(
      table.runId,
      table.externalItemId,
    ),

    index('feed_run_items_product_index').on(
      table.productId,
    ),

    index('feed_run_items_run_decision_index').on(
      table.runId,
      table.decision,
    ),
  ],
)
