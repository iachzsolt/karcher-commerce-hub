import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import {
  createDatabase,
  allegroChangeEvents,
  dataConnections,
  inventorySourceItems,
  campaigns,
  listingCampaigns,
  listingAcceptedStates,
  listingDesiredStates,
  listingPriceHistory,
  listingPriceSchedules,
  listingRemoteStates,
  platformAccounts,
  platformListings,
  platforms,
  productIdentifiers,
  products,
  schedulerLeases,
} from '@karcher-commerce-hub/database'
import { neon } from '@neondatabase/serverless'
import {
  and,
  count,
  desc,
  eq,
  gte,
  lt,
  lte,
  min,
  or,
} from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  dataConnectionsApi,
  processDueDataConnectionSchedules,
} from './data-connections.js'
import {
  allegroAuth,
  finishOfferAllegroCampaign,
  getAllegroBadgeApplication,
  getAllegroBadgeApplicationsForOffer,
  getAllegroBadgeCampaigns,
  getAllegroBadges,
  getAllegroBadgeOperation,
  refreshAllegroSessionIfNeeded,
  restoreAllegroSession,
  submitOfferToAllegroCampaign,
} from './allegro-auth.js'
import {
  accessAuthMiddleware,
  assertAccessConfiguration,
  type AccessVariables,
} from './access-auth.js'

export const app = new Hono<{
  Variables: AccessVariables
}>()

const localWebOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

const configuredWebOrigins = (
  process.env.COMMERCE_HUB_WEB_ORIGINS ?? ''
)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const allowedWebOrigins = [
  ...new Set([
    ...localWebOrigins,
    ...configuredWebOrigins,
  ]),
]

app.use(
  '*',
  cors({
    origin: allowedWebOrigins,
  }),
)

app.use('*', accessAuthMiddleware)

app.route('/auth/allegro', allegroAuth)
app.route('/data-connections', dataConnectionsApi)

const PRICE_SCHEDULE_PROCESS_INTERVAL_MS =
  60 * 1000

let priceScheduleProcessorInFlight = false

async function processPriceSchedulesAutomatically() {
  if (priceScheduleProcessorInFlight) {
    return
  }

  priceScheduleProcessorInFlight = true

  try {
    await refreshAllegroSessionIfNeeded()

    const response =
      await allegroAuth.request(
        '/process-price-schedules',
        {
          method: 'POST',
        },
      )

    const result =
      (await response
        .json()
        .catch(() => null)) as
        | {
            status?: string
            checked?: number
            applied?: number
            blocked?: number
            failed?: number
            skipped?: number
          }
        | null

    if (!response.ok) {
      console.warn(
        'Automatic price schedule processing failed:',
        {
          status: response.status,
          result,
        },
      )

      return
    }

    if (
      (result?.applied ?? 0) > 0 ||
      (result?.failed ?? 0) > 0 ||
      (result?.blocked ?? 0) > 0
    ) {
      console.log(
        'Automatic price schedule processing:',
        result,
      )
    }
  } catch (error) {
    console.error(
      'Automatic price schedule processor error:',
      error,
    )
  } finally {
    priceScheduleProcessorInFlight = false
  }
}

const databaseUrl = process.env.DATABASE_URL

const db = databaseUrl
  ? createDatabase(databaseUrl)
  : null

const ALLEGRO_HISTORY_RETENTION_MS =
  30 * 24 * 60 * 60 * 1000
const ALLEGRO_HISTORY_CLEANUP_INTERVAL_MS =
  24 * 60 * 60 * 1000

async function cleanupExpiredAllegroHistory() {
  if (!db) return

  await db
    .delete(allegroChangeEvents)
    .where(
      lt(
        allegroChangeEvents.occurredAt,
        new Date(
          Date.now() - ALLEGRO_HISTORY_RETENTION_MS,
        ),
      ),
    )
}

app.get('/', (context) => {
  return context.json({
    name: 'Kärcher Commerce Hub API',
    version: '0.1.0',
  })
})

app.get('/health', (context) => {
  return context.json({
    status: 'ok',
    service: 'commerce-hub-api',
    environment:
      process.env.NODE_ENV ?? 'development',
    timestamp: new Date().toISOString(),
  })
})

app.get('/database/health', async (context) => {
  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        database: 'not-configured',
      },
      500,
    )
  }

  try {
    const sql = neon(databaseUrl)

    const result = await sql`
      SELECT
        current_database() AS database_name,
        NOW() AS database_time
    `

    return context.json({
      status: 'ok',
      database: 'postgresql',
      provider: 'neon',
      databaseName: result[0].database_name,
      databaseTime: result[0].database_time,
    })
  } catch (error) {
    console.error('Database health check failed:', error)

    return context.json(
      {
        status: 'error',
        database: 'unreachable',
      },
      500,
    )
  }
})

app.get('/platforms', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const result = await db
      .select({
        id: platforms.id,
        code: platforms.code,
        name: platforms.name,
        active: platforms.active,
        createdAt: platforms.createdAt,
      })
      .from(platforms)

    return context.json({
      status: 'ok',
      count: result.length,
      data: result,
    })
  } catch (error) {
    console.error('Platform query failed:', error)

    return context.json(
      {
        status: 'error',
        message: 'Could not load platforms',
      },
      500,
    )
  }
})

app.get('/products', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const productRows = await db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        productLine: products.productLine,
        category: products.category,
        active: products.active,
        createdAt: products.createdAt,
        updatedAt: products.updatedAt,
      })
      .from(products)

    const identifierRows = await db
      .select({
        id: productIdentifiers.id,
        productId: productIdentifiers.productId,
        type: productIdentifiers.type,
        value: productIdentifiers.value,
      })
      .from(productIdentifiers)

    const result = productRows.map((product) => ({
      ...product,
      identifiers: identifierRows
        .filter((identifier) => identifier.productId === product.id)
        .map((identifier) => ({
          id: identifier.id,
          type: identifier.type,
          value: identifier.value,
        })),
    }))

    return context.json({
      status: 'ok',
      count: result.length,
      data: result,
    })
  } catch (error) {
    console.error('Product query failed:', error)

    return context.json(
      {
        status: 'error',
        message: 'Could not load products',
      },
      500,
    )
  }
})


function getBudapestHistoryBoundary(
  year: number,
  monthIndex: number,
  day: number,
) {
  const approximate = new Date(
    Date.UTC(year, monthIndex, day),
  )
  const getOffset = (date: Date) => {
    const parts = new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: 'Europe/Budapest',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      },
    ).formatToParts(date)
    const value = (type: string) =>
      Number(
        parts.find((part) => part.type === type)
          ?.value,
      )

    return (
      Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      ) - date.getTime()
    )
  }
  const firstCandidate = new Date(
    approximate.getTime() - getOffset(approximate),
  )

  return new Date(
    approximate.getTime() - getOffset(firstCandidate),
  )
}

function parseHistoryDate(value: string) {
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(
      value,
    )

  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day, date }
}

function getBudapestDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(date)
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value

  return `${value('year')}-${value('month')}-${value('day')}`
}

app.get('/allegro/history', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  const defaultTo = getBudapestDateInputValue()
  const defaultFrom = getBudapestDateInputValue(
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
  )
  const requestedFrom = context.req.query('from') ?? defaultFrom
  const requestedTo = context.req.query('to') ?? defaultTo
  const parsedFrom = parseHistoryDate(requestedFrom)
  const parsedTo = parseHistoryDate(requestedTo)

  if (!parsedFrom || !parsedTo) {
    return context.json(
      {
        status: 'error',
        message: 'from and to must use YYYY-MM-DD',
      },
      400,
    )
  }

  const rangeDays = Math.floor(
    (parsedTo.date.getTime() - parsedFrom.date.getTime()) /
      (24 * 60 * 60 * 1000),
  )

  if (rangeDays < 0 || rangeDays > 29) {
    return context.json(
      {
        status: 'error',
        message: 'History date range must be between 1 and 30 days',
      },
      400,
    )
  }

  const fromBoundary = getBudapestHistoryBoundary(
    parsedFrom.year,
    parsedFrom.month - 1,
    parsedFrom.day,
  )
  const nextDay = new Date(parsedTo.date)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const toBoundary = getBudapestHistoryBoundary(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth(),
    nextDay.getUTCDate(),
  )
  const limit = 20_000

  try {
    const rows = await db
      .select({
        id: allegroChangeEvents.id,
        eventType: allegroChangeEvents.eventType,
        source: allegroChangeEvents.source,
        oldValue: allegroChangeEvents.oldValue,
        newValue: allegroChangeEvents.newValue,
        currency: allegroChangeEvents.currency,
        externalCampaignId:
          allegroChangeEvents.externalCampaignId,
        metadataJson: allegroChangeEvents.metadataJson,
        occurredAt: allegroChangeEvents.occurredAt,
        listingId: platformListings.id,
        offerId: platformListings.externalListingId,
        sku: products.sku,
        listingName: platformListings.listingName,
      })
      .from(allegroChangeEvents)
      .innerJoin(
        platformListings,
        eq(
          platformListings.id,
          allegroChangeEvents.listingId,
        ),
      )
      .innerJoin(
        products,
        eq(products.id, platformListings.productId),
      )
      .where(
        and(
          gte(allegroChangeEvents.occurredAt, fromBoundary),
          lt(allegroChangeEvents.occurredAt, toBoundary),
        ),
      )
      .orderBy(desc(allegroChangeEvents.occurredAt))
      .limit(limit)

    return context.json({
      status: 'ok',
      period: {
        from: requestedFrom,
        to: requestedTo,
        timeZone: 'Europe/Budapest',
      },
      count: rows.length,
      truncated: rows.length === limit,
      data: rows.map((row) => ({
        ...row,
        occurredAt: row.occurredAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('Allegro history query failed:', error)

    return context.json(
      {
        status: 'error',
        message: 'Could not load Allegro history',
      },
      500,
    )
  }
})

app.get('/allegro/listings', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const result = await db
      .select({
        id: platformListings.id,

        offerId: platformListings.externalListingId,
        marketplace: platformListings.marketplace,
        categoryId: platformListings.categoryId,

        sku: products.sku,
        productName: platformListings.listingName,

        accountName: platformAccounts.name,
        environment: platformAccounts.environment,

        priceMinor: listingRemoteStates.priceMinor,
        currency: listingRemoteStates.currency,

        stockAvailable: listingRemoteStates.stockAvailable,
        stockSold: listingRemoteStates.stockSold,

        publicationStatus:
          listingRemoteStates.publicationStatus,

        lastSyncedAt:
          listingRemoteStates.lastSyncedAt,

        desiredPriceMinor:
          listingDesiredStates.regularPriceMinor,

        desiredStock:
          listingDesiredStates.desiredStock,

        desiredPublicationStatus:
          listingDesiredStates.desiredPublicationStatus,

        priceLocked:
          listingDesiredStates.priceLocked,

        stockLocked:
          listingDesiredStates.stockLocked,

        stockAutoPaused:
          listingDesiredStates.stockAutoPaused,

        autoPriceSync:
          listingDesiredStates.autoPriceSync,

        autoStockSync:
          listingDesiredStates.autoStockSync,
        acceptedPriceMinor:
          listingAcceptedStates.acceptedPriceMinor,

        acceptedStockAvailable:
          listingAcceptedStates.acceptedStockAvailable,

        acceptedPublicationStatus:
          listingAcceptedStates.acceptedPublicationStatus,

        acceptedAt:
          listingAcceptedStates.acceptedAt,
      })
      .from(platformListings)
      .innerJoin(
        products,
        eq(platformListings.productId, products.id),
      )
      .innerJoin(
        platformAccounts,
        eq(
          platformListings.accountId,
          platformAccounts.id,
        ),
      )
      .innerJoin(
        platforms,
        eq(
          platformListings.platformId,
          platforms.id,
        ),
      )
      .leftJoin(
        listingRemoteStates,
        eq(
          listingRemoteStates.listingId,
          platformListings.id,
        ),
      )
      .leftJoin(
        listingDesiredStates,
        eq(
          listingDesiredStates.listingId,
          platformListings.id,
        ),
      )
      .leftJoin(
        listingAcceptedStates,
        eq(
          listingAcceptedStates.listingId,
          platformListings.id,
        ),
      )
      .where(
        and(
          eq(platforms.code, 'ALLEGRO'),
          eq(
            platformListings.marketplace,
            'allegro-hu',
          ),
          eq(
            platformAccounts.environment,
            (process.env.ALLEGRO_ENV ?? 'SANDBOX')
              .toUpperCase(),
          ),
          eq(
            platformAccounts.active,
            true,
          ),
        ),
      )

    const [activeInventoryConnection] =
      await db
        .select({
          id: dataConnections.id,
        })
        .from(dataConnections)
        .where(
          and(
            eq(
              dataConnections.purpose,
              'INVENTORY',
            ),
            eq(
              dataConnections.isActive,
              true,
            ),
          ),
        )
        .limit(1)

    const inventoryItems =
      activeInventoryConnection
        ? await db
            .select({
              sku: inventorySourceItems.sku,
              stock: inventorySourceItems.stock,
            })
            .from(inventorySourceItems)
            .where(
              eq(
                inventorySourceItems.connectionId,
                activeInventoryConnection.id,
              ),
            )
        : []

    const inventoryStockBySku = new Map(
      inventoryItems.map(
        (item) => [
          item.sku,
          item.stock,
        ] as const,
      ),
    )

    const data = result.map((listing) => ({
      ...listing,

      inventorySourceStock:
        activeInventoryConnection
          ? (
              inventoryStockBySku.get(
                listing.sku,
              ) ?? null
            )
          : null,

      inventorySourceMissing:
        activeInventoryConnection
          ? !inventoryStockBySku.has(
              listing.sku,
            )
          : null,
    }))

    return context.json({
      status: 'ok',
      count: result.length,
      data: data,
    })
  } catch (error) {
    console.error(
      'Allegro listing query failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not load Allegro listings',
      },
      500,
    )
  }
})

app.post(
  '/allegro/listings/initialize-baseline',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const environment =
        (process.env.ALLEGRO_ENV ?? 'SANDBOX')
          .toUpperCase()

      if (environment !== 'PRODUCTION') {
        return context.json(
          {
            status: 'error',
            message:
              'Accepted baseline initialization is production-only',
          },
          409,
        )
      }

      const rows =
        await db
          .select({
            listingId:
              platformListings.id,

            priceMinor:
              listingRemoteStates.priceMinor,

            stockAvailable:
              listingRemoteStates.stockAvailable,

            publicationStatus:
              listingRemoteStates.publicationStatus,

            acceptedStateId:
              listingAcceptedStates.id,
          })
          .from(platformListings)
          .innerJoin(
            platformAccounts,
            eq(
              platformListings.accountId,
              platformAccounts.id,
            ),
          )
          .innerJoin(
            platforms,
            eq(
              platformListings.platformId,
              platforms.id,
            ),
          )
          .leftJoin(
            listingRemoteStates,
            eq(
              listingRemoteStates.listingId,
              platformListings.id,
            ),
          )
          .leftJoin(
            listingAcceptedStates,
            eq(
              listingAcceptedStates.listingId,
              platformListings.id,
            ),
          )
          .where(
            and(
              eq(
                platforms.code,
                'ALLEGRO',
              ),
              eq(
                platformListings.marketplace,
                'allegro-hu',
              ),
              eq(
                platformAccounts.environment,
                environment,
              ),
              eq(
                platformAccounts.active,
                true,
              ),
            ),
          )

      const missingBaselineRows =
        rows.filter(
          (row) =>
            row.acceptedStateId === null,
        )

      const now = new Date()

      if (missingBaselineRows.length > 0) {
        await db
          .insert(listingAcceptedStates)
          .values(
            missingBaselineRows.map(
              (row) => ({
                listingId:
                  row.listingId,

                acceptedPriceMinor:
                  row.priceMinor,

                acceptedStockAvailable:
                  row.stockAvailable,

                acceptedPublicationStatus:
                  row.publicationStatus ??
                  'UNKNOWN',

                acceptedAt: now,
                updatedAt: now,
              }),
            ),
          )
          .onConflictDoNothing({
            target:
              listingAcceptedStates.listingId,
          })
      }

      return context.json({
        status: 'ok',
        environment,
        totalListings:
          rows.length,
        initialized:
          missingBaselineRows.length,
        alreadyInitialized:
          rows.length -
          missingBaselineRows.length,
        allegroWritePerformed:
          false,
        desiredStateModified:
          false,
      })
    } catch (error) {
      console.error(
        'Allegro baseline initialization failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not initialize Allegro accepted baseline',
        },
        500,
      )
    }
  },
)
app.post(
  '/allegro/listings/:id/initialize-baseline',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const environment =
        (process.env.ALLEGRO_ENV ?? 'SANDBOX')
          .toUpperCase()

      if (environment !== 'PRODUCTION') {
        return context.json(
          {
            status: 'error',
            message:
              'Targeted accepted baseline initialization is production-only',
          },
          409,
        )
      }

      const listingId =
        context.req.param('id')

      const [row] = await db
        .select({
          listingId:
            platformListings.id,

          priceMinor:
            listingRemoteStates.priceMinor,

          stockAvailable:
            listingRemoteStates.stockAvailable,

          publicationStatus:
            listingRemoteStates.publicationStatus,

          acceptedStateId:
            listingAcceptedStates.id,
        })
        .from(platformListings)
        .innerJoin(
          platformAccounts,
          eq(
            platformListings.accountId,
            platformAccounts.id,
          ),
        )
        .innerJoin(
          platforms,
          eq(
            platformListings.platformId,
            platforms.id,
          ),
        )
        .leftJoin(
          listingRemoteStates,
          eq(
            listingRemoteStates.listingId,
            platformListings.id,
          ),
        )
        .leftJoin(
          listingAcceptedStates,
          eq(
            listingAcceptedStates.listingId,
            platformListings.id,
          ),
        )
        .where(
          and(
            eq(
              platformListings.id,
              listingId,
            ),
            eq(
              platforms.code,
              'ALLEGRO',
            ),
            eq(
              platformListings.marketplace,
              'allegro-hu',
            ),
            eq(
              platformAccounts.environment,
              environment,
            ),
            eq(
              platformAccounts.active,
              true,
            ),
          ),
        )
        .limit(1)

      if (!row) {
        return context.json(
          {
            status: 'error',
            message:
              'Production Allegro listing was not found',
          },
          404,
        )
      }

      if (row.acceptedStateId !== null) {
        return context.json({
          status: 'ok',

          listingId:
            row.listingId,

          initialized:
            false,

          alreadyInitialized:
            true,

          allegroWritePerformed:
            false,

          desiredStateModified:
            false,
        })
      }

      if (!row.publicationStatus) {
        return context.json(
          {
            status: 'error',
            message:
              'Remote listing state is not initialized',
          },
          409,
        )
      }

      const now = new Date()

      await db
        .insert(listingAcceptedStates)
        .values({
          listingId:
            row.listingId,

          acceptedPriceMinor:
            row.priceMinor,

          acceptedStockAvailable:
            row.stockAvailable,

          acceptedPublicationStatus:
            row.publicationStatus,

          acceptedAt:
            now,

          updatedAt:
            now,
        })
        .onConflictDoNothing({
          target:
            listingAcceptedStates.listingId,
        })

      return context.json({
        status: 'ok',

        listingId:
          row.listingId,

        initialized:
          true,

        alreadyInitialized:
          false,

        acceptedPriceMinor:
          row.priceMinor,

        acceptedStockAvailable:
          row.stockAvailable,

        acceptedPublicationStatus:
          row.publicationStatus,

        acceptedAt:
          now.toISOString(),

        allegroWritePerformed:
          false,

        desiredStateModified:
          false,
      })
    } catch (error) {
      console.error(
        'Targeted Allegro baseline initialization failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not initialize targeted Allegro accepted baseline',
        },
        500,
      )
    }
  },
)
app.post(
  '/allegro/listings/:id/accept-current-state',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const listingId =
        context.req.param('id')

      const now = new Date()

      const [row] = await db
        .select({
          listingId:
            platformListings.id,

          priceMinor:
            listingRemoteStates.priceMinor,

          stockAvailable:
            listingRemoteStates.stockAvailable,

          publicationStatus:
            listingRemoteStates.publicationStatus,

          desiredStateId:
            listingDesiredStates.id,

          desiredPriceMinor:
            listingDesiredStates.regularPriceMinor,

          desiredStock:
            listingDesiredStates.desiredStock,

          desiredPublicationStatus:
            listingDesiredStates.desiredPublicationStatus,
          acceptedPriceMinor:
            listingAcceptedStates.acceptedPriceMinor,

          acceptedStockAvailable:
            listingAcceptedStates.acceptedStockAvailable,

          acceptedPublicationStatus:
            listingAcceptedStates.acceptedPublicationStatus,
        })
        .from(platformListings)
        .leftJoin(
          listingRemoteStates,
          eq(
            listingRemoteStates.listingId,
            platformListings.id,
          ),
        )
        .leftJoin(
          listingDesiredStates,
          eq(
            listingDesiredStates.listingId,
            platformListings.id,
          ),
        )
        .leftJoin(
          listingAcceptedStates,
          eq(
            listingAcceptedStates.listingId,
            platformListings.id,
          ),
        )
        .where(
          eq(
            platformListings.id,
            listingId,
          ),
        )
        .limit(1)

      if (!row) {
        return context.json(
          {
            status: 'error',
            message: 'Listing was not found',
          },
          404,
        )
      }

      if (!row.desiredStateId) {
        return context.json(
          {
            status: 'error',
            message:
              'Desired state was not found for the listing',
          },
          409,
        )
      }


      // Aktív Commerce Hub időzített kedvezmény

      const scheduleRows = await db
        .select({
          enabled:
            listingPriceSchedules.enabled,

          validFrom:
            listingPriceSchedules.validFrom,

          validTo:
            listingPriceSchedules.validTo,

          startAppliedAt:
            listingPriceSchedules.startAppliedAt,

          endAppliedAt:
            listingPriceSchedules.endAppliedAt,
        })
        .from(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.listingId,
            listingId,
          ),
        )

      const hasActivePriceSchedule =
        scheduleRows.some(
          (schedule) =>
            schedule.enabled &&
            schedule.startAppliedAt !== null &&
            schedule.endAppliedAt === null &&
            schedule.validFrom <= now &&
            schedule.validTo >= now,
        )


      // Aktív hivatalos Allegro kampány

      const campaignRows = await db
        .select({
          campaignType:
            listingCampaigns.campaignType,

          campaignStatus:
            listingCampaigns.campaignStatus,

          validFrom:
            listingCampaigns.validFrom,

          validTo:
            listingCampaigns.validTo,
        })
        .from(listingCampaigns)
        .where(
          eq(
            listingCampaigns.listingId,
            listingId,
          ),
        )

      const hasActiveAllegroCampaign =
        campaignRows.some(
          (campaign) =>
            campaign.campaignType ===
              'DISCOUNT' &&
            campaign.campaignStatus ===
              'ACTIVE' &&
            (
              !campaign.validFrom ||
              campaign.validFrom <= now
            ) &&
            (
              !campaign.validTo ||
              campaign.validTo >= now
            ),
        )

      const priceProtected =
        hasActivePriceSchedule ||
        hasActiveAllegroCampaign
      const priceChangedSinceAccepted =
        row.priceMinor !==
        row.acceptedPriceMinor

      const stockChangedSinceAccepted =
        row.stockAvailable !==
        row.acceptedStockAvailable

      const publicationChangedSinceAccepted =
        row.publicationStatus !==
        row.acceptedPublicationStatus


      // Allegro státusz -> kívánt státusz

      let nextDesiredPublicationStatus =
        row.desiredPublicationStatus ??
        'UNKNOWN'

      if (
        row.publicationStatus === 'ACTIVE' ||
        row.publicationStatus ===
          'ACTIVATING'
      ) {
        nextDesiredPublicationStatus =
          'ACTIVE'
      } else if (
        row.publicationStatus ===
          'INACTIVE' ||
        row.publicationStatus === 'ENDED'
      ) {
        nextDesiredPublicationStatus =
          'INACTIVE'
      }


      // Normál változás elfogadásakor a desired state
      // követi az Allegrót.
      // Aktív kedvezménynél az alapár védett.

      await db
        .update(listingDesiredStates)
        .set({
          ...(
            priceChangedSinceAccepted &&
            !priceProtected
              ? {
                  regularPriceMinor:
                    row.priceMinor,
                }
              : {}
          ),

          ...(
            stockChangedSinceAccepted
              ? {
                  desiredStock:
                    row.stockAvailable,
                }
              : {}
          ),

          ...(
            publicationChangedSinceAccepted
              ? {
                  desiredPublicationStatus:
                    nextDesiredPublicationStatus,
                }
              : {}
          ),

          updatedBy:
            'COMMERCE_HUB_ACCEPT',

          updatedAt: now,
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            listingId,
          ),
        )

      // Aktuális Allegro állapot elfogadása

      const acceptedPublicationStatus =
        row.publicationStatus ??
        'UNKNOWN'

      await db
        .insert(listingAcceptedStates)
        .values({
          listingId,

          acceptedPriceMinor:
            row.priceMinor,

          acceptedStockAvailable:
            row.stockAvailable,

          acceptedPublicationStatus,

          acceptedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target:
            listingAcceptedStates.listingId,

          set: {
            acceptedPriceMinor:
              row.priceMinor,

            acceptedStockAvailable:
              row.stockAvailable,

            acceptedPublicationStatus,

            acceptedAt: now,
            updatedAt: now,
          },
        })


      return context.json({
        status: 'ok',

        data: {
          listingId,

          acceptedPriceMinor:
            row.priceMinor,

          acceptedStockAvailable:
            row.stockAvailable,

          acceptedPublicationStatus,

          acceptedAt:
            now.toISOString(),

          priceProtected,

          priceProtectionReason:
            hasActiveAllegroCampaign
              ? 'ALLEGRO_CAMPAIGN'
              : hasActivePriceSchedule
                ? 'PRICE_SCHEDULE'
                : null,
        },
      })
    } catch (error) {
      console.error(
        'Accept Allegro listing state failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not accept the current Allegro listing state',
        },
        500,
      )
    }
  },
)

app.get('/allegro/listing-price-history-summary', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const now = new Date()

    const campaignId =
      context.req.query('campaignId')
        ?.trim() || null

    const thirtyDaysAgo = new Date(
      now.getTime() -
        30 * 24 * 60 * 60 * 1000,
    )

    const expectedDayKeys =
      new Set<string>()

    for (
      let dayOffset = 0;
      dayOffset < 30;
      dayOffset++
    ) {
      const date = new Date(
        now.getTime() -
          dayOffset *
            24 *
            60 *
            60 *
            1000,
      )

      expectedDayKeys.add(
        date.toISOString().slice(0, 10),
      )
    }

    const [
      thirtyDayRows,
      historyStartRows,
      observationRows,
    ] = await Promise.all([
      db
        .select({
          listingId:
            listingPriceHistory.listingId,

          min30PriceMinor:
            min(
              listingPriceHistory.priceMinor,
            ),

          observationCount:
            count(),
        })
        .from(listingPriceHistory)
        .where(
          gte(
            listingPriceHistory.observedAt,
            thirtyDaysAgo,
          ),
        )
        .groupBy(
          listingPriceHistory.listingId,
        ),

      db
        .select({
          listingId:
            listingPriceHistory.listingId,

          historyStartedAt:
            min(
              listingPriceHistory.observedAt,
            ),
        })
        .from(listingPriceHistory)
        .groupBy(
          listingPriceHistory.listingId,
        ),

      db
        .select({
          listingId:
            listingPriceHistory.listingId,

          priceMinor:
            listingPriceHistory.priceMinor,

          externalCampaignId:
            listingPriceHistory.externalCampaignId,

          observedAt:
            listingPriceHistory.observedAt,
        })
        .from(listingPriceHistory)
        .where(
          gte(
            listingPriceHistory.observedAt,
            thirtyDaysAgo,
          ),
        ),
    ])

    const campaignReferenceMinByListing =
      new Map<string, number>()

    if (campaignId) {
      const campaignRows = await db
        .select({
          listingId:
            listingCampaigns.listingId,

          validFrom:
            listingCampaigns.validFrom,
        })
        .from(listingCampaigns)
        .where(
          eq(
            listingCampaigns.externalCampaignId,
            campaignId,
          ),
        )

      const campaignStartByListing =
        new Map<string, Date>()

      for (const campaign of campaignRows) {
        if (!campaign.validFrom) {
          continue
        }

        const campaignStart =
          new Date(campaign.validFrom)

        const existingStart =
          campaignStartByListing.get(
            campaign.listingId,
          )

        if (
          !existingStart ||
          campaignStart.getTime() <
            existingStart.getTime()
        ) {
          campaignStartByListing.set(
            campaign.listingId,
            campaignStart,
          )
        }
      }

      const campaignStartTimes =
        Array.from(
          campaignStartByListing.values(),
        ).map((date) => date.getTime())

      if (campaignStartTimes.length > 0) {
        const earliestCampaignStart =
          Math.min(...campaignStartTimes)

        const earliestReferenceStart =
          new Date(
            earliestCampaignStart -
              30 * 24 * 60 * 60 * 1000,
          )

        const referenceRows = await db
          .select({
            listingId:
              listingPriceHistory.listingId,

            priceMinor:
              listingPriceHistory.priceMinor,

            observedAt:
              listingPriceHistory.observedAt,
          })
          .from(listingPriceHistory)
          .where(
            gte(
              listingPriceHistory.observedAt,
              earliestReferenceStart,
            ),
          )

        for (const row of referenceRows) {
          const campaignStart =
            campaignStartByListing.get(
              row.listingId,
            )

          if (!campaignStart) {
            continue
          }

          const campaignStartTime =
            campaignStart.getTime()

          const referenceStartTime =
            campaignStartTime -
              30 * 24 * 60 * 60 * 1000

          const observedTime =
            new Date(
              row.observedAt,
            ).getTime()

          if (
            observedTime < referenceStartTime ||
            observedTime >= campaignStartTime
          ) {
            continue
          }

          const currentMin =
            campaignReferenceMinByListing.get(
              row.listingId,
            )

          if (
            currentMin === undefined ||
            row.priceMinor < currentMin
          ) {
            campaignReferenceMinByListing.set(
              row.listingId,
              row.priceMinor,
            )
          }
        }
      }
    }

    const historyStartByListing =
      new Map(
        historyStartRows.map((row) => [
          row.listingId,
          row.historyStartedAt,
        ]),
      )

    const observedDaysByListing =
      new Map<string, Set<string>>()

    for (const row of observationRows) {
      const dayKey =
        new Date(row.observedAt)
          .toISOString()
          .slice(0, 10)

      if (!expectedDayKeys.has(dayKey)) {
        continue
      }

      const existingDays =
        observedDaysByListing.get(
          row.listingId,
        )

      if (existingDays) {
        existingDays.add(dayKey)
      } else {
        observedDaysByListing.set(
          row.listingId,
          new Set([dayKey]),
        )
      }
    }

    const data = thirtyDayRows.map((row) => {
      const historyStartedValue =
        historyStartByListing.get(
          row.listingId,
        )

      const historyStartedAt =
        historyStartedValue
          ? new Date(historyStartedValue)
          : null

      const coverageDayCount =
        observedDaysByListing.get(
          row.listingId,
        )?.size ?? 0

      const missingDayCount =
        Math.max(
          0,
          30 - coverageDayCount,
        )

      return {
        listingId: row.listingId,

        min30PriceMinor:
          row.min30PriceMinor === null
            ? null
            : Number(
                row.min30PriceMinor,
              ),

      campaignReferenceMin30PriceMinor:
        campaignReferenceMinByListing.get(
          row.listingId,
        ) ?? null,

        observationCount:
          Number(
            row.observationCount,
          ),

        coverageDayCount,
        missingDayCount,

        historyStartedAt:
          historyStartedAt
            ? historyStartedAt.toISOString()
            : null,

        hasFull30DayWindow:
          coverageDayCount === 30,
      }
    })

    return context.json({
      status: 'ok',
      windowDays: 30,
      calculatedAt: now.toISOString(),
      count: data.length,
      data,
    })
  } catch (error) {
    console.error(
      'Price history summary failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not calculate price history summary',
      },
      500,
    )
  }
})
app.get(
  '/allegro/remote-campaigns/:campaignId/preparations',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const externalCampaignId =
        context.req.param('campaignId')

      const preparations = await db
        .select({
          id: listingCampaigns.id,
          listingId: listingCampaigns.listingId,
          externalCampaignId:
            listingCampaigns.externalCampaignId,
          desiredPriceMinor:
            listingCampaigns.desiredPriceMinor,
          validFrom: listingCampaigns.validFrom,
          validTo: listingCampaigns.validTo,
          applicationStatus:
            listingCampaigns.applicationStatus,

          applicationError:
            listingCampaigns.applicationError,

          finishError:
            listingCampaigns.finishError,

          finishRetryAfter:
            listingCampaigns.finishRetryAfter,

          finishRetryCount:
            listingCampaigns.finishRetryCount,

          retryAfter:
            listingCampaigns.retryAfter,

          retryCount:
            listingCampaigns.retryCount,

          campaignStatus:
            listingCampaigns.campaignStatus,
          updatedAt:
            listingCampaigns.updatedAt,
        })
        .from(listingCampaigns)
        .where(
          eq(
            listingCampaigns.externalCampaignId,
            externalCampaignId,
          ),
        )

      return context.json({
        status: 'ok',
        count: preparations.length,
        data: preparations,
      })
    } catch (error) {
      console.error(
        'Campaign preparations loading failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not load campaign preparations',
        },
        500,
      )
    }
  },
)

app.put(
  '/allegro/remote-campaigns/:campaignId/preparations',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const externalCampaignId =
        context.req.param('campaignId')

      const body = await context.req.json<{
        campaign?: {
          name?: string
          type?: string
          marketplace?: string
          publicationFrom?: string | null
          publicationTo?: string | null
        }
        listings?: Array<{
          listingId?: string
          desiredPrice?: number
          validFrom?: string
          validTo?: string
        }>
      }>()

      const campaignName =
        body.campaign?.name?.trim()

      if (!campaignName) {
        return context.json(
          {
            status: 'error',
            message: 'Campaign name is required',
          },
          400,
        )
      }

      const campaignType =
        body.campaign?.type?.toUpperCase() ??
        'OTHER'

      const allowedCampaignTypes = [
        'STANDARD',
        'DISCOUNT',
        'SOURCING',
        'OTHER',
      ] as const

      if (
        !allowedCampaignTypes.includes(
          campaignType as
            (typeof allowedCampaignTypes)[number],
        )
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Invalid campaign type',
          },
          400,
        )
      }

      const campaignTypeValue =
        campaignType as
          | 'STANDARD'
          | 'DISCOUNT'
          | 'SOURCING'
          | 'OTHER'

      const marketplace =
        body.campaign?.marketplace?.trim() ||
        'allegro-hu'

      const publicationFrom =
        body.campaign?.publicationFrom
          ? new Date(
              body.campaign.publicationFrom,
            )
          : null

      const publicationTo =
        body.campaign?.publicationTo
          ? new Date(
              body.campaign.publicationTo,
            )
          : null

      if (
        publicationFrom &&
        Number.isNaN(
          publicationFrom.getTime(),
        )
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Invalid campaign publication start',
          },
          400,
        )
      }

      if (
        publicationTo &&
        Number.isNaN(
          publicationTo.getTime(),
        )
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Invalid campaign publication end',
          },
          400,
        )
      }

      if (
        publicationFrom &&
        publicationTo &&
        publicationTo < publicationFrom
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Invalid campaign publication period',
          },
          400,
        )
      }

      const listingInputs =
        body.listings ?? []

      if (listingInputs.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'At least one listing is required',
          },
          400,
        )
      }

      const duplicateCheck =
        new Set<string>()

      for (const item of listingInputs) {
        const listingId =
          item.listingId?.trim()

        if (
          listingId &&
          duplicateCheck.has(listingId)
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Duplicate listing in preparation request: ${listingId}`,
            },
            400,
          )
        }

        if (listingId) {
          duplicateCheck.add(listingId)
        }
      }

      const now = new Date()

      const [existingLocalCampaign] =
        await db
          .select()
          .from(campaigns)
          .where(
            eq(
              campaigns.externalCampaignId,
              externalCampaignId,
            ),
          )
          .limit(1)

      const localCampaignId =
        existingLocalCampaign?.id ??
        crypto.randomUUID()

      const normalizedListings: Array<{
        listingId: string
        desiredPriceMinor: number
        validFrom: Date
        validTo: Date
      }> = []

      /*
       * IMPORTANT:
       * Everything above the batch is validation/read-only.
       * No campaign or preparation data is written until
       * every requested listing has passed validation.
       */
      for (const item of listingInputs) {
        const listingId =
          item.listingId?.trim()

        const desiredPrice =
          Number(item.desiredPrice)

        if (
          !listingId ||
          !Number.isFinite(desiredPrice) ||
          desiredPrice <= 0 ||
          !item.validFrom ||
          !item.validTo
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Each listing requires listingId, campaign price, validFrom and validTo',
            },
            400,
          )
        }

        const validFrom =
          new Date(item.validFrom)

        const validTo =
          new Date(item.validTo)

        if (
          Number.isNaN(validFrom.getTime()) ||
          Number.isNaN(validTo.getTime()) ||
          validTo < validFrom
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Invalid listing campaign period',
            },
            400,
          )
        }

        if (
          publicationFrom &&
          validFrom < publicationFrom
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Listing start date is outside campaign period',
            },
            400,
          )
        }

        if (
          publicationTo &&
          validTo > publicationTo
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Listing end date is outside campaign period',
            },
            400,
          )
        }

        const desiredPriceMinor =
          Math.round(
            desiredPrice * 100,
          )

        const [listing] = await db
          .select({
            id: platformListings.id,
            currentPriceMinor:
              listingRemoteStates.priceMinor,
          })
          .from(platformListings)
          .leftJoin(
            listingRemoteStates,
            eq(
              listingRemoteStates.listingId,
              platformListings.id,
            ),
          )
          .where(
            eq(
              platformListings.id,
              listingId,
            ),
          )
          .limit(1)

        if (!listing) {
          return context.json(
            {
              status: 'error',
              message:
                `Listing not found: ${listingId}`,
            },
            404,
          )
        }

        const requiresDiscountPrice =
          campaignType === 'DISCOUNT' ||
          campaignType === 'SOURCING'

        if (
          requiresDiscountPrice &&
          listing.currentPriceMinor === null
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Current Allegro price is unavailable: ${listingId}`,
            },
            400,
          )
        }

        if (
          requiresDiscountPrice &&
          listing.currentPriceMinor !== null &&
          desiredPriceMinor >=
            listing.currentPriceMinor
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Campaign price must be lower than the current Allegro price: ${listingId}`,
            },
            400,
          )
        }

        const [existingPreparation] =
          await db
            .select({
              id:
                listingCampaigns.id,

              applicationStatus:
                listingCampaigns.applicationStatus,

              campaignStatus:
                listingCampaigns.campaignStatus,
            })
            .from(listingCampaigns)
            .where(
              and(
                eq(
                  listingCampaigns.listingId,
                  listingId,
                ),
                eq(
                  listingCampaigns.externalCampaignId,
                  externalCampaignId,
                ),
              ),
            )
            .limit(1)

        if (
          existingPreparation &&
          (
            existingPreparation.applicationStatus !==
              'PREPARED' ||
            existingPreparation.campaignStatus !==
              'PREPARED'
          )
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Campaign preparation is already in progress and cannot be edited: ${listingId}`,
              applicationStatus:
                existingPreparation.applicationStatus,
              campaignStatus:
                existingPreparation.campaignStatus,
            },
            409,
          )
        }

        normalizedListings.push({
          listingId,
          desiredPriceMinor,
          validFrom,
          validTo,
        })
      }

      const campaignWrite =
        existingLocalCampaign
          ? db
              .update(campaigns)
              .set({
                name: campaignName,
                campaignType:
                  campaignTypeValue,
                marketplace,
                validFrom:
                  publicationFrom,
                validTo:
                  publicationTo,
                updatedAt: now,
              })
              .where(
                eq(
                  campaigns.id,
                  localCampaignId,
                ),
              )
          : db
              .insert(campaigns)
              .values({
                id:
                  localCampaignId,

                externalCampaignId,

                name:
                  campaignName,

                campaignType:
                  campaignTypeValue,

                marketplace,

                status:
                  'AVAILABLE',

                validFrom:
                  publicationFrom,

                validTo:
                  publicationTo,

                autoSync:
                  false,

                createdAt:
                  now,

                updatedAt:
                  now,
              })

      const preparationWrites =
        normalizedListings.map(
          (item) =>
            db
              .insert(listingCampaigns)
              .values({
                campaignId:
                  localCampaignId,

                listingId:
                  item.listingId,

                externalCampaignId,

                campaignName,

                campaignType:
                  campaignTypeValue,

                marketplace,

                desiredPriceMinor:
                  item.desiredPriceMinor,

                priceLocked:
                  true,

                autoSync:
                  false,

                applicationStatus:
                  'PREPARED',

                campaignStatus:
                  'PREPARED',

                validFrom:
                  item.validFrom,

                validTo:
                  item.validTo,

                createdAt:
                  now,

                updatedAt:
                  now,
              })
              .onConflictDoUpdate({
                target: [
                  listingCampaigns.listingId,
                  listingCampaigns.externalCampaignId,
                ],
                set: {
                  campaignId:
                    localCampaignId,

                  campaignName,

                  campaignType:
                    campaignTypeValue,

                  marketplace,

                  desiredPriceMinor:
                    item.desiredPriceMinor,

                  priceLocked:
                    true,

                  validFrom:
                    item.validFrom,

                  validTo:
                    item.validTo,

                  updatedAt:
                    now,
                },
              }),
        )

      await db.batch(
        [
          campaignWrite,
          ...preparationWrites,
        ] as [
          typeof campaignWrite,
          ...typeof preparationWrites,
        ],
      )

      const savedCampaignRows =
        await db
          .select()
          .from(listingCampaigns)
          .where(
            eq(
              listingCampaigns.externalCampaignId,
              externalCampaignId,
            ),
          )

      const requestedListingIds =
        new Set(
          normalizedListings.map(
            (item) => item.listingId,
          ),
        )

      const saved =
        savedCampaignRows.filter(
          (row) =>
            requestedListingIds.has(
              row.listingId,
            ),
        )

      return context.json({
        status: 'ok',
        count: saved.length,
        data: saved,
      })
    } catch (error) {
      console.error(
        'Campaign preparations saving failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not save campaign preparations',
        },
        500,
      )
    }
  },
)
app.post(
  '/allegro/remote-campaigns/:campaignId/schedule',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const externalCampaignId =
        context.req.param('campaignId')

      const body = await context.req.json<{
        listingIds?: string[]
      }>()

      const listingIds =
        body.listingIds ?? []

      if (listingIds.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'At least one listing is required',
          },
          400,
        )
      }

      const now = new Date()
      const scheduled = []

      for (const listingId of listingIds) {
        const [preparation] = await db
          .select()
          .from(listingCampaigns)
          .where(
            and(
              eq(
                listingCampaigns.externalCampaignId,
                externalCampaignId,
              ),
              eq(
                listingCampaigns.listingId,
                listingId,
              ),
            ),
          )
          .limit(1)

        if (!preparation) {
          return context.json(
            {
              status: 'error',
              message:
                `Preparation not found: ${listingId}`,
            },
            404,
          )
        }

        if (
          preparation.applicationStatus !==
            'PREPARED' ||
          preparation.campaignStatus !==
            'PREPARED'
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Preparation cannot be scheduled from its current state: ${listingId}`,
              applicationStatus:
                preparation.applicationStatus,
              campaignStatus:
                preparation.campaignStatus,
            },
            409,
          )
        }

        if (
          preparation.desiredPriceMinor === null ||
          !preparation.validFrom ||
          !preparation.validTo
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Preparation is incomplete: ${listingId}`,
            },
            400,
          )
        }

        if (
          preparation.validTo <
          preparation.validFrom
        ) {
          return context.json(
            {
              status: 'error',
              message:
                `Invalid preparation period: ${listingId}`,
            },
            400,
          )
        }

        const [updated] = await db
          .update(listingCampaigns)
          .set({
            applicationStatus:
              'SCHEDULED',

            applicationError: null,

            retryAfter: null,
            retryCount: 0,

            updatedAt: now,
          })
          .where(
            and(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
              eq(
                listingCampaigns.applicationStatus,
                'PREPARED',
              ),
              eq(
                listingCampaigns.campaignStatus,
                'PREPARED',
              ),
            ),
          )
          .returning()

        if (!updated) {
          return context.json(
            {
              status: 'error',
              message:
                `Preparation state changed before scheduling: ${listingId}`,
            },
            409,
          )
        }

        scheduled.push(updated)
      }

      return context.json({
        status: 'ok',
        count: scheduled.length,
        data: scheduled,
      })
    } catch (error) {
      console.error(
        'Campaign scheduling failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not schedule campaign listings',
        },
        500,
      )
    }
  },
)
app.post(
  '/allegro/remote-campaigns/:campaignId/submit',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const externalCampaignId =
        context.req.param('campaignId')

      const body = await context.req.json<{
        listingIds?: string[]
      }>()

      const listingIds =
        body.listingIds ?? []

      if (listingIds.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'At least one listing is required',
          },
          400,
        )
      }

      const remoteCampaigns =
        await getAllegroBadgeCampaigns(
          'allegro-hu',
        )

      const remoteCampaign =
        remoteCampaigns.badgeCampaigns.find(
          (campaign) =>
            campaign.id === externalCampaignId,
        )

      if (!remoteCampaign) {
        return context.json(
          {
            status: 'error',
            message:
              'Campaign is no longer available in Allegro',
          },
          404,
        )
      }

      if (!remoteCampaign.eligibility.eligible) {
        return context.json(
          {
            status: 'error',
            message:
              'Allegro account is not eligible for this campaign',

            refusalReasons:
              remoteCampaign.eligibility.refusalReasons,
          },
          409,
        )
      }

      if (
        remoteCampaign.application.type ===
        'NEVER'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'This campaign does not accept manual applications',
          },
          409,
        )
      }

      if (
        remoteCampaign.application.type ===
        'WITHIN'
      ) {
        const now = new Date()

        const applicationFrom =
          remoteCampaign.application.from
            ? new Date(
                remoteCampaign.application.from,
              )
            : null

        const applicationTo =
          remoteCampaign.application.to
            ? new Date(
                remoteCampaign.application.to,
              )
            : null

        if (
          applicationFrom &&
          now < applicationFrom
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Campaign application period has not started yet',
            },
            409,
          )
        }

        if (
          applicationTo &&
          now > applicationTo
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Campaign application period has already ended',
            },
            409,
          )
        }
      }

      const results: Array<{
        listingId: string
        offerId?: string
        status: string
        applicationId?: string | null
        error?: string
      }> = []

      for (const listingId of listingIds) {
        const [preparation] = await db
          .select({
            id: listingCampaigns.id,

            listingId:
              listingCampaigns.listingId,

            externalCampaignId:
              listingCampaigns.externalCampaignId,

            campaignType:
              listingCampaigns.campaignType,

            desiredPriceMinor:
              listingCampaigns.desiredPriceMinor,

            dedicatedStock:
              listingCampaigns.dedicatedStock,

            applicationStatus:
              listingCampaigns.applicationStatus,

            validFrom:
              listingCampaigns.validFrom,

            validTo:
              listingCampaigns.validTo,

            offerId:
              platformListings.externalListingId,
          })
          .from(listingCampaigns)
          .innerJoin(
            platformListings,
            eq(
              platformListings.id,
              listingCampaigns.listingId,
            ),
          )
          .where(
            and(
              eq(
                listingCampaigns.externalCampaignId,
                externalCampaignId,
              ),
              eq(
                listingCampaigns.listingId,
                listingId,
              ),
            ),
          )
          .limit(1)

        if (!preparation) {
          results.push({
            listingId,
            status: 'FAILED',
            error:
              'Campaign preparation not found',
          })

          continue
        }

        if (
          preparation.applicationStatus !==
          'SCHEDULED'
        ) {
          results.push({
            listingId,
            offerId: preparation.offerId,
            status: 'FAILED',
            error:
              `Listing is not scheduled. Current status: ${
                preparation.applicationStatus ?? 'NONE'
              }`,
          })

          continue
        }

        if (
          preparation.desiredPriceMinor === null
        ) {
          results.push({
            listingId,
            offerId: preparation.offerId,
            status: 'FAILED',
            error:
              'Campaign price is missing',
          })

          continue
        }

        if (
          remoteCampaign.stockReservationIsRequired &&
          (
            preparation.dedicatedStock === null ||
            preparation.dedicatedStock <= 0
          )
        ) {
          results.push({
            listingId,
            offerId: preparation.offerId,
            status: 'FAILED',
            error:
              'Dedicated campaign stock is required',
          })

          continue
        }

        const submittingAt = new Date()

        if (
          preparation.validFrom &&
          submittingAt < preparation.validFrom
        ) {
          results.push({
            listingId,
            offerId: preparation.offerId,
            status: 'SCHEDULED',
            error:
              `Not due yet. Scheduled from: ${preparation.validFrom.toISOString()}`,
          })

          continue
        }

        if (
          preparation.validTo &&
          submittingAt > preparation.validTo
        ) {
          const errorText =
            `Submission period already expired: ${preparation.validTo.toISOString()}`

          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                'FAILED',

              applicationError:
                errorText,

              updatedAt:
                submittingAt,
            })
            .where(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
            )

          results.push({
            listingId,
            offerId: preparation.offerId,
            status: 'FAILED',
            error: errorText,
          })

          continue
        }

        const [claimedPreparation] =
          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                'SUBMITTING',

              applicationError: null,

              updatedAt: submittingAt,
            })
            .where(
              and(
                eq(
                  listingCampaigns.id,
                  preparation.id,
                ),
                eq(
                  listingCampaigns.applicationStatus,
                  'SCHEDULED',
                ),
              ),
            )
            .returning({
              id:
                listingCampaigns.id,
            })

        if (!claimedPreparation) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'SKIPPED',
            error:
              'Preparation was already claimed by another process',
          })

          continue
        }

        try {
          const submission =
            await submitOfferToAllegroCampaign({
              campaignId:
                externalCampaignId,

              offerId:
                preparation.offerId,

              campaignType:
                preparation.campaignType,

              bargainPriceMinor:
                preparation.desiredPriceMinor,

              currency: 'HUF',

              campaignStock:
                preparation.dedicatedStock,
            })

          if (!submission.ok) {
            const errorText =
              typeof submission.data ===
              'string'
                ? submission.data
                : JSON.stringify(
                    submission.data,
                  )

            await db
              .update(listingCampaigns)
              .set({
                applicationStatus:
                  'FAILED',

                applicationError:
                  errorText,

                lastSyncedAt:
                  new Date(),

                updatedAt:
                  new Date(),
              })
              .where(
                eq(
                  listingCampaigns.id,
                  preparation.id,
                ),
              )

            results.push({
              listingId,
              offerId:
                preparation.offerId,
              status: 'FAILED',
              error: errorText,
            })

            continue
          }

          const responseData =
            submission.data &&
            typeof submission.data === 'object'
              ? submission.data as {
                  id?: unknown
                  process?: {
                    status?: unknown
                  }
                }
              : null

          const externalApplicationId =
            typeof responseData?.id === 'string'
              ? responseData.id
              : null

          const remoteStatus =
            typeof responseData?.process?.status ===
            'string'
              ? responseData.process.status
              : 'REQUESTED'

          await db
            .update(listingCampaigns)
            .set({
              externalApplicationId,

              applicationStatus:
                remoteStatus,

              applicationError: null,

              lastSyncedAt:
                new Date(),

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
            )

          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: remoteStatus,
            applicationId:
              externalApplicationId,
          })
        } catch (submissionError) {
          const errorText =
            submissionError instanceof Error
              ? submissionError.message
              : 'Unknown Allegro submission error'

          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                'FAILED',

              applicationError:
                errorText,

              lastSyncedAt:
                new Date(),

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
            )

          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error: errorText,
          })
        }
      }

      const succeeded =
        results.filter(
          (result) =>
            result.status !== 'FAILED' &&
            result.status !== 'SKIPPED',
        ).length

      const failed =
        results.filter(
          (result) =>
            result.status === 'FAILED',
        ).length

      const skipped =
        results.filter(
          (result) =>
            result.status === 'SKIPPED',
        ).length

      return context.json({
        status:
          failed === 0
            ? 'ok'
            : succeeded === 0
              ? 'error'
              : 'partial',

        count: results.length,
        succeeded,
        failed,
        skipped,
        data: results,
      })
    } catch (error) {
      console.error(
        'Campaign batch submission failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not submit campaign listings',
        },
        500,
      )
    }
  },
)
app.get('/allegro/campaigns', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const campaignRows = await db
      .select({
        id: campaigns.id,
        externalCampaignId:
          campaigns.externalCampaignId,
        name: campaigns.name,
        campaignType:
          campaigns.campaignType,
        marketplace:
          campaigns.marketplace,
        status: campaigns.status,
        validFrom: campaigns.validFrom,
        validTo: campaigns.validTo,
        autoSync: campaigns.autoSync,
        createdAt: campaigns.createdAt,
        updatedAt: campaigns.updatedAt,
      })
      .from(campaigns)

    const data = await Promise.all(
      campaignRows.map(async (campaign) => {
        const listings = await db
          .select({
            id: listingCampaigns.id,

            listingId:
              listingCampaigns.listingId,

            externalListingId:
              platformListings.externalListingId,

            listingName:
              platformListings.listingName,

            sku: products.sku,

            productName:
              products.name,

            desiredPriceMinor:
              listingCampaigns.desiredPriceMinor,

            remotePriceMinor:
              listingCampaigns.remotePriceMinor,

            referencePriceMinor:
              listingCampaigns.referencePriceMinor,

            dedicatedStock:
              listingCampaigns.dedicatedStock,

            priceLocked:
              listingCampaigns.priceLocked,

            applicationStatus:
              listingCampaigns.applicationStatus,

            campaignStatus:
              listingCampaigns.campaignStatus,

            lastSyncedAt:
              listingCampaigns.lastSyncedAt,
          })
          .from(listingCampaigns)
          .innerJoin(
            platformListings,
            eq(
              platformListings.id,
              listingCampaigns.listingId,
            ),
          )
          .innerJoin(
            products,
            eq(
              products.id,
              platformListings.productId,
            ),
          )
          .where(
            eq(
              listingCampaigns.campaignId,
              campaign.id,
            ),
          )

        return {
          ...campaign,
          listings,
        }
      }),
    )

    return context.json({
      status: 'ok',
      data,
    })
  } catch (error) {
    console.error(
      'Campaign list loading failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not load campaigns',
      },
      500,
    )
  }
})
app.get('/allegro/campaigns/:id', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const campaignId = context.req.param('id')

    const [campaign] = await db
      .select({
        id: campaigns.id,
        externalCampaignId:
          campaigns.externalCampaignId,
        name: campaigns.name,
        campaignType:
          campaigns.campaignType,
        marketplace:
          campaigns.marketplace,
        status: campaigns.status,
        validFrom: campaigns.validFrom,
        validTo: campaigns.validTo,
        autoSync: campaigns.autoSync,
        createdAt: campaigns.createdAt,
        updatedAt: campaigns.updatedAt,
      })
      .from(campaigns)
      .where(
        eq(
          campaigns.id,
          campaignId,
        ),
      )
      .limit(1)

    if (!campaign) {
      return context.json(
        {
          status: 'error',
          message: 'Campaign not found',
        },
        404,
      )
    }

    const listings = await db
      .select({
        id: listingCampaigns.id,

        listingId:
          listingCampaigns.listingId,

        externalListingId:
          platformListings.externalListingId,

        listingName:
          platformListings.listingName,

        sku: products.sku,

        productName:
          products.name,

        desiredPriceMinor:
          listingCampaigns.desiredPriceMinor,

        remotePriceMinor:
          listingCampaigns.remotePriceMinor,

        referencePriceMinor:
          listingCampaigns.referencePriceMinor,

        dedicatedStock:
          listingCampaigns.dedicatedStock,

        priceLocked:
          listingCampaigns.priceLocked,

        autoSync:
          listingCampaigns.autoSync,

        applicationStatus:
          listingCampaigns.applicationStatus,

        campaignStatus:
          listingCampaigns.campaignStatus,

        lastSyncedAt:
          listingCampaigns.lastSyncedAt,
      })
      .from(listingCampaigns)
      .innerJoin(
        platformListings,
        eq(
          platformListings.id,
          listingCampaigns.listingId,
        ),
      )
      .innerJoin(
        products,
        eq(
          products.id,
          platformListings.productId,
        ),
      )
      .where(
        eq(
          listingCampaigns.campaignId,
          campaignId,
        ),
      )

    return context.json({
      status: 'ok',
      data: {
        ...campaign,
        listings,
      },
    })
  } catch (error) {
    console.error(
      'Campaign detail loading failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not load campaign',
      },
      500,
    )
  }
})
app.get('/allegro/listings/:id/campaigns', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId = context.req.param('id')

    const campaigns = await db
      .select({
        id: listingCampaigns.id,
        listingId: listingCampaigns.listingId,
        externalCampaignId:
          listingCampaigns.externalCampaignId,
        campaignName:
          listingCampaigns.campaignName,
        campaignType:
          listingCampaigns.campaignType,
        marketplace:
          listingCampaigns.marketplace,
        desiredPriceMinor:
          listingCampaigns.desiredPriceMinor,
        remotePriceMinor:
          listingCampaigns.remotePriceMinor,
        referencePriceMinor:
          listingCampaigns.referencePriceMinor,
        dedicatedStock:
          listingCampaigns.dedicatedStock,
        priceLocked:
          listingCampaigns.priceLocked,
        autoSync:
          listingCampaigns.autoSync,
        applicationStatus:
          listingCampaigns.applicationStatus,
        campaignStatus:
          listingCampaigns.campaignStatus,
        validFrom:
          listingCampaigns.validFrom,
        validTo:
          listingCampaigns.validTo,
        lastSyncedAt:
          listingCampaigns.lastSyncedAt,
        createdAt:
          listingCampaigns.createdAt,
        updatedAt:
          listingCampaigns.updatedAt,
      })
      .from(listingCampaigns)
      .where(
        eq(
          listingCampaigns.listingId,
          listingId,
        ),
      )

    return context.json({
      status: 'ok',
      data: campaigns,
    })
  } catch (error) {
    console.error(
      'Campaign loading failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not load campaigns',
      },
      500,
    )
  }
})
app.post('/allegro/listings/:id/campaigns', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId = context.req.param('id')

    const body = await context.req.json<{
      campaignName?: string
      campaignType?: string
      desiredPrice?: number
      validFrom?: string
      validTo?: string
    }>()

    const campaignName =
      body.campaignName?.trim() || null

    if (!campaignName) {
      return context.json(
        {
          status: 'error',
          message: 'Campaign name is required',
        },
        400,
      )
    }

    const campaignType =
      body.campaignType?.toUpperCase() ?? 'DISCOUNT'

    const allowedCampaignTypes = [
      'STANDARD',
      'DISCOUNT',
      'SOURCING',
      'OTHER',
    ] as const

    if (
      !allowedCampaignTypes.includes(
        campaignType as
          (typeof allowedCampaignTypes)[number],
      )
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid campaign type',
        },
        400,
      )
    }

    const desiredPrice = Number(body.desiredPrice)

    if (
      !Number.isFinite(desiredPrice) ||
      desiredPrice < 0
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid campaign price',
        },
        400,
      )
    }

    const validFrom = body.validFrom
      ? new Date(body.validFrom)
      : null

    const validTo = body.validTo
      ? new Date(body.validTo)
      : null

    if (
      validFrom &&
      Number.isNaN(validFrom.getTime())
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid campaign start date',
        },
        400,
      )
    }

    if (
      validTo &&
      Number.isNaN(validTo.getTime())
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid campaign end date',
        },
        400,
      )
    }

    if (
      validFrom &&
      validTo &&
      validTo <= validFrom
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'Campaign end date must be after start date',
        },
        400,
      )
    }

    const [listing] = await db
      .select({
        id: platformListings.id,
        marketplace: platformListings.marketplace,
      })
      .from(platformListings)
      .where(
        eq(
          platformListings.id,
          listingId,
        ),
      )
      .limit(1)

    if (!listing) {
      return context.json(
        {
          status: 'error',
          message: 'Listing not found',
        },
        404,
      )
    }

    const now = new Date()

    const externalCampaignId =
      `LOCAL-${randomUUID()}`

    const [createdCampaign] = await db
      .insert(campaigns)
      .values({
        externalCampaignId,

        name: campaignName,

        campaignType:
          campaignType as
            | 'STANDARD'
            | 'DISCOUNT'
            | 'SOURCING'
            | 'OTHER',

        marketplace:
          listing.marketplace,

        status: 'DRAFT',

        validFrom,
        validTo,

        autoSync: false,

        createdAt: now,
        updatedAt: now,
      })
      .returning()

    const [createdListingCampaign] = await db
      .insert(listingCampaigns)
      .values({
        campaignId:
          createdCampaign.id,

        listingId,

        externalCampaignId,

        campaignName,

        campaignType:
          campaignType as
            | 'STANDARD'
            | 'DISCOUNT'
            | 'SOURCING'
            | 'OTHER',

        marketplace:
          listing.marketplace,

        desiredPriceMinor:
          Math.round(desiredPrice * 100),

        priceLocked: true,
        autoSync: false,

        campaignStatus: 'DRAFT',

        validFrom,
        validTo,

        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return context.json(
      {
        status: 'ok',
        data: {
          campaign: createdCampaign,
          listingCampaign:
            createdListingCampaign,
        },
      },
      201,
    )
  } catch (error) {
    console.error(
      'Campaign creation failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not create campaign',
      },
      500,
    )
  }
})
app.get(
  '/allegro/listing-price-schedules',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const listingId =
        context.req.query('listingId')?.trim()

      const rows = listingId
        ? await db
            .select({
              id: listingPriceSchedules.id,
              listingId:
                listingPriceSchedules.listingId,

              promotionalPriceMinor:
                listingPriceSchedules
                  .promotionalPriceMinor,

              validFrom:
                listingPriceSchedules.validFrom,

              validTo:
                listingPriceSchedules.validTo,

              enabled:
                listingPriceSchedules.enabled,

              startAppliedAt:
                listingPriceSchedules
                  .startAppliedAt,

              endAppliedAt:
                listingPriceSchedules.endAppliedAt,

              lastError:
                listingPriceSchedules.lastError,

              createdAt:
                listingPriceSchedules.createdAt,

              updatedAt:
                listingPriceSchedules.updatedAt,
            })
            .from(listingPriceSchedules)
            .where(
              eq(
                listingPriceSchedules.listingId,
                listingId,
              ),
            )
        : await db
            .select({
              id: listingPriceSchedules.id,
              listingId:
                listingPriceSchedules.listingId,

              promotionalPriceMinor:
                listingPriceSchedules
                  .promotionalPriceMinor,

              validFrom:
                listingPriceSchedules.validFrom,

              validTo:
                listingPriceSchedules.validTo,

              enabled:
                listingPriceSchedules.enabled,

              startAppliedAt:
                listingPriceSchedules
                  .startAppliedAt,

              endAppliedAt:
                listingPriceSchedules.endAppliedAt,

              lastError:
                listingPriceSchedules.lastError,

              createdAt:
                listingPriceSchedules.createdAt,

              updatedAt:
                listingPriceSchedules.updatedAt,
            })
            .from(listingPriceSchedules)

      const now = Date.now()

      const data = rows.map((row) => {
        let scheduleStatus:
          | 'SCHEDULED'
          | 'ACTIVE'
          | 'EXPIRED'
          | 'DISABLED'

        if (!row.enabled) {
          scheduleStatus = 'DISABLED'
        } else if (
          now < row.validFrom.getTime()
        ) {
          scheduleStatus = 'SCHEDULED'
        } else if (
          now <= row.validTo.getTime()
        ) {
          scheduleStatus = 'ACTIVE'
        } else {
          scheduleStatus = 'EXPIRED'
        }

        return {
          ...row,
          scheduleStatus,
        }
      })

      return context.json({
        status: 'ok',
        count: data.length,
        data,
      })
    } catch (error) {
      console.error(
        'Listing price schedule loading failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not load listing price schedules',
        },
        500,
      )
    }
  },
)


app.post(
  '/allegro/listing-price-schedules',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const body = (await context.req
        .json()
        .catch(() => null)) as
        | {
            listingId?: unknown
            promotionalPrice?: unknown
            validFrom?: unknown
            validTo?: unknown
            enabled?: unknown
          }
        | null

      const listingId =
        typeof body?.listingId === 'string'
          ? body.listingId.trim()
          : ''

      const promotionalPrice = Number(
        body?.promotionalPrice,
      )

      const validFrom =
        typeof body?.validFrom === 'string'
          ? new Date(body.validFrom)
          : null

      const validTo =
        typeof body?.validTo === 'string'
          ? new Date(body.validTo)
          : null

      const enabled =
        body?.enabled === undefined
          ? true
          : body.enabled

      if (!listingId) {
        return context.json(
          {
            status: 'error',
            message: 'listingId is required',
          },
          400,
        )
      }

      if (
        !Number.isFinite(promotionalPrice) ||
        promotionalPrice <= 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Promotional price must be greater than zero',
          },
          400,
        )
      }

      if (
        !validFrom ||
        Number.isNaN(validFrom.getTime())
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Invalid validFrom date',
          },
          400,
        )
      }

      if (
        !validTo ||
        Number.isNaN(validTo.getTime())
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Invalid validTo date',
          },
          400,
        )
      }

      if (validFrom >= validTo) {
        return context.json(
          {
            status: 'error',
            message:
              'The end of the promotional period must be later than the start',
          },
          400,
        )
      }

      if (typeof enabled !== 'boolean') {
        return context.json(
          {
            status: 'error',
            message: 'enabled must be a boolean',
          },
          400,
        )
      }

      const [listing] = await db
        .select({
          id: platformListings.id,

          marketplace:
            platformListings.marketplace,

          regularPriceMinor:
            listingDesiredStates
              .regularPriceMinor,
        })
        .from(platformListings)
        .leftJoin(
          listingDesiredStates,
          eq(
            listingDesiredStates.listingId,
            platformListings.id,
          ),
        )
        .where(
          eq(platformListings.id, listingId),
        )
        .limit(1)

      if (!listing) {
        return context.json(
          {
            status: 'error',
            message: 'Listing was not found',
          },
          404,
        )
      }

      if (
        listing.marketplace !== 'allegro-hu'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Only allegro-hu listings are supported',
          },
          400,
        )
      }

      if (
        listing.regularPriceMinor === null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Regular desired price is missing',
          },
          400,
        )
      }

      const promotionalPriceMinor =
        Math.round(promotionalPrice * 100)

      if (
        promotionalPriceMinor >=
        listing.regularPriceMinor
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Promotional price must be lower than the regular desired price',
          },
          400,
        )
      }

      if (enabled) {
        const existingSchedules =
          await db
            .select({
              id: listingPriceSchedules.id,

              validFrom:
                listingPriceSchedules.validFrom,

              validTo:
                listingPriceSchedules.validTo,
            })
            .from(listingPriceSchedules)
            .where(
              and(
                eq(
                  listingPriceSchedules
                    .listingId,
                  listingId,
                ),
                eq(
                  listingPriceSchedules.enabled,
                  true,
                ),
              ),
            )

        const overlapping =
          existingSchedules.some(
            (schedule) =>
              schedule.validTo > new Date() &&
              validFrom < schedule.validTo &&
              validTo > schedule.validFrom,
          )

        if (overlapping) {
          return context.json(
            {
              status: 'error',
              message:
                'The promotional period overlaps another enabled price schedule',
            },
            409,
          )
        }
      }

      const now = new Date()

      const [created] = await db
        .insert(listingPriceSchedules)
        .values({
          listingId,

          promotionalPriceMinor,

          validFrom,
          validTo,

          enabled,

          createdAt: now,
          updatedAt: now,
        })
        .returning()

      return context.json(
        {
          status: 'ok',
          data: created,
        },
        201,
      )
    } catch (error) {
      console.error(
        'Listing price schedule creation failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not create listing price schedule',
        },
        500,
      )
    }
  },
)


app.patch(
  '/allegro/listing-price-schedules/:id',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const scheduleId =
        context.req.param('id')

      const body = (await context.req
        .json()
        .catch(() => null)) as
        | {
            promotionalPrice?: unknown
            validFrom?: unknown
            validTo?: unknown
            enabled?: unknown
          }
        | null

      if (!body) {
        return context.json(
          {
            status: 'error',
            message: 'Request body is required',
          },
          400,
        )
      }

      const [existing] = await db
        .select()
        .from(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.id,
            scheduleId,
          ),
        )
        .limit(1)

      if (!existing) {
        return context.json(
          {
            status: 'error',
            message:
              'Price schedule was not found',
          },
          404,
        )
      }

      if (
        existing.startAppliedAt !== null ||
        existing.endAppliedAt !== null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'An already applied schedule cannot be edited',
          },
          409,
        )
      }

      const promotionalPrice =
        body.promotionalPrice === undefined
          ? existing.promotionalPriceMinor /
            100
          : Number(body.promotionalPrice)

      const validFrom =
        body.validFrom === undefined
          ? existing.validFrom
          : typeof body.validFrom === 'string'
            ? new Date(body.validFrom)
            : null

      const validTo =
        body.validTo === undefined
          ? existing.validTo
          : typeof body.validTo === 'string'
            ? new Date(body.validTo)
            : null

      const enabled =
        body.enabled === undefined
          ? existing.enabled
          : body.enabled

      if (
        !Number.isFinite(promotionalPrice) ||
        promotionalPrice <= 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Promotional price must be greater than zero',
          },
          400,
        )
      }

      if (
        !validFrom ||
        Number.isNaN(validFrom.getTime())
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Invalid validFrom date',
          },
          400,
        )
      }

      if (
        !validTo ||
        Number.isNaN(validTo.getTime())
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Invalid validTo date',
          },
          400,
        )
      }

      if (validFrom >= validTo) {
        return context.json(
          {
            status: 'error',
            message:
              'The end of the promotional period must be later than the start',
          },
          400,
        )
      }

      if (typeof enabled !== 'boolean') {
        return context.json(
          {
            status: 'error',
            message: 'enabled must be a boolean',
          },
          400,
        )
      }

      const [desiredState] = await db
        .select({
          regularPriceMinor:
            listingDesiredStates
              .regularPriceMinor,
        })
        .from(listingDesiredStates)
        .where(
          eq(
            listingDesiredStates.listingId,
            existing.listingId,
          ),
        )
        .limit(1)

      if (
        !desiredState ||
        desiredState.regularPriceMinor ===
          null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Regular desired price is missing',
          },
          400,
        )
      }

      const promotionalPriceMinor =
        Math.round(promotionalPrice * 100)

      if (
        promotionalPriceMinor >=
        desiredState.regularPriceMinor
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Promotional price must be lower than the regular desired price',
          },
          400,
        )
      }

      if (enabled) {
        const schedules = await db
          .select({
            id: listingPriceSchedules.id,

            validFrom:
              listingPriceSchedules.validFrom,

            validTo:
              listingPriceSchedules.validTo,
          })
          .from(listingPriceSchedules)
          .where(
            and(
              eq(
                listingPriceSchedules
                  .listingId,
                existing.listingId,
              ),
              eq(
                listingPriceSchedules.enabled,
                true,
              ),
            ),
          )

        const overlapping =
          schedules.some(
            (schedule) =>
              schedule.id !== scheduleId &&
              schedule.validTo > new Date() &&
              validFrom < schedule.validTo &&
              validTo > schedule.validFrom,
          )

        if (overlapping) {
          return context.json(
            {
              status: 'error',
              message:
                'The promotional period overlaps another enabled price schedule',
            },
            409,
          )
        }
      }

      const [updated] = await db
        .update(listingPriceSchedules)
        .set({
          promotionalPriceMinor,

          validFrom,
          validTo,

          enabled,

          lastError: null,

          updatedAt: new Date(),
        })
        .where(
          eq(
            listingPriceSchedules.id,
            scheduleId,
          ),
        )
        .returning()

      return context.json({
        status: 'ok',
        data: updated,
      })
    } catch (error) {
      console.error(
        'Listing price schedule update failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not update listing price schedule',
        },
        500,
      )
    }
  },
)


app.delete(
  '/allegro/listing-price-schedules/:id',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const scheduleId =
        context.req.param('id')

      const [existing] = await db
        .select({
          id: listingPriceSchedules.id,

          startAppliedAt:
            listingPriceSchedules
              .startAppliedAt,

          endAppliedAt:
            listingPriceSchedules
              .endAppliedAt,
        })
        .from(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.id,
            scheduleId,
          ),
        )
        .limit(1)

      if (!existing) {
        return context.json(
          {
            status: 'error',
            message:
              'Price schedule was not found',
          },
          404,
        )
      }

      if (
        existing.startAppliedAt !== null ||
        existing.endAppliedAt !== null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'An already applied schedule cannot be deleted',
          },
          409,
        )
      }

      const [deleted] = await db
        .delete(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.id,
            scheduleId,
          ),
        )
        .returning({
          id: listingPriceSchedules.id,
        })

      return context.json({
        status: 'ok',
        data: deleted,
      })
    } catch (error) {
      console.error(
        'Listing price schedule deletion failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not delete listing price schedule',
        },
        500,
      )
    }
  },
)

app.post(
  '/allegro/listings/discard-desired-differences',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const now = new Date()

      const rows = await db
        .select({
          listingId:
            platformListings.id,

      sku:
        products.sku,

          priceMinor:
            listingRemoteStates.priceMinor,

          stockAvailable:
            listingRemoteStates.stockAvailable,

          publicationStatus:
            listingRemoteStates
              .publicationStatus,

          desiredPriceMinor:
            listingDesiredStates
              .regularPriceMinor,

          desiredStock:
            listingDesiredStates.desiredStock,

          desiredPublicationStatus:
            listingDesiredStates
              .desiredPublicationStatus,

          priceLocked:
            listingDesiredStates.priceLocked,

      stockAutoPaused:
        listingDesiredStates
          .stockAutoPaused,
        })
        .from(platformListings)
    .innerJoin(
      products,
      eq(
        products.id,
        platformListings.productId,
      ),
    )
        .leftJoin(
          listingRemoteStates,
          eq(
            listingRemoteStates.listingId,
            platformListings.id,
          ),
        )
        .innerJoin(
          listingDesiredStates,
          eq(
            listingDesiredStates.listingId,
            platformListings.id,
          ),
        )
        .where(
          eq(
            platformListings.marketplace,
            'allegro-hu',
          ),
        )

  const [activeInventoryConnection] =
    await db
      .select({
        id: dataConnections.id,
      })
      .from(dataConnections)
      .where(
        and(
          eq(
            dataConnections.purpose,
            'INVENTORY',
          ),
          eq(
            dataConnections.isActive,
            true,
          ),
        ),
      )
      .limit(1)

  const activeInventoryItems =
    activeInventoryConnection
      ? await db
          .select({
            sku: inventorySourceItems.sku,
            stock: inventorySourceItems.stock,
          })
          .from(inventorySourceItems)
          .where(
            eq(
              inventorySourceItems.connectionId,
              activeInventoryConnection.id,
            ),
          )
      : []

  const inventoryStockBySku =
    new Map(
      activeInventoryItems.map(
        (item) => [
          item.sku,
          item.stock,
        ] as const,
      ),
    )

      const scheduleRows = await db
        .select({
          listingId:
            listingPriceSchedules.listingId,

          validFrom:
            listingPriceSchedules.validFrom,

          validTo:
            listingPriceSchedules.validTo,

          enabled:
            listingPriceSchedules.enabled,
        })
        .from(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.enabled,
            true,
          ),
        )

      const activeScheduleListingIds =
        new Set(
          scheduleRows
            .filter(
              (schedule) =>
                schedule.enabled &&
                schedule.validFrom <= now &&
                schedule.validTo >= now,
            )
            .map(
              (schedule) =>
                schedule.listingId,
            ),
        )

      const campaignRows = await db
        .select({
          listingId:
            listingCampaigns.listingId,

          validFrom:
            listingCampaigns.validFrom,

          validTo:
            listingCampaigns.validTo,
        })
        .from(listingCampaigns)
        .where(
          and(
            eq(
              listingCampaigns.campaignType,
              'DISCOUNT',
            ),
            eq(
              listingCampaigns.campaignStatus,
              'ACTIVE',
            ),
          ),
        )

      const activeCampaignListingIds =
        new Set(
          campaignRows
            .filter(
              (campaign) =>
                (
                  !campaign.validFrom ||
                  campaign.validFrom <= now
                ) &&
                (
                  !campaign.validTo ||
                  campaign.validTo >= now
                ),
            )
            .map(
              (campaign) =>
                campaign.listingId,
            ),
        )

      let updated = 0
      let protectedPrices = 0

      for (const row of rows) {
        const priceProtected =
          activeScheduleListingIds.has(
            row.listingId,
          ) ||
          activeCampaignListingIds.has(
            row.listingId,
          )

    let nextPublicationStatus =
      row.desiredPublicationStatus

    if (row.stockAutoPaused) {
      nextPublicationStatus = 'INACTIVE'
    } else if (
      row.publicationStatus === 'ACTIVE' ||
      row.publicationStatus ===
        'ACTIVATING'
    ) {
      nextPublicationStatus = 'ACTIVE'
    } else if (
      row.publicationStatus ===
        'INACTIVE' ||
      row.publicationStatus === 'ENDED'
    ) {
      nextPublicationStatus = 'INACTIVE'
    }

        const nextPriceMinor =
          priceProtected
            ? row.desiredPriceMinor
            : (
                row.priceMinor ??
                row.desiredPriceMinor
              )

    const nextStock =
      activeInventoryConnection
        ? (
            inventoryStockBySku.get(
              row.sku,
            ) ?? 0
          )
        : row.stockAutoPaused
          ? 0
          : (
              row.stockAvailable ??
              row.desiredStock
            )

        const priceChanged =
          nextPriceMinor !==
          row.desiredPriceMinor

        const stockChanged =
          nextStock !== row.desiredStock

        const publicationChanged =
          nextPublicationStatus !==
          row.desiredPublicationStatus

        if (
          priceProtected &&
          row.priceMinor !==
            row.desiredPriceMinor
        ) {
          protectedPrices += 1
        }

        if (
          !priceChanged &&
          !stockChanged &&
          !publicationChanged
        ) {
          continue
        }

        await db
          .update(listingDesiredStates)
          .set({
            regularPriceMinor:
              nextPriceMinor,

            desiredStock:
              nextStock,

            desiredPublicationStatus:
              nextPublicationStatus,

            priceLocked:
              priceProtected
                ? row.priceLocked
                : false,

            stockLocked: false,

            updatedBy:
              'COMMERCE_HUB_DISCARD',

            updatedAt: now,
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        updated += 1
      }

      return context.json({
        status: 'ok',
        updated,
        protectedPrices,
      })
    } catch (error) {
      console.error(
        'Discarding desired differences failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not discard desired differences',
        },
        500,
      )
    }
  },
)


app.patch('/allegro/listings/:id/desired-price', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId = context.req.param('id')
    const body = await context.req.json<{
      desiredPrice: number
    }>()

    const desiredPrice = Number(body.desiredPrice)

    if (
      !Number.isFinite(desiredPrice) ||
      desiredPrice < 0
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid desired price',
        },
        400,
      )
    }

    const desiredPriceMinor =
      Math.round(desiredPrice * 100)

    const [updated] = await db
      .update(listingDesiredStates)
      .set({
        regularPriceMinor: desiredPriceMinor,
        priceLocked: true,
        updatedBy: 'COMMERCE_HUB_UI',
        updatedAt: new Date(),
      })
      .where(
        eq(
          listingDesiredStates.listingId,
          listingId,
        ),
      )
      .returning({
        listingId: listingDesiredStates.listingId,
        desiredPriceMinor:
          listingDesiredStates.regularPriceMinor,
        priceLocked:
          listingDesiredStates.priceLocked,
        updatedBy:
          listingDesiredStates.updatedBy,
        updatedAt:
          listingDesiredStates.updatedAt,
      })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message: 'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Desired price update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not update desired price',
      },
      500,
    )
  }
})

app.patch('/allegro/listings/:id/price-lock', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId =
      context.req.param('id')

    const body =
      await context.req.json<{
        priceLocked?: boolean
      }>()

    if (
      typeof body.priceLocked !==
      'boolean'
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'priceLocked must be boolean',
        },
        400,
      )
    }

    const [updated] =
      await db
        .update(
          listingDesiredStates,
        )
        .set({
          priceLocked:
            body.priceLocked,

          updatedBy:
            'COMMERCE_HUB_UI',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates
              .listingId,
            listingId,
          ),
        )
        .returning({
          listingId:
            listingDesiredStates
              .listingId,

          desiredPriceMinor:
            listingDesiredStates
              .regularPriceMinor,

          priceLocked:
            listingDesiredStates
              .priceLocked,

          updatedBy:
            listingDesiredStates
              .updatedBy,

          updatedAt:
            listingDesiredStates
              .updatedAt,
        })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message:
            'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Price lock update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not update price lock',
      },
      500,
    )
  }
})

app.patch('/allegro/listings/:id/desired-stock', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId = context.req.param('id')

    const body = await context.req.json<{
      desiredStock: number
    }>()

    const desiredStock = Number(body.desiredStock)

    if (
      !Number.isInteger(desiredStock) ||
      desiredStock < 0
    ) {
      return context.json(
        {
          status: 'error',
          message: 'Invalid desired stock',
        },
        400,
      )
    }

    const [updated] = await db
      .update(listingDesiredStates)
      .set({
        desiredStock,
        stockLocked: true,
        updatedBy: 'COMMERCE_HUB_UI',
        updatedAt: new Date(),
      })
      .where(
        eq(
          listingDesiredStates.listingId,
          listingId,
        ),
      )
      .returning({
        listingId: listingDesiredStates.listingId,
        desiredStock:
          listingDesiredStates.desiredStock,
        stockLocked:
          listingDesiredStates.stockLocked,
        updatedBy:
          listingDesiredStates.updatedBy,
        updatedAt:
          listingDesiredStates.updatedAt,
      })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message: 'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Desired stock update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not update desired stock',
      },
      500,
    )
  }
})

app.patch('/allegro/listings/:id/stock-lock', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId =
      context.req.param('id')

    const body =
      await context.req.json<{
        stockLocked?: boolean
      }>()

    if (
      typeof body.stockLocked !==
      'boolean'
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'stockLocked must be boolean',
        },
        400,
      )
    }

    const [updated] =
      await db
        .update(
          listingDesiredStates,
        )
        .set({
          stockLocked:
            body.stockLocked,

          updatedBy:
            'COMMERCE_HUB_UI',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates
              .listingId,
            listingId,
          ),
        )
        .returning({
          listingId:
            listingDesiredStates
              .listingId,

          desiredStock:
            listingDesiredStates
              .desiredStock,

          stockLocked:
            listingDesiredStates
              .stockLocked,

          updatedBy:
            listingDesiredStates
              .updatedBy,

          updatedAt:
            listingDesiredStates
              .updatedAt,
        })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message:
            'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Stock lock update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not update stock lock',
      },
      500,
    )
  }
})

app.patch('/allegro/listings/:id/auto-stock-sync', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId =
      context.req.param('id')

    const body =
      await context.req.json<{
        autoStockSync?: boolean
      }>()

    if (
      typeof body.autoStockSync !==
      'boolean'
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'autoStockSync must be boolean',
        },
        400,
      )
    }

    const [updated] =
      await db
        .update(
          listingDesiredStates,
        )
        .set({
          autoStockSync:
            body.autoStockSync,

          updatedBy:
            'COMMERCE_HUB_UI',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates
              .listingId,
            listingId,
          ),
        )
        .returning({
          listingId:
            listingDesiredStates
              .listingId,

          autoStockSync:
            listingDesiredStates
              .autoStockSync,

          stockLocked:
            listingDesiredStates
              .stockLocked,

          desiredStock:
            listingDesiredStates
              .desiredStock,

          updatedBy:
            listingDesiredStates
              .updatedBy,

          updatedAt:
            listingDesiredStates
              .updatedAt,
        })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message:
            'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Auto stock sync update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not update auto stock sync',
      },
      500,
    )
  }
})

app.patch('/allegro/listings/:id/desired-status', async (context) => {
  if (!db) {
    return context.json(
      {
        status: 'error',
        message: 'Database is not configured',
      },
      500,
    )
  }

  try {
    const listingId = context.req.param('id')

    const body = await context.req.json<{
      desiredStatus?: string
    }>()

    const desiredStatus =
      body.desiredStatus?.toUpperCase()

    if (
      desiredStatus !== 'ACTIVE' &&
      desiredStatus !== 'INACTIVE'
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'Desired status must be ACTIVE or INACTIVE',
        },
        400,
      )
    }

    const [updated] = await db
      .update(listingDesiredStates)
      .set({
        desiredPublicationStatus:
          desiredStatus,

        updatedBy: 'COMMERCE_HUB_UI',
        updatedAt: new Date(),
      })
      .where(
        eq(
          listingDesiredStates.listingId,
          listingId,
        ),
      )
      .returning({
        listingId:
          listingDesiredStates.listingId,

        desiredPublicationStatus:
          listingDesiredStates.desiredPublicationStatus,

        updatedBy:
          listingDesiredStates.updatedBy,

        updatedAt:
          listingDesiredStates.updatedAt,
      })

    if (!updated) {
      return context.json(
        {
          status: 'error',
          message: 'Desired state was not found',
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      data: updated,
    })
  } catch (error) {
    console.error(
      'Desired publication status update failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not update desired publication status',
      },
      500,
    )
  }
})
app.post(
  '/allegro/remote-campaigns/:campaignId/finish',
  async (context) => {
    if (!db) {
      return context.json(
        {
          status: 'error',
          message: 'Database is not configured',
        },
        500,
      )
    }

    try {
      const externalCampaignId =
        context.req.param('campaignId')

      const body = await context.req.json<{
        listingIds?: string[]
      }>()

      const listingIds =
        body.listingIds ?? []

      if (listingIds.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'At least one listing is required',
          },
          400,
        )
      }

      const results: Array<{
        listingId: string
        offerId?: string
        status: string
        operationId?: string | null
        error?: string
      }> = []

      for (const listingId of listingIds) {
        const [preparation] = await db
          .select({
            id:
              listingCampaigns.id,

            listingId:
              listingCampaigns.listingId,

            externalCampaignId:
              listingCampaigns.externalCampaignId,

            externalApplicationId:
              listingCampaigns.externalApplicationId,

            applicationStatus:
              listingCampaigns.applicationStatus,

            campaignStatus:
              listingCampaigns.campaignStatus,

            validTo:
              listingCampaigns.validTo,

            finishOperationId:
              listingCampaigns.finishOperationId,

            finishRetryAfter:
              listingCampaigns.finishRetryAfter,

            finishRetryCount:
              listingCampaigns.finishRetryCount,

            offerId:
              platformListings.externalListingId,
          })
          .from(listingCampaigns)
          .innerJoin(
            platformListings,
            eq(
              platformListings.id,
              listingCampaigns.listingId,
            ),
          )
          .where(
            and(
              eq(
                listingCampaigns.externalCampaignId,
                externalCampaignId,
              ),
              eq(
                listingCampaigns.listingId,
                listingId,
              ),
            ),
          )
          .limit(1)

        if (!preparation) {
          results.push({
            listingId,
            status: 'FAILED',
            error:
              'Campaign preparation not found',
          })

          continue
        }

        if (
          preparation.campaignStatus ===
          'FINISHED'
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FINISHED',
            operationId:
              preparation.finishOperationId,
          })

          continue
        }

        if (
          preparation.finishOperationId &&
          preparation.campaignStatus ===
            'FINISHING'
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FINISHING',
            operationId:
              preparation.finishOperationId,
          })

          continue
        }

        if (
          !preparation.externalApplicationId
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error:
              'Campaign application was never submitted successfully',
          })

          continue
        }

        if (
          preparation.applicationStatus !==
          'PROCESSED'
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error:
              `Campaign application is not active. Current status: ${preparation.applicationStatus ?? 'UNKNOWN'}`,
          })

          continue
        }

        if (!preparation.validTo) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error:
              'Campaign end time is missing',
          })

          continue
        }

        const finishingAt =
          new Date()

        if (
          preparation.campaignStatus ===
            'FINISH_FAILED' &&
          preparation.finishRetryCount >= 5
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error:
              'Maximum campaign finish retry count reached',
          })

          continue
        }

        if (
          preparation.finishRetryAfter &&
          finishingAt <
            preparation.finishRetryAfter
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'NOT_DUE',
            error:
              `Finish retry scheduled for: ${preparation.finishRetryAfter.toISOString()}`,
          })

          continue
        }

        if (
          finishingAt <
          preparation.validTo
        ) {
          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'NOT_DUE',
            error:
              `Not due yet. Scheduled until: ${preparation.validTo.toISOString()}`,
          })

          continue
        }

        await db
          .update(listingCampaigns)
          .set({
            campaignStatus:
              'FINISHING',

            finishError: null,

            finishRetryAfter: null,

            updatedAt:
              finishingAt,
          })
          .where(
            eq(
              listingCampaigns.id,
              preparation.id,
            ),
          )

        try {
          const result =
            await finishOfferAllegroCampaign(
              {
                campaignId:
                  preparation.externalCampaignId,

                offerId:
                  preparation.offerId,
              },
            )

          if (!result.ok) {
            const errorText =
              typeof result.data === 'string'
                ? result.data
                : JSON.stringify(
                    result.data,
                  )

            await db
              .update(listingCampaigns)
              .set({
                campaignStatus:
                  'FINISH_FAILED',

                finishError:
                  errorText,

                finishRetryCount:
                  preparation.finishRetryCount + 1,

                finishRetryAfter:
                  preparation.finishRetryCount + 1 >= 5
                    ? null
                    : new Date(
                        Date.now() +
                          [5, 15, 30, 60][
                            preparation.finishRetryCount
                          ] *
                            60 *
                            1000,
                      ),

                lastSyncedAt:
                  new Date(),

                updatedAt:
                  new Date(),
              })
              .where(
                eq(
                  listingCampaigns.id,
                  preparation.id,
                ),
              )

            results.push({
              listingId,
              offerId:
                preparation.offerId,
              status: 'FAILED',
              error:
                errorText,
            })

            continue
          }

          const responseData =
            result.data &&
            typeof result.data === 'object'
              ? result.data
              : null

          const operationId =
            responseData &&
            'id' in responseData &&
            typeof responseData.id ===
              'string'
              ? responseData.id
              : null

          if (!operationId) {
            const errorText =
              'Allegro accepted the finish request but did not return an operation ID'

            await db
              .update(listingCampaigns)
              .set({
                campaignStatus:
                  'FINISH_FAILED',

                finishError:
                  errorText,

                finishRetryCount:
                  preparation.finishRetryCount + 1,

                finishRetryAfter:
                  preparation.finishRetryCount + 1 >= 5
                    ? null
                    : new Date(
                        Date.now() +
                          [5, 15, 30, 60][
                            preparation.finishRetryCount
                          ] *
                            60 *
                            1000,
                      ),

                lastSyncedAt:
                  new Date(),

                updatedAt:
                  new Date(),
              })
              .where(
                eq(
                  listingCampaigns.id,
                  preparation.id,
                ),
              )

            results.push({
              listingId,
              offerId:
                preparation.offerId,
              status: 'FAILED',
              error:
                errorText,
            })

            continue
          }

          await db
            .update(listingCampaigns)
            .set({
              finishOperationId:
                operationId,

              campaignStatus:
                'FINISHING',

              finishError: null,

              finishRetryAfter: null,
              finishRetryCount:
                preparation.finishRetryCount,

              lastSyncedAt:
                new Date(),

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
            )

          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FINISHING',
            operationId,
          })
        } catch (error) {
          const errorText =
            error instanceof Error
              ? error.message
              : 'Unknown campaign finish error'

          await db
            .update(listingCampaigns)
            .set({
              campaignStatus:
                'FINISH_FAILED',

              finishError:
                errorText,

              finishRetryCount:
                preparation.finishRetryCount + 1,

              finishRetryAfter:
                preparation.finishRetryCount + 1 >= 5
                  ? null
                  : new Date(
                      Date.now() +
                        [5, 15, 30, 60][
                          preparation.finishRetryCount
                        ] *
                          60 *
                          1000,
                    ),

              lastSyncedAt:
                new Date(),

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                preparation.id,
              ),
            )

          results.push({
            listingId,
            offerId:
              preparation.offerId,
            status: 'FAILED',
            error:
              errorText,
          })
        }
      }

      const failed =
        results.filter(
          (result) =>
            result.status === 'FAILED',
        ).length

      const notDue =
        results.filter(
          (result) =>
            result.status === 'NOT_DUE',
        ).length

      const accepted =
        results.length -
        failed -
        notDue

      return context.json({
        status:
          failed === results.length
            ? 'error'
            : failed > 0
              ? 'partial'
              : 'ok',

        count:
          results.length,

        accepted,
        failed,
        notDue,

        data:
          results,
      })
    } catch (error) {
      console.error(
        'Campaign finish failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not finish campaign listings',
        },
        500,
      )
    }
  },
)
let campaignApplicationProcessorRunning = false

async function processPendingCampaignApplications() {
  if (!db || campaignApplicationProcessorRunning) {
    return
  }

  campaignApplicationProcessorRunning = true

  try {
    const pendingRows = await db
      .select({
        id:
          listingCampaigns.id,

        listingId:
          listingCampaigns.listingId,

        externalCampaignId:
          listingCampaigns.externalCampaignId,

        externalApplicationId:
          listingCampaigns.externalApplicationId,

        applicationStatus:
          listingCampaigns.applicationStatus,

        campaignStatus:
          listingCampaigns.campaignStatus,


        validTo:
          listingCampaigns.validTo,
      })
      .from(listingCampaigns)
      .where(
        or(
          eq(
            listingCampaigns.applicationStatus,
            'REQUESTED',
          ),
          and(
            eq(
              listingCampaigns.applicationStatus,
              'PROCESSED',
            ),
            or(
              eq(
                listingCampaigns.campaignStatus,
                'AWAITING_BADGE',
              ),
              eq(
                listingCampaigns.campaignStatus,
                'IN_VERIFICATION',
              ),
              eq(
                listingCampaigns.campaignStatus,
                'WAITING_FOR_PUBLICATION',
              ),
              eq(
                listingCampaigns.campaignStatus,
                'FINISH_FAILED',
              ),
            ),
          ),
        ),
      )

    for (const row of pendingRows) {
      if (!row.externalApplicationId) {
        continue
      }

      try {
        const application =
          await getAllegroBadgeApplication(
            row.externalApplicationId,
          )

        const remoteStatus =
          application.process.status

        if (remoteStatus === 'REQUESTED') {
          continue
        }

        if (remoteStatus === 'PROCESSED') {
          const badges =
            await getAllegroBadges({
              offerId:
                application.offer.id,

              marketplaceId:
                'allegro-hu',
            })

          const badge =
            badges.badges.find(
              (item) =>
                item.offer.id ===
                  application.offer.id &&
                item.campaign.id ===
                  row.externalCampaignId,
            )

          const syncedAt =
            new Date()

          if (!badge) {
            if (
              row.campaignStatus ===
                'FINISH_FAILED'
            ) {
              continue
            }

            await db
              .update(listingCampaigns)
              .set({
                applicationStatus:
                  'PROCESSED',

                applicationError: null,

                campaignStatus:
                  'AWAITING_BADGE',

                retryAfter: null,
                retryCount: 0,

                lastSyncedAt:
                  syncedAt,

                updatedAt:
                  syncedAt,
              })
              .where(
                eq(
                  listingCampaigns.id,
                  row.id,
                ),
              )

            console.log(
              'Allegro campaign application processed, waiting for badge:',
              {
                campaignId:
                  row.externalCampaignId,

                listingId:
                  row.listingId,

                applicationId:
                  row.externalApplicationId,
              },
            )

            continue
          }

          const remoteBadgeStatus =
            badge.process.status

          const terminalBadge =
            remoteBadgeStatus ===
              'DECLINED' ||
            remoteBadgeStatus ===
              'FINISHED'

          if (
            row.campaignStatus ===
              'FINISH_FAILED' &&
            !terminalBadge
          ) {
            // A real ACTIVE badge with a transient
            // finish failure must keep its retry state.
            continue
          }

          const knownBadgeStatus =
            remoteBadgeStatus === 'ACTIVE' ||
            remoteBadgeStatus ===
              'IN_VERIFICATION' ||
            remoteBadgeStatus ===
              'WAITING_FOR_PUBLICATION' ||
            remoteBadgeStatus ===
              'FINISHED' ||
            remoteBadgeStatus ===
              'DECLINED'

          const nextCampaignStatus =
            knownBadgeStatus
              ? remoteBadgeStatus
              : 'AWAITING_BADGE'

          const remotePriceAmount =
            Number(
              badge.prices?.bargain
                ?.amount,
            )

          const referencePriceAmount =
            Number(
              badge.prices?.market
                ?.amount,
            )

          const remotePriceMinor =
            Number.isFinite(
              remotePriceAmount,
            )
              ? Math.round(
                  remotePriceAmount *
                    100,
                )
              : null

          const referencePriceMinor =
            Number.isFinite(
              referencePriceAmount,
            )
              ? Math.round(
                  referencePriceAmount *
                    100,
                )
              : null

          const badgeRejectionText =
            remoteBadgeStatus ===
              'DECLINED'
              ? badge.process
                  .rejectionReasons
                  .length > 0
                ? JSON.stringify(
                    badge.process
                      .rejectionReasons,
                  )
                : 'Allegro declined the campaign badge'
              : null


          const shouldRecordCampaignPrice =
            (
              remoteBadgeStatus ===
                'ACTIVE' ||
              remoteBadgeStatus ===
                'FINISHED'
            ) &&
            remotePriceMinor !== null

          if (shouldRecordCampaignPrice) {
            const [existingCampaignPriceHistory] =
              await db
                .select({
                  id:
                    listingPriceHistory.id,
                })
                .from(
                  listingPriceHistory,
                )
                .where(
                  and(
                    eq(
                      listingPriceHistory.listingId,
                      row.listingId,
                    ),
                    eq(
                      listingPriceHistory.externalCampaignId,
                      row.externalCampaignId,
                    ),
                    eq(
                      listingPriceHistory.priceType,
                      'PROMOTION',
                    ),
                    eq(
                      listingPriceHistory.priceMinor,
                      remotePriceMinor,
                    ),
                  ),
                )
                .limit(1)

            if (!existingCampaignPriceHistory) {
              const campaignObservedAt =
                remoteBadgeStatus ===
                  'FINISHED' &&
                row.validTo !== null &&
                row.validTo <= syncedAt
                  ? row.validTo
                  : syncedAt

              await db
                .insert(
                  listingPriceHistory,
                )
                .values({
                  listingId:
                    row.listingId,

                  priceMinor:
                    remotePriceMinor,

                  basePriceMinor:
                    referencePriceMinor,

                  priceType:
                    'PROMOTION',

                  externalCampaignId:
                    row.externalCampaignId,

                  currency:
                    badge.prices?.bargain
                      ?.currency ??
                    badge.prices?.market
                      ?.currency ??
                    'HUF',

                  source:
                    'ALLEGRO_CAMPAIGN',

                  observedAt:
                    campaignObservedAt,
                })

              console.log(
                'Allegro campaign price history recorded:',
                {
                  campaignId:
                    row.externalCampaignId,

                  listingId:
                    row.listingId,

                  priceMinor:
                    remotePriceMinor,

                  basePriceMinor:
                    referencePriceMinor,

                  observedAt:
                    campaignObservedAt,
                },
              )
            }
          }
          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                'PROCESSED',

              applicationError:
                badgeRejectionText,

              campaignStatus:
                nextCampaignStatus,

              ...(remotePriceMinor !==
              null
                ? {
                    remotePriceMinor,
                  }
                : {}),

              ...(referencePriceMinor !==
              null
                ? {
                    referencePriceMinor,
                  }
                : {}),

              retryAfter: null,
              retryCount: 0,

              ...(terminalBadge
                ? {
                    finishOperationId:
                      null,

                    finishError: null,

                    finishRetryAfter:
                      null,

                    finishRetryCount: 0,
                  }
                : {}),

              lastSyncedAt:
                syncedAt,

              updatedAt:
                syncedAt,
            })
            .where(
              eq(
                listingCampaigns.id,
                row.id,
              ),
            )

          if (row.campaignStatus !== nextCampaignStatus) {
            await db
              .insert(allegroChangeEvents)
              .values({
                listingId: row.listingId,
                eventType: 'CAMPAIGN',
                source: 'ALLEGRO_CAMPAIGN_SYNC',
                oldValue: row.campaignStatus,
                newValue: nextCampaignStatus,
                externalCampaignId:
                  row.externalCampaignId,
                metadataJson: badgeRejectionText,
                occurredAt: syncedAt,
              })
          }

          console.log(
            'Allegro campaign badge synchronized:',
            {
              campaignId:
                row.externalCampaignId,

              listingId:
                row.listingId,

              applicationId:
                row.externalApplicationId,

              badgeStatus:
                remoteBadgeStatus,

              remotePriceMinor,

              referencePriceMinor,

              rejectionReasons:
                badge.process
                  .rejectionReasons,
            },
          )

          continue
        }

        if (remoteStatus === 'DECLINED') {
          const rejectionText =
            application.process
              .rejectionReasons.length > 0
              ? JSON.stringify(
                  application.process
                    .rejectionReasons,
                )
              : 'Allegro declined the campaign application'

          const declinedAt = new Date()

          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                'DECLINED',

              applicationError:
                rejectionText,

              campaignStatus:
                'DECLINED',

              lastSyncedAt:
                declinedAt,

              updatedAt:
                declinedAt,
            })
            .where(
              eq(
                listingCampaigns.id,
                row.id,
              ),
            )

          if (row.campaignStatus !== 'DECLINED') {
            await db
              .insert(allegroChangeEvents)
              .values({
                listingId: row.listingId,
                eventType: 'CAMPAIGN',
                source: 'ALLEGRO_CAMPAIGN_SYNC',
                oldValue: row.campaignStatus,
                newValue: 'DECLINED',
                externalCampaignId:
                  row.externalCampaignId,
                metadataJson: rejectionText,
                occurredAt: declinedAt,
              })
          }

          console.warn(
            'Allegro campaign application declined:',
            {
              campaignId:
                row.externalCampaignId,

              listingId:
                row.listingId,

              applicationId:
                row.externalApplicationId,

              rejectionReasons:
                application.process
                  .rejectionReasons,
            },
          )

          continue
        }

        console.warn(
          'Unknown Allegro campaign application status:',
          {
            campaignId:
              row.externalCampaignId,

            listingId:
              row.listingId,

            applicationId:
              row.externalApplicationId,

            status:
              remoteStatus,
          },
        )
      } catch (error) {
        console.error(
          'Automatic Allegro campaign application check failed:',
          {
            campaignId:
              row.externalCampaignId,

            listingId:
              row.listingId,

            applicationId:
              row.externalApplicationId,

            error:
              error instanceof Error
                ? error.message
                : error,
          },
        )
      }
    }
  } finally {
    campaignApplicationProcessorRunning = false
  }
}
let campaignFinishProcessorRunning = false

async function processPendingCampaignFinishOperations() {
  if (!db || campaignFinishProcessorRunning) {
    return
  }

  campaignFinishProcessorRunning = true

  try {
    const pendingRows = await db
      .select({
        id:
          listingCampaigns.id,

        listingId:
          listingCampaigns.listingId,

        externalCampaignId:
          listingCampaigns.externalCampaignId,

        finishOperationId:
          listingCampaigns.finishOperationId,

        campaignStatus:
          listingCampaigns.campaignStatus,

        finishRetryAfter:
          listingCampaigns.finishRetryAfter,

        finishRetryCount:
          listingCampaigns.finishRetryCount,
      })
      .from(listingCampaigns)
      .where(
        eq(
          listingCampaigns.campaignStatus,
          'FINISHING',
        ),
      )

    for (const row of pendingRows) {
      if (!row.finishOperationId) {
        continue
      }

      try {
        const operation =
          await getAllegroBadgeOperation(
            row.finishOperationId,
          )

        const operationStatus =
          operation.process.status

        if (
          operationStatus === 'REQUESTED'
        ) {
          continue
        }

        if (
          operationStatus === 'PROCESSED'
        ) {
          const finishedAt = new Date()

          await db
            .update(listingCampaigns)
            .set({
              campaignStatus:
                'FINISHED',

              finishError: null,

              finishRetryAfter: null,
              finishRetryCount: 0,

              lastSyncedAt:
                finishedAt,

              updatedAt:
                finishedAt,
            })
            .where(
              eq(
                listingCampaigns.id,
                row.id,
              ),
            )

          await db
            .insert(allegroChangeEvents)
            .values({
              listingId: row.listingId,
              eventType: 'CAMPAIGN',
              source: 'ALLEGRO_CAMPAIGN_SYNC',
              oldValue: row.campaignStatus,
              newValue: 'FINISHED',
              externalCampaignId:
                row.externalCampaignId,
              occurredAt: finishedAt,
            })

          console.log(
            'Allegro campaign finish completed:',
            {
              campaignId:
                row.externalCampaignId,

              listingId:
                row.listingId,

              operationId:
                row.finishOperationId,
            },
          )

          continue
        }

        if (
          operationStatus === 'DECLINED'
        ) {
          const rejectionText =
            operation.process
              .rejectionReasons.length > 0
              ? JSON.stringify(
                  operation.process
                    .rejectionReasons,
                )
              : 'Allegro declined the campaign finish operation'

          const retryableFinishError =
            operation.process
              .rejectionReasons.some(
                (reason) =>
                  typeof reason === 'object' &&
                  reason !== null &&
                  'code' in reason &&
                  reason.code === 'BB0',
              )

          const nextRetryCount =
            retryableFinishError
              ? row.finishRetryCount + 1
              : row.finishRetryCount

          const retryDelaysMinutes =
            [5, 15, 30, 60]

          const nextRetryAfter =
            retryableFinishError &&
            nextRetryCount < 5
              ? new Date(
                  Date.now() +
                    retryDelaysMinutes[
                      row.finishRetryCount
                    ] *
                      60 *
                      1000,
                )
              : null

          await db
            .update(listingCampaigns)
            .set({
              finishOperationId: null,

              campaignStatus:
                'FINISH_FAILED',

              finishError:
                rejectionText,

              finishRetryCount:
                nextRetryCount,

              finishRetryAfter:
                nextRetryAfter,

              lastSyncedAt:
                new Date(),

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                row.id,
              ),
            )

          console.warn(
            'Allegro campaign finish declined:',
            {
              campaignId:
                row.externalCampaignId,

              listingId:
                row.listingId,

              operationId:
                row.finishOperationId,

              retryable:
                retryableFinishError,

              retryCount:
                nextRetryCount,

              retryAfter:
                nextRetryAfter,

              rejectionReasons:
                operation.process
                  .rejectionReasons,
            },
          )

          continue
        }
        console.warn(
          'Unknown Allegro finish operation status:',
          {
            campaignId:
              row.externalCampaignId,

            listingId:
              row.listingId,

            operationId:
              row.finishOperationId,

            status:
              operationStatus,
          },
        )
      } catch (error) {
        console.error(
          'Automatic Allegro finish operation check failed:',
          {
            campaignId:
              row.externalCampaignId,

            listingId:
              row.listingId,

            operationId:
              row.finishOperationId,

            error:
              error instanceof Error
                ? error.message
                : error,
          },
        )
      }
    }
  } finally {
    campaignFinishProcessorRunning = false
  }
}
let campaignFinishSchedulerRunning = false

async function processDueCampaignFinishes() {
  if (!db || campaignFinishSchedulerRunning) {
    return
  }

  campaignFinishSchedulerRunning = true

  try {
    const now = new Date()

    const activeRows = await db
      .select({
        listingId:
          listingCampaigns.listingId,

        externalCampaignId:
          listingCampaigns.externalCampaignId,

        validTo:
          listingCampaigns.validTo,

        applicationStatus:
          listingCampaigns.applicationStatus,

        campaignStatus:
          listingCampaigns.campaignStatus,

        finishRetryAfter:
          listingCampaigns.finishRetryAfter,

        finishRetryCount:
          listingCampaigns.finishRetryCount,
      })
      .from(listingCampaigns)
      .where(
        or(
          eq(
            listingCampaigns.campaignStatus,
            'ACTIVE',
          ),
          eq(
            listingCampaigns.campaignStatus,
            'FINISH_FAILED',
          ),
        ),
      )

    const dueRows =
      activeRows.filter(
        (row) =>
          row.applicationStatus ===
            'PROCESSED' &&
          row.validTo !== null &&
          row.validTo <= now &&
          (
            row.campaignStatus ===
              'ACTIVE' ||
            (
              row.campaignStatus ===
                'FINISH_FAILED' &&
              row.finishRetryCount < 5 &&
              row.finishRetryAfter !== null &&
              row.finishRetryAfter <= now
            )
          ),
      )

    if (dueRows.length === 0) {
      return
    }

    const campaignsToFinish =
      new Map<string, string[]>()

    for (const row of dueRows) {
      const listingIds =
        campaignsToFinish.get(
          row.externalCampaignId,
        ) ?? []

      listingIds.push(
        row.listingId,
      )

      campaignsToFinish.set(
        row.externalCampaignId,
        listingIds,
      )
    }

    for (
      const [
        campaignId,
        listingIds,
      ] of campaignsToFinish
    ) {
      const response =
        await app.request(
          `/allegro/remote-campaigns/${encodeURIComponent(
            campaignId,
          )}/finish`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              listingIds,
            }),
          },
        )

      let responseBody: unknown = null

      try {
        responseBody =
          await response.json()
      } catch {
        responseBody = null
      }

      if (!response.ok) {
        console.warn(
          'Automatic campaign finish failed:',
          {
            campaignId,
            status:
              response.status,
            response:
              responseBody,
          },
        )

        continue
      }

      console.log(
        'Automatic campaign finish processed:',
        {
          campaignId,
          listingCount:
            listingIds.length,
          response:
            responseBody,
        },
      )
    }
  } catch (error) {
    console.error(
      'Automatic Allegro campaign finish processing failed:',
      error,
    )
  } finally {
    campaignFinishSchedulerRunning = false
  }
}
let campaignSchedulerRunning = false

const CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT = 5

async function recoverStaleCampaignSubmissions() {
  if (!db) {
    return
  }

  const staleBefore =
    new Date(
      Date.now() -
        10 * 60 * 1000,
    )

  const submittingRows =
    await db
      .select({
        id:
          listingCampaigns.id,

        listingId:
          listingCampaigns.listingId,

        externalCampaignId:
          listingCampaigns.externalCampaignId,

        externalApplicationId:
          listingCampaigns.externalApplicationId,

        updatedAt:
          listingCampaigns.updatedAt,

        offerId:
          platformListings.externalListingId,
      })
      .from(listingCampaigns)
      .innerJoin(
        platformListings,
        eq(
          platformListings.id,
          listingCampaigns.listingId,
        ),
      )
      .where(
        eq(
          listingCampaigns.applicationStatus,
          'SUBMITTING',
        ),
      )

  const staleRows =
    submittingRows.filter(
      (row) =>
        row.externalApplicationId === null &&
        row.updatedAt <= staleBefore,
    )

  for (const row of staleRows) {
    try {
      const applications =
        await getAllegroBadgeApplicationsForOffer(
          row.offerId,
        )

      const matchingApplications =
        applications
          .filter(
            (application) =>
              application.campaign.id ===
                row.externalCampaignId &&
              application.offer.id ===
                row.offerId,
          )
          .sort(
            (left, right) =>
              new Date(
                right.createdAt,
              ).getTime() -
              new Date(
                left.createdAt,
              ).getTime(),
          )

      const matchingApplication =
        matchingApplications[0]

      const recoveredAt =
        new Date()

      if (matchingApplication) {
        const rejectionText =
          matchingApplication.process
            .status === 'DECLINED' &&
          matchingApplication.process
            .rejectionReasons.length > 0
            ? JSON.stringify(
                matchingApplication.process
                  .rejectionReasons,
              )
            : null

        await db
          .update(listingCampaigns)
          .set({
            externalApplicationId:
              matchingApplication.id,

            applicationStatus:
              matchingApplication.process
                .status,

            applicationError:
              rejectionText,

            lastSyncedAt:
              recoveredAt,

            updatedAt:
              recoveredAt,
          })
          .where(
            and(
              eq(
                listingCampaigns.id,
                row.id,
              ),
              eq(
                listingCampaigns.applicationStatus,
                'SUBMITTING',
              ),
            ),
          )

        console.log(
          'Recovered stale Allegro campaign submission:',
          {
            campaignId:
              row.externalCampaignId,
            listingId:
              row.listingId,
            offerId:
              row.offerId,
            applicationId:
              matchingApplication.id,
            status:
              matchingApplication.process
                .status,
          },
        )

        continue
      }

      await db
        .update(listingCampaigns)
        .set({
          applicationStatus:
            'SUBMISSION_UNKNOWN',

          applicationError:
            'Submission outcome could not be verified after backend interruption. Automatic resubmission is blocked.',

          updatedAt:
            recoveredAt,
        })
        .where(
          and(
            eq(
              listingCampaigns.id,
              row.id,
            ),
            eq(
              listingCampaigns.applicationStatus,
              'SUBMITTING',
            ),
          ),
        )

      console.warn(
        'Stale Allegro campaign submission requires manual review:',
        {
          campaignId:
            row.externalCampaignId,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
        },
      )
    } catch (error) {
      console.error(
        'Stale Allegro campaign submission recovery failed:',
        {
          campaignId:
            row.externalCampaignId,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          error:
            error instanceof Error
              ? error.message
              : error,
        },
      )
    }
  }
}

async function processDueCampaignSubmissions() {
  if (!db || campaignSchedulerRunning) {
    return
  }

  campaignSchedulerRunning = true

  try {
    await recoverStaleCampaignSubmissions()

    const now = new Date()

    const scheduledRows = await db
      .select({
        id:
          listingCampaigns.id,

        listingId:
          listingCampaigns.listingId,

        externalCampaignId:
          listingCampaigns.externalCampaignId,

        validFrom:
          listingCampaigns.validFrom,

        validTo:
          listingCampaigns.validTo,

        retryAfter:
          listingCampaigns.retryAfter,

        retryCount:
          listingCampaigns.retryCount,
      })
      .from(listingCampaigns)
      .where(
        eq(
          listingCampaigns.applicationStatus,
          'SCHEDULED',
        ),
      )

    const dueRows =
      scheduledRows.filter(
        (row) =>
          row.validFrom !== null &&
          row.validFrom <= now &&
          (
            row.validTo === null ||
            row.validTo >= now
          ) &&
          row.retryCount <
            CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT &&
          (
            row.retryAfter === null ||
            row.retryAfter <= now
          ),
      )

    const blockedRows =
      scheduledRows.filter(
        (row) =>
          (
            row.validTo !== null &&
            row.validTo < now
          ) ||
          row.retryCount >=
            CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT,
      )

    for (const row of blockedRows) {
      const applicationError =
        row.validTo !== null &&
        row.validTo < now
          ? `Automatic submission stopped because the campaign period expired: ${row.validTo.toISOString()}`
          : `Automatic submission stopped after ${CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT} failed attempts`

      await db
        .update(listingCampaigns)
        .set({
          applicationStatus: 'FAILED',
          applicationError,
          retryAfter: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(
              listingCampaigns.id,
              row.id,
            ),
            eq(
              listingCampaigns.applicationStatus,
              'SCHEDULED',
            ),
          ),
        )
    }

    if (dueRows.length === 0) {
      return
    }

    const campaignsToSubmit =
      new Map<string, string[]>()

    for (const row of dueRows) {
      const listingIds =
        campaignsToSubmit.get(
          row.externalCampaignId,
        ) ?? []

      listingIds.push(row.listingId)

      campaignsToSubmit.set(
        row.externalCampaignId,
        listingIds,
      )
    }

    for (
      const [
        campaignId,
        listingIds,
      ] of campaignsToSubmit
    ) {
      const response = await app.request(
        `/allegro/remote-campaigns/${encodeURIComponent(
          campaignId,
        )}/submit`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            listingIds,
          }),
        },
      )

      let responseBody: unknown = null

      try {
        responseBody =
          await response.json()
      } catch {
        responseBody = null
      }

      if (!response.ok) {
        const responseMessage =
          responseBody &&
          typeof responseBody === 'object' &&
          'message' in responseBody &&
          typeof responseBody.message === 'string'
            ? responseBody.message
            : `HTTP ${response.status}`

        const retryableConflict =
          response.status === 409 &&
          responseMessage.includes(
            'has not started yet',
          )

        const terminalFailure =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429 &&
          !retryableConflict

        let retryDelayMs =
          60 * 60 * 1000

        if (response.status === 429) {
          retryDelayMs =
            15 * 60 * 1000
        } else if (
          response.status >= 500
        ) {
          retryDelayMs =
            5 * 60 * 1000
        } else if (
          response.status === 409 &&
          responseMessage.includes(
            'not eligible',
          )
        ) {
          retryDelayMs =
            6 * 60 * 60 * 1000
        } else if (
          response.status === 409
        ) {
          retryDelayMs =
            30 * 60 * 1000
        } else if (
          response.status === 404
        ) {
          retryDelayMs =
            24 * 60 * 60 * 1000
        }

        const retryAfter =
          new Date(
            Date.now() + retryDelayMs,
          )

        const affectedRows =
          dueRows.filter(
            (row) =>
              row.externalCampaignId ===
              campaignId,
          )

        const retryScheduled =
          !terminalFailure &&
          affectedRows.some(
            (row) =>
              row.retryCount + 1 <
                CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT,
          )

        for (const row of affectedRows) {
          const nextRetryCount =
            row.retryCount + 1

          const retriesExhausted =
            nextRetryCount >=
              CAMPAIGN_SUBMISSION_MAX_RETRY_COUNT

          await db
            .update(listingCampaigns)
            .set({
              applicationStatus:
                terminalFailure ||
                retriesExhausted
                  ? 'FAILED'
                  : 'SCHEDULED',

              retryAfter:
                terminalFailure ||
                retriesExhausted
                  ? null
                  : retryAfter,

              retryCount:
                nextRetryCount,

              applicationError:
                responseMessage,

              updatedAt: new Date(),
            })
            .where(
              eq(
                listingCampaigns.id,
                row.id,
              ),
            )
        }

        console.warn(
          'Automatic campaign submission skipped or failed:',
          {
            campaignId,
            status: response.status,
            retryAfter:
              retryScheduled
                ? retryAfter.toISOString()
                : null,
            response: responseBody,
          },
        )

        continue
      }

      console.log(
        'Automatic campaign submission processed:',
        {
          campaignId,
          listingCount:
            listingIds.length,
          response: responseBody,
        },
      )
    }
  } catch (error) {
    console.error(
      'Automatic Allegro campaign processing failed:',
      error,
    )
  } finally {
    campaignSchedulerRunning = false
  }
}
let automaticAllegroSyncRunning = false

async function runAutomaticAllegroSync() {
  if (
    (process.env.ALLEGRO_ENV ?? 'SANDBOX')
      .toUpperCase() === 'PRODUCTION'
  ) {
    return
  }

  if (automaticAllegroSyncRunning) {
    return
  }

  automaticAllegroSyncRunning = true

  try {
    const response = await app.request(
      '/auth/allegro/sync',
      {
        method: 'POST',
      },
    )

    if (!response.ok) {
      const errorBody =
        await response.text()

      console.error(
        'Automatic Allegro listing sync failed:',
        response.status,
        errorBody,
      )

      return
    }

    const result =
      (await response.json()) as {
        imported?: number
        skipped?: number
        syncedAt?: string
      }

    console.log(
      'Automatic Allegro listing sync completed:',
      {
        imported: result.imported ?? 0,
        skipped: result.skipped ?? 0,
        syncedAt: result.syncedAt ?? null,
      },
    )
  } catch (error) {
    console.error(
      'Automatic Allegro listing sync failed:',
      error,
    )
  } finally {
    automaticAllegroSyncRunning = false
  }
}

const ALLEGRO_CATALOG_SYNC_INTERVAL_MS =
  60 * 60 * 1000

let automaticAllegroCatalogSyncRunning =
  false

type AllegroCatalogOffer = {
  id: string
  name?: string
  external?: {
    id?: string | null
  }
  category?: {
    id?: string
  }
}

type AllegroCatalogOffersResponse = {
  offers?: AllegroCatalogOffer[]
  totalCount?: number
  count?: number
}

type AllegroCatalogHubListing = {
  id: string
  offerId: string
  sku?: string | null
  productName?: string | null
  categoryId?: string | null
  acceptedAt?: string | null
}

async function runAutomaticAllegroCatalogSync() {
  if (
    (process.env.ALLEGRO_ENV ?? 'SANDBOX')
      .toUpperCase() !== 'PRODUCTION'
  ) {
    return
  }

  if (automaticAllegroCatalogSyncRunning) {
    return
  }

  automaticAllegroCatalogSyncRunning =
    true

  try {
    const allOffers: AllegroCatalogOffer[] =
      []

    const limit = 100
    let offset = 0
    let totalCount: number | null = null

    do {
      const response = await app.request(
        `/auth/allegro/offers?limit=${limit}&offset=${offset}`,
      )

      if (!response.ok) {
        const errorBody =
          await response.text()

        throw new Error(
          `Allegro catalog page failed at offset ${offset}: ${response.status} ${errorBody}`,
        )
      }

      const page =
        (await response.json()) as
          AllegroCatalogOffersResponse

      const pageOffers =
        page.offers ?? []

      allOffers.push(
        ...pageOffers,
      )

      if (totalCount === null) {
        totalCount =
          page.totalCount ??
          page.count ??
          pageOffers.length
      }

      if (
        pageOffers.length === 0 &&
        offset < totalCount
      ) {
        throw new Error(
          `Allegro catalog pagination stopped unexpectedly at offset ${offset}`,
        )
      }

      offset += limit
    } while (
      totalCount !== null &&
      offset < totalCount
    )

    const listingsResponse =
      await app.request(
        '/allegro/listings',
      )

    if (!listingsResponse.ok) {
      const errorBody =
        await listingsResponse.text()

      throw new Error(
        `Commerce Hub listing load failed: ${listingsResponse.status} ${errorBody}`,
      )
    }

    const listingsBody =
      (await listingsResponse.json()) as {
        data?: AllegroCatalogHubListing[]
      }

    const hubListings =
      listingsBody.data ?? []

    const hubByOfferId =
      new Map(
        hubListings.map(
          (listing) => [
            listing.offerId,
            listing,
          ],
        ),
      )

    const offersWithoutSku =
      allOffers.filter(
        (offer) =>
          !offer.external?.id?.trim(),
      )

    const newOffers =
      allOffers.filter(
        (offer) =>
          Boolean(
            offer.external?.id?.trim(),
          ) &&
          !hubByOfferId.has(
            offer.id,
          ),
      )

    const renamedOffers =
      allOffers.filter(
        (offer) => {
          const existing =
            hubByOfferId.get(
              offer.id,
            )

          if (!existing) {
            return false
          }

          return (
            typeof offer.name === 'string' &&
            offer.name !==
              existing.productName
          )
        },
      )

    const changedOfferIds =
      [
        ...new Set([
          ...newOffers.map(
            (offer) => offer.id,
          ),

          ...renamedOffers.map(
            (offer) => offer.id,
          ),
        ]),
      ]

    let syncedOffers = 0

    for (
      let index = 0;
      index < changedOfferIds.length;
      index += 10
    ) {
      const offerIds =
        changedOfferIds.slice(
          index,
          index + 10,
        )

      const syncResponse =
        await app.request(
          '/auth/allegro/sync',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify({
                offerIds,
              }),
          },
        )

      if (!syncResponse.ok) {
        const errorBody =
          await syncResponse.text()

        throw new Error(
          `Targeted Allegro catalog sync failed: ${syncResponse.status} ${errorBody}`,
        )
      }

      const syncResult =
        (await syncResponse.json()) as {
          status?: string
          imported?: number
          skipped?: number
        }

      if (
        syncResult.status !== 'ok'
      ) {
        throw new Error(
          'Targeted Allegro catalog sync returned non-ok status',
        )
      }

      syncedOffers +=
        syncResult.imported ?? 0
    }

    let initializedBaselines = 0

    if (newOffers.length > 0) {
      const refreshedListingsResponse =
        await app.request(
          '/allegro/listings',
        )

      if (
        !refreshedListingsResponse.ok
      ) {
        const errorBody =
          await refreshedListingsResponse
            .text()

        throw new Error(
          `Commerce Hub listing reload failed after catalog import: ${refreshedListingsResponse.status} ${errorBody}`,
        )
      }

      const refreshedListingsBody =
        (await refreshedListingsResponse
          .json()) as {
          data?: AllegroCatalogHubListing[]
        }

      const refreshedByOfferId =
        new Map(
          (
            refreshedListingsBody.data ??
            []
          ).map(
            (listing) => [
              listing.offerId,
              listing,
            ],
          ),
        )

      for (const offer of newOffers) {
        const listing =
          refreshedByOfferId.get(
            offer.id,
          )

        if (!listing) {
          throw new Error(
            `New Allegro offer was imported but Hub listing was not found: ${offer.id}`,
          )
        }

        const baselineResponse =
          await app.request(
            `/allegro/listings/${encodeURIComponent(listing.id)}/initialize-baseline`,
            {
              method: 'POST',
            },
          )

        if (!baselineResponse.ok) {
          const errorBody =
            await baselineResponse.text()

          throw new Error(
            `Targeted baseline initialization failed for offer ${offer.id}: ${baselineResponse.status} ${errorBody}`,
          )
        }

        const baselineResult =
          (await baselineResponse.json()) as {
            status?: string
            initialized?: boolean
            alreadyInitialized?: boolean
          }

        if (
          baselineResult.status !== 'ok'
        ) {
          throw new Error(
            `Targeted baseline initialization returned non-ok status for offer ${offer.id}`,
          )
        }

        if (
          baselineResult.initialized
        ) {
          initializedBaselines++
        }
      }
    }

    console.log(
      'Automatic Allegro catalog sync completed:',
      {
        allegroOffers:
          allOffers.length,

        hubListingsBefore:
          hubListings.length,

        newOffers:
          newOffers.length,

        renamedOffers:
          renamedOffers.length,

        offersWithoutSku:
          offersWithoutSku.length,

        targetedSyncOffers:
          changedOfferIds.length,

        syncedOffers,

        initializedBaselines,
      },
    )
  } catch (error) {
    console.error(
      'Automatic Allegro catalog sync failed:',
      error,
    )
  } finally {
    automaticAllegroCatalogSyncRunning =
      false
  }
}
let runtimeInitialization:
  | Promise<void>
  | null = null

export function initializeCommerceHubRuntime() {
  runtimeInitialization ??= (async () => {
    assertAccessConfiguration()

    await restoreAllegroSession()
  })()

  return runtimeInitialization
}

export async function runMinuteScheduler() {
  await runWithSchedulerLease(
    'minute-scheduler',
    55 * 1000,
    runMinuteSchedulerJobs,
  )
}

async function runMinuteSchedulerJobs() {
  const jobs = [
    ['token refresh', refreshAllegroSessionIfNeeded],
    ['price schedules', processPriceSchedulesAutomatically],
    [
      'data connection schedules',
      processDueDataConnectionSchedules,
    ],
    ['campaign submissions', processDueCampaignSubmissions],
    [
      'campaign application statuses',
      processPendingCampaignApplications,
    ],
    ['campaign finishes', processDueCampaignFinishes],
    [
      'campaign finish operations',
      processPendingCampaignFinishOperations,
    ],
  ] as const

  const results = await Promise.allSettled(
    jobs.map(([, job]) => job()),
  )

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `Scheduled ${jobs[index][0]} job failed:`,
        result.reason,
      )
    }
  })
}

export async function runHourlyScheduler() {
  await runWithSchedulerLease(
    'hourly-scheduler',
    55 * 60 * 1000,
    runAutomaticAllegroCatalogSync,
  )
}

export async function runSixHourlyScheduler() {
  await runWithSchedulerLease(
    'six-hour-scheduler',
    5 * 60 * 60 * 1000 + 55 * 60 * 1000,
    runAutomaticAllegroSync,
  )
}

export async function runDailyMaintenance() {
  await runWithSchedulerLease(
    'daily-maintenance',
    23 * 60 * 60 * 1000,
    cleanupExpiredAllegroHistory,
  )
}

async function runWithSchedulerLease(
  name: string,
  leaseDurationMs: number,
  job: () => Promise<void>,
) {
  if (!db) {
    console.warn(
      `Skipping ${name}: database is not configured`,
    )
    return
  }

  const ownerId = randomUUID()
  const now = new Date()
  const lockedUntil = new Date(
    now.getTime() + leaseDurationMs,
  )

  let acquired:
    | Array<{ ownerId: string }>
    | null = null

  try {
    acquired = await db
      .insert(schedulerLeases)
      .values({
        name,
        ownerId,
        lockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schedulerLeases.name,
        set: {
          ownerId,
          lockedUntil,
          updatedAt: now,
        },
        setWhere: lte(
          schedulerLeases.lockedUntil,
          now,
        ),
      })
      .returning({
        ownerId: schedulerLeases.ownerId,
      })
  } catch (error) {
    console.error(
      `Skipping ${name}: scheduler lease acquisition failed`,
      error,
    )
    return
  }

  if (acquired[0]?.ownerId !== ownerId) {
    console.log(
      `Skipping ${name}: scheduler lease is held`,
    )
    return
  }

  await job()
}

export const schedulerIntervals = {
  minute: PRICE_SCHEDULE_PROCESS_INTERVAL_MS,
  hourly: ALLEGRO_CATALOG_SYNC_INTERVAL_MS,
  sixHourly: 6 * 60 * 60 * 1000,
  daily: ALLEGRO_HISTORY_CLEANUP_INTERVAL_MS,
} as const

