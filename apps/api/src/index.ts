import 'dotenv/config'
import { serve } from '@hono/node-server'
import {
  createDatabase,
  listingDesiredStates,
  listingRemoteStates,
  platformAccounts,
  platformListings,
  platforms,
  productIdentifiers,
  products,
} from '@karcher-commerce-hub/database'
import { neon } from '@neondatabase/serverless'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { allegroAuth, restoreAllegroSession } from './allegro-auth.js'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: 'http://localhost:5173',
  }),
)

app.route('/auth/allegro', allegroAuth)

const databaseUrl = process.env.DATABASE_URL

const db = databaseUrl
  ? createDatabase(databaseUrl)
  : null

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
    environment: 'development',
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
        productName: products.name,

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

        autoPriceSync:
          listingDesiredStates.autoPriceSync,

        autoStockSync:
          listingDesiredStates.autoStockSync,
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
      .where(
        and(
          eq(platforms.code, 'ALLEGRO'),
          eq(
            platformListings.marketplace,
            'allegro-hu',
          ),
        ),
      )

    return context.json({
      status: 'ok',
      count: result.length,
      data: result,
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
const port = 3000

async function startServer() {
  await restoreAllegroSession()

  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(
        `Commerce Hub API: http://localhost:${info.port}`,
      )
      console.log(
        `Health check: http://localhost:${info.port}/health`,
      )
      console.log(
        `Database health: http://localhost:${info.port}/database/health`,
      )
      console.log(
        `Platforms: http://localhost:${info.port}/platforms`,
      )
      console.log(
        `Products: http://localhost:${info.port}/products`,
      )
    },
  )
}

void startServer()