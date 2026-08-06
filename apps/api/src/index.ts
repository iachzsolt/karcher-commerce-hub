import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import {
  createDatabase,
  campaigns,
  listingCampaigns,
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
import {
  allegroAuth,
  getAllegroBadgeCampaigns,
  refreshAllegroSessionIfNeeded,
  restoreAllegroSession,
  submitOfferToAllegroCampaign,
} from './allegro-auth.js'

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

      const now = new Date()

      let [localCampaign] = await db
        .select()
        .from(campaigns)
        .where(
          eq(
            campaigns.externalCampaignId,
            externalCampaignId,
          ),
        )
        .limit(1)

      if (!localCampaign) {
        ;[localCampaign] = await db
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
            marketplace,
            status: 'AVAILABLE',
            validFrom: publicationFrom,
            validTo: publicationTo,
            autoSync: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      } else {
        ;[localCampaign] = await db
          .update(campaigns)
          .set({
            name: campaignName,
            campaignType:
              campaignType as
                | 'STANDARD'
                | 'DISCOUNT'
                | 'SOURCING'
                | 'OTHER',
            marketplace,
            validFrom: publicationFrom,
            validTo: publicationTo,
            updatedAt: now,
          })
          .where(
            eq(
              campaigns.id,
              localCampaign.id,
            ),
          )
          .returning()
      }

      const saved = []

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

        const [listing] = await db
          .select({
            id: platformListings.id,
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
              message:
                `Listing not found: ${listingId}`,
            },
            404,
          )
        }

        const [savedPreparation] =
          await db
            .insert(listingCampaigns)
            .values({
              campaignId:
                localCampaign.id,
              listingId,
              externalCampaignId,
              campaignName,
              campaignType:
                campaignType as
                  | 'STANDARD'
                  | 'DISCOUNT'
                  | 'SOURCING'
                  | 'OTHER',
              marketplace,
              desiredPriceMinor:
                Math.round(
                  desiredPrice * 100,
                ),
              priceLocked: true,
              autoSync: false,
              applicationStatus:
                'PREPARED',
              campaignStatus:
                'PREPARED',
              validFrom,
              validTo,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                listingCampaigns.listingId,
                listingCampaigns.externalCampaignId,
              ],
              set: {
                campaignId:
                  localCampaign.id,
                campaignName,
                campaignType:
                  campaignType as
                    | 'STANDARD'
                    | 'DISCOUNT'
                    | 'SOURCING'
                    | 'OTHER',
                marketplace,
                desiredPriceMinor:
                  Math.round(
                    desiredPrice * 100,
                  ),
                priceLocked: true,
                applicationStatus:
                  'PREPARED',
                campaignStatus:
                  'PREPARED',
                validFrom,
                validTo,
                updatedAt: now,
              },
            })
            .returning()

        saved.push(savedPreparation)
      }

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
            eq(
              listingCampaigns.id,
              preparation.id,
            ),
          )
          .returning()

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

        await db
          .update(listingCampaigns)
          .set({
            applicationStatus:
              'SUBMITTING',

            applicationError: null,

            updatedAt: submittingAt,
          })
          .where(
            eq(
              listingCampaigns.id,
              preparation.id,
            ),
          )

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
            result.status !== 'FAILED',
        ).length

      const failed =
        results.length - succeeded

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
let campaignSchedulerRunning = false

async function processDueCampaignSubmissions() {
  if (!db || campaignSchedulerRunning) {
    return
  }

  campaignSchedulerRunning = true

  try {
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
            row.retryAfter === null ||
            row.retryAfter <= now
          ),
      )

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

        for (const row of affectedRows) {
          await db
            .update(listingCampaigns)
            .set({
              retryAfter,

              retryCount:
                row.retryCount + 1,

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
              retryAfter.toISOString(),
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
const port = 3000

async function startServer() {
  await restoreAllegroSession()

  const tokenRefreshTimer = setInterval(() => {
    void refreshAllegroSessionIfNeeded().catch(
      (error) => {
        console.error(
          'Automatic Allegro token refresh failed:',
          error,
        )
      },
    )
  }, 60 * 1000)

  tokenRefreshTimer.unref()

  const campaignSubmissionTimer =
    setInterval(() => {
      void processDueCampaignSubmissions()
    }, 60 * 1000)

  campaignSubmissionTimer.unref()

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