import { createHash } from 'node:crypto'

import {
  createDatabase,
  dataConnections,
  dataConnectionSchedules,
  inventoryConnectionConfigs,
  inventoryImportRuns,
  inventorySourceItems,
  products,
  platforms,
  platformListings,
  listingRemoteStates,
  listingDesiredStates,

} from '@karcher-commerce-hub/database'
import {
  and,
  desc,
  eq,
  lte,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { JWT } from 'google-auth-library'
import { Hono } from 'hono'
import { allegroAuth } from './allegro-auth.js'

const dataConnectionsApi = new Hono()

const databaseUrl = process.env.DATABASE_URL

const db = databaseUrl
  ? createDatabase(databaseUrl)
  : null

const GOOGLE_SHEETS_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets.readonly'

type GoogleValuesResponse = {
  values?: unknown[][]
}

type GoogleSpreadsheetMetadata = {
  properties?: {
    title?: string
  }
  sheets?: Array<{
    properties?: {
      sheetId?: number
      title?: string
      index?: number
      hidden?: boolean
    }
  }>
}

type InventoryNormalizedItem = {
  sku: string
  stock: number
  sourceStockValue: string
  normalizedToZero: boolean
}

type InventoryAnalysis = {
  headers: string[]
  rowsRead: number
  rowsImported: number
  rowsNormalizedToZero: number
  duplicateSkuCount: number
  blankSkuCount: number
  items: InventoryNormalizedItem[]
  fingerprint: string
}

function requireDatabase() {
  if (!db) {
    throw new Error(
      'DATABASE_URL is not configured.',
    )
  }

  return db
}

function extractSpreadsheetId(
  value: string,
) {
  const trimmed = value.trim()

  const urlMatch = trimmed.match(
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
  )

  if (urlMatch?.[1]) {
    return urlMatch[1]
  }

  if (
    /^[a-zA-Z0-9_-]{20,}$/.test(
      trimmed,
    )
  ) {
    return trimmed
  }

  return null
}

function createGoogleClient() {
  const email =
    process.env
      .GOOGLE_SERVICE_ACCOUNT_EMAIL
      ?.trim()

  const privateKey =
    process.env
      .GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      ?.replace(/\\n/g, '\n')

  if (!email || !privateKey) {
    throw new Error(
      [
        'Google Sheets authentication is not configured.',
        'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and',
        'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.',
      ].join(' '),
    )
  }

  return new JWT({
    email,
    key: privateKey,
    scopes: [
      GOOGLE_SHEETS_SCOPE,
    ],
  })
}

async function googleSheetsGet<T>(
  url: string,
): Promise<T> {
  const client = createGoogleClient()

  const accessToken =
    await client.getAccessToken()

  if (!accessToken.token) {
    throw new Error(
      'Could not obtain Google access token.',
    )
  }

  const response = await fetch(
    url,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken.token}`,
      },
    },
  )

  if (!response.ok) {
    const errorBody =
      await response.text()

    throw new Error(
      `Google Sheets API ${response.status}: ${errorBody}`,
    )
  }

  return (
    await response.json()
  ) as T
}

function quoteSheetName(
  sheetName: string,
) {
  return `'${sheetName.replace(
    /'/g,
    "''",
  )}'`
}

async function fetchRange(
  spreadsheetId: string,
  range: string,
) {
  const encodedRange =
    encodeURIComponent(range)

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(spreadsheetId)}/values/` +
    `${encodedRange}` +
    '?valueRenderOption=UNFORMATTED_VALUE' +
    '&majorDimension=ROWS'

  return googleSheetsGet<GoogleValuesResponse>(
    url,
  )
}

async function fetchSpreadsheetMetadata(
  spreadsheetId: string,
) {
  const fields =
    encodeURIComponent(
      [
        'properties.title',
        'sheets.properties.sheetId',
        'sheets.properties.title',
        'sheets.properties.index',
        'sheets.properties.hidden',
      ].join(','),
    )

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(spreadsheetId)}` +
    `?fields=${fields}`

  return googleSheetsGet<GoogleSpreadsheetMetadata>(
    url,
  )
}

function normalizeHeader(
  value: unknown,
) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('hu-HU')
}

function columnIndexToLetter(
  index: number,
) {
  let current = index + 1
  let result = ''

  while (current > 0) {
    const remainder =
      (current - 1) % 26

    result =
      String.fromCharCode(
        65 + remainder,
      ) + result

    current =
      Math.floor(
        (current - 1) / 26,
      )
  }

  return result
}

function normalizeStock(
  rawValue: unknown,
) {
  const sourceStockValue =
    rawValue === null ||
    rawValue === undefined
      ? ''
      : String(rawValue).trim()

  if (sourceStockValue === '') {
    return {
      stock: 0,
      sourceStockValue,
      normalizedToZero: true,
    }
  }

  const numericValue =
    typeof rawValue === 'number'
      ? rawValue
      : Number(
          sourceStockValue.replace(
            ',',
            '.',
          ),
        )

  if (
    !Number.isFinite(numericValue) ||
    numericValue < 0
  ) {
    return {
      stock: 0,
      sourceStockValue,
      normalizedToZero: true,
    }
  }

  const stock =
    Math.floor(numericValue)

  return {
    stock,
    sourceStockValue,
    normalizedToZero:
      stock !== numericValue,
  }
}

function createFingerprint(
  items: InventoryNormalizedItem[],
) {
  const normalized =
    [...items]
      .sort(
        (left, right) =>
          left.sku.localeCompare(
            right.sku,
          ),
      )
      .map((item) => ({
        sku: item.sku,
        stock: item.stock,
      }))

  return createHash('sha256')
    .update(
      JSON.stringify(normalized),
    )
    .digest('hex')
}

async function getHeaders(
  spreadsheetId: string,
  sheetName: string,
  headerRow: number,
) {
  const quoted =
    quoteSheetName(sheetName)

  const range =
    `${quoted}!${headerRow}:${headerRow}`

  const response =
    await fetchRange(
      spreadsheetId,
      range,
    )

  return (
    response.values?.[0] ?? []
  ).map((value) =>
    String(value ?? '').trim(),
  )
}

async function analyzeInventorySheet(
  spreadsheetId: string,
  sheetName: string,
  headerRow: number,
  skuSourceField: string,
  stockSourceField: string,
): Promise<InventoryAnalysis> {
  const headers =
    await getHeaders(
      spreadsheetId,
      sheetName,
      headerRow,
    )

  const normalizedHeaders =
    headers.map(normalizeHeader)

  const skuIndex =
    normalizedHeaders.indexOf(
      normalizeHeader(
        skuSourceField,
      ),
    )

  const stockIndex =
    normalizedHeaders.indexOf(
      normalizeHeader(
        stockSourceField,
      ),
    )

  if (skuIndex < 0) {
    throw new Error(
      `Cikkszám oszlop nem található: ${skuSourceField}`,
    )
  }

  if (stockIndex < 0) {
    throw new Error(
      `Készlet oszlop nem található: ${stockSourceField}`,
    )
  }

  const startIndex =
    Math.min(
      skuIndex,
      stockIndex,
    )

  const endIndex =
    Math.max(
      skuIndex,
      stockIndex,
    )

  const startColumn =
    columnIndexToLetter(
      startIndex,
    )

  const endColumn =
    columnIndexToLetter(
      endIndex,
    )

  const quoted =
    quoteSheetName(sheetName)

  const dataRange =
    `${quoted}!` +
    `${startColumn}${headerRow + 1}:` +
    `${endColumn}`

  const response =
    await fetchRange(
      spreadsheetId,
      dataRange,
    )

  const rows =
    response.values ?? []

  const itemsBySku =
    new Map<
      string,
      InventoryNormalizedItem
    >()

  let duplicateSkuCount = 0
  let blankSkuCount = 0
  let rowsNormalizedToZero = 0

  for (const row of rows) {
    const skuValue =
      row[
        skuIndex - startIndex
      ]

    const sku =
      String(
        skuValue ?? '',
      ).trim()

    if (!sku) {
      blankSkuCount += 1
      continue
    }

    const rawStockValue =
      row[
        stockIndex - startIndex
      ]

    const normalizedStock =
      normalizeStock(
        rawStockValue,
      )

    if (
      normalizedStock
        .normalizedToZero
    ) {
      rowsNormalizedToZero += 1
    }

    if (itemsBySku.has(sku)) {
      duplicateSkuCount += 1
    }

    itemsBySku.set(
      sku,
      {
        sku,
        ...normalizedStock,
      },
    )
  }

  const items =
    [...itemsBySku.values()]

  return {
    headers,
    rowsRead: rows.length,
    rowsImported: items.length,
    rowsNormalizedToZero,
    duplicateSkuCount,
    blankSkuCount,
    items,
    fingerprint:
      createFingerprint(items),
  }
}

async function getConnection(
  connectionId: string,
) {
  const database =
    requireDatabase()

  const [result] =
    await database
      .select({
        connection:
          dataConnections,
        config:
          inventoryConnectionConfigs,
      })
      .from(dataConnections)
      .leftJoin(
        inventoryConnectionConfigs,
        eq(
          inventoryConnectionConfigs
            .connectionId,
          dataConnections.id,
        ),
      )
      .where(
        eq(
          dataConnections.id,
          connectionId,
        ),
      )
      .limit(1)

  return result ?? null
}


/* ============================================================
   DATA CONNECTION REFRESH SCHEDULES
   ============================================================ */

type RefreshScheduleMode =
  | 'DAILY_TIMES'
  | 'INTERVAL'

type RefreshScheduleSettings = {
  mode: RefreshScheduleMode
  intervalMinutes: number | null
  dailyTimes: string[]
  timeZone: string
  weekdaysOnly: boolean
}

function normalizeDailyTimes(
  value: unknown,
) {
  if (!Array.isArray(value)) {
    return []
  }

  const valid =
    value
      .map((item) =>
        String(item).trim(),
      )
      .filter((item) =>
        /^([01]\d|2[0-3]):[0-5]\d$/.test(
          item,
        ),
      )

  return [
    ...new Set(valid),
  ].sort()
}

function parseDailyTimesJson(
  value: string,
) {
  try {
    return normalizeDailyTimes(
      JSON.parse(value),
    )
  } catch {
    return []
  }
}

function getLocalScheduleParts(
  date: Date,
  timeZone: string,
) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      },
    )

  const parts =
    formatter.formatToParts(
      date,
    )

  const values =
    Object.fromEntries(
      parts.map((part) => [
        part.type,
        part.value,
      ]),
    )

  return {
    weekday:
      values.weekday ?? '',
    time:
      `${values.hour ?? '00'}:${values.minute ?? '00'}`,
  }
}

function isWeekend(
  date: Date,
  timeZone: string,
) {
  const { weekday } =
    getLocalScheduleParts(
      date,
      timeZone,
    )

  return (
    weekday === 'Sat' ||
    weekday === 'Sun'
  )
}

function calculateNextRunAt(
  settings: RefreshScheduleSettings,
  from = new Date(),
) {
  if (
    settings.mode ===
    'INTERVAL'
  ) {
    const minutes =
      settings.intervalMinutes

    if (
      minutes === null ||
      minutes < 1
    ) {
      return null
    }

    let candidate =
      new Date(
        from.getTime() +
          minutes * 60 * 1000,
      )

    /*
     * Weekdays-only interval schedules
     * pause through Saturday/Sunday.
     */
    while (
      settings.weekdaysOnly &&
      isWeekend(
        candidate,
        settings.timeZone,
      )
    ) {
      candidate =
        new Date(
          candidate.getTime() +
            60 * 60 * 1000,
        )
    }

    return candidate
  }

  if (
    settings.dailyTimes.length === 0
  ) {
    return null
  }

  /*
   * Starting from the next whole minute,
   * find the first configured local time.
   *
   * Intl handles Europe/Budapest DST
   * conversion for us.
   */
  let candidate =
    new Date(
      Math.floor(
        from.getTime() / 60000,
      ) *
        60000 +
        60000,
    )

  const maxMinutes =
    8 * 24 * 60

  for (
    let offset = 0;
    offset < maxMinutes;
    offset += 1
  ) {
    const local =
      getLocalScheduleParts(
        candidate,
        settings.timeZone,
      )

    const allowedDay =
      !settings.weekdaysOnly ||
      (
        local.weekday !== 'Sat' &&
        local.weekday !== 'Sun'
      )

    if (
      allowedDay &&
      settings.dailyTimes.includes(
        local.time,
      )
    ) {
      return candidate
    }

    candidate =
      new Date(
        candidate.getTime() +
          60 * 1000,
      )
  }

  return null
}


dataConnectionsApi.get(
  '/:connectionId/schedule',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const [schedule] =
      await database
        .select()
        .from(
          dataConnectionSchedules,
        )
        .where(
          eq(
            dataConnectionSchedules
              .connectionId,
            connectionId,
          ),
        )
        .limit(1)

    if (!schedule) {
      return context.json({
        connectionId,
        enabled: false,
        mode: 'DAILY_TIMES',
        intervalMinutes: null,
        dailyTimes: [],
        timeZone:
          'Europe/Budapest',
        weekdaysOnly: true,
        lastRunAt: null,
        nextRunAt: null,
      })
    }

    return context.json({
      connectionId,
      enabled:
        schedule.enabled,
      mode:
        schedule.mode,
      intervalMinutes:
        schedule.intervalMinutes,
      dailyTimes:
        parseDailyTimesJson(
          schedule.dailyTimesJson,
        ),
      timeZone:
        schedule.timeZone,
      weekdaysOnly:
        schedule.weekdaysOnly,
      lastRunAt:
        schedule.lastRunAt,
      nextRunAt:
        schedule.nextRunAt,
    })
  },
)


dataConnectionsApi.put(
  '/:connectionId/schedule',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const body =
      (await context.req
        .json()
        .catch(() => null)) as
        | {
            enabled?: boolean
            mode?: string
            intervalMinutes?:
              number | null
            dailyTimes?: unknown
            weekdaysOnly?: boolean
          }
        | null

    const [connection] =
      await database
        .select()
        .from(dataConnections)
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )
        .limit(1)

    if (!connection) {
      return context.json(
        {
          error:
            'Adatkapcsolat nem található.',
        },
        404,
      )
    }

    const enabled =
      body?.enabled === true

    if (
      enabled &&
      !connection.isActive
    ) {
      return context.json(
        {
          error:
            'Automatikus frissítés csak az aktív készletforráson kapcsolható be.',
        },
        409,
      )
    }

    const mode:
      RefreshScheduleMode =
      body?.mode === 'INTERVAL'
        ? 'INTERVAL'
        : 'DAILY_TIMES'

    const dailyTimes =
      normalizeDailyTimes(
        body?.dailyTimes,
      )

    const rawInterval =
      Number(
        body?.intervalMinutes,
      )

    const intervalMinutes =
      Number.isFinite(
        rawInterval,
      )
        ? Math.floor(rawInterval)
        : null

    if (
      enabled &&
      mode === 'DAILY_TIMES' &&
      dailyTimes.length === 0
    ) {
      return context.json(
        {
          error:
            'Adj meg legalább egy napi frissítési időpontot.',
        },
        400,
      )
    }

    if (
      enabled &&
      mode === 'INTERVAL' &&
      (
        intervalMinutes === null ||
        intervalMinutes < 15 ||
        intervalMinutes > 1440
      )
    ) {
      return context.json(
        {
          error:
            'Az intervallum 15 és 1440 perc között lehet.',
        },
        400,
      )
    }

    const settings:
      RefreshScheduleSettings = {
      mode,
      intervalMinutes:
        mode === 'INTERVAL'
          ? intervalMinutes
          : null,
      dailyTimes:
        mode === 'DAILY_TIMES'
          ? dailyTimes
          : [],
      timeZone:
        'Europe/Budapest',
      weekdaysOnly:
        body?.weekdaysOnly ??
        true,
    }

    const now =
      new Date()

    const nextRunAt =
      enabled
        ? calculateNextRunAt(
            settings,
            now,
          )
        : null

    if (
      enabled &&
      !nextRunAt
    ) {
      return context.json(
        {
          error:
            'A következő frissítési időpont nem számítható ki.',
        },
        400,
      )
    }

    const [saved] =
      await database
        .insert(
          dataConnectionSchedules,
        )
        .values({
          connectionId,
          enabled,
          mode,
          intervalMinutes:
            settings.intervalMinutes,
          dailyTimesJson:
            JSON.stringify(
              settings.dailyTimes,
            ),
          timeZone:
            settings.timeZone,
          weekdaysOnly:
            settings.weekdaysOnly,
          nextRunAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target:
            dataConnectionSchedules
              .connectionId,
          set: {
            enabled,
            mode,
            intervalMinutes:
              settings.intervalMinutes,
            dailyTimesJson:
              JSON.stringify(
                settings.dailyTimes,
              ),
            timeZone:
              settings.timeZone,
            weekdaysOnly:
              settings.weekdaysOnly,
            nextRunAt,
            updatedAt: now,
          },
        })
        .returning()

    return context.json({
      connectionId,
      enabled:
        saved?.enabled ?? enabled,
      mode:
        saved?.mode ?? mode,
      intervalMinutes:
        saved?.intervalMinutes ??
        settings.intervalMinutes,
      dailyTimes:
        parseDailyTimesJson(
          saved?.dailyTimesJson ??
            JSON.stringify(
              settings.dailyTimes,
            ),
        ),
      timeZone:
        saved?.timeZone ??
        settings.timeZone,
      weekdaysOnly:
        saved?.weekdaysOnly ??
        settings.weekdaysOnly,
      lastRunAt:
        saved?.lastRunAt ??
        null,
      nextRunAt:
        saved?.nextRunAt ??
        nextRunAt,
    })
  },
)


let refreshScheduleProcessorRunning =
  false

export async function processDueDataConnectionSchedules() {
  if (
    refreshScheduleProcessorRunning
  ) {
    return
  }

  if (!db) {
    return
  }

  refreshScheduleProcessorRunning =
    true

  try {
    const now =
      new Date()

    const dueSchedules =
      await db
        .select({
          schedule:
            dataConnectionSchedules,
          connection:
            dataConnections,
        })
        .from(
          dataConnectionSchedules,
        )
        .innerJoin(
          dataConnections,
          eq(
            dataConnections.id,
            dataConnectionSchedules
              .connectionId,
          ),
        )
        .where(
          and(
            eq(
              dataConnectionSchedules
                .enabled,
              true,
            ),
            lte(
              dataConnectionSchedules
                .nextRunAt,
              now,
            ),
            eq(
              dataConnections.isActive,
              true,
            ),
          ),
        )

    for (
      const item of dueSchedules
    ) {
      const startedAt =
        new Date()

      const settings:
        RefreshScheduleSettings = {
        mode:
          item.schedule.mode ===
          'INTERVAL'
            ? 'INTERVAL'
            : 'DAILY_TIMES',

        intervalMinutes:
          item.schedule
            .intervalMinutes,

        dailyTimes:
          parseDailyTimesJson(
            item.schedule
              .dailyTimesJson,
          ),

        timeZone:
          item.schedule
            .timeZone,

        weekdaysOnly:
          item.schedule
            .weekdaysOnly,
      }

      try {
        const response =
          await dataConnectionsApi
            .request(
              '/' +
                item.connection.id +
                '/import',
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
                rowsImported?: number
                changedItemCount?: number
                error?: string
              }
            | null

        if (!response.ok) {
          console.warn(
            'Automatic inventory refresh failed:',
            {
              connectionId:
                item.connection.id,
              connectionName:
                item.connection.name,
              status:
                response.status,
              result,
            },
          )
        } else {
          console.log(
            'Automatic inventory refresh completed:',
            {
              connectionId:
                item.connection.id,
              connectionName:
                item.connection.name,
              status:
                result?.status,
              rowsImported:
                result?.rowsImported ??
                0,
              changedItemCount:
                result
                  ?.changedItemCount ??
                0,
            },
          )

          /*
           * A sikeres import után mindig ellenőrizzük az
           * Allegro készletállapotot. NO_CHANGE import esetén is,
           * mert az Allegro állapota ettől még eltérhet a forrástól.
           */
          const previewResponse =
            await dataConnectionsApi.request(
              '/' +
                item.connection.id +
                '/allegro-stock-preview',
              {
                method: 'GET',
              },
            )

          const previewResult =
            (await previewResponse
              .json()
              .catch(() => null)) as
              | {
                  rows?: Array<{
                    listingId?: string
                  }>
                  error?: string
                  message?: string
                }
              | null

          if (
            !previewResponse.ok ||
            !Array.isArray(
              previewResult?.rows,
            )
          ) {
            console.warn(
              'Automatic Allegro stock sync skipped: preview failed',
              {
                connectionId:
                  item.connection.id,
                status:
                  previewResponse.status,
                result:
                  previewResult,
              },
            )
          } else {
            const listingIds =
              Array.from(
                new Set(
                  previewResult.rows
                    .map((row) =>
                      row.listingId,
                    )
                    .filter(
                      (listingId): listingId is string =>
                        typeof listingId === 'string' &&
                        listingId.length > 0,
                    ),
                ),
              )

            const totals = {
              selected: 0,
              attempted: 0,
              stockUpdated: 0,
              autoPaused: 0,
              reactivated: 0,
              unchanged: 0,
              skipped: 0,
              pending: 0,
              failed: 0,
            }

            let batchCount = 0
            let failedBatchCount = 0

            for (
              let offset = 0;
              offset < listingIds.length;
              offset += 100
            ) {
              const batch =
                listingIds.slice(
                  offset,
                  offset + 100,
                )

              batchCount += 1

              const syncResponse =
                await dataConnectionsApi.request(
                  '/' +
                    item.connection.id +
                    '/sync-stock-to-allegro',
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type':
                        'application/json',
                    },
                    body: JSON.stringify({
                      confirm: true,
                      listingIds: batch,
                    }),
                  },
                )

              const syncResult =
                (await syncResponse
                  .json()
                  .catch(() => null)) as
                  | {
                      status?: string
                      message?: string
                      summary?: {
                        selected?: number
                        attempted?: number
                        stockUpdated?: number
                        autoPaused?: number
                        reactivated?: number
                        unchanged?: number
                        skipped?: number
                        pending?: number
                        failed?: number
                      }
                    }
                  | null

              if (
                !syncResponse.ok ||
                !syncResult?.summary
              ) {
                failedBatchCount += 1

                console.warn(
                  'Automatic Allegro stock sync batch failed:',
                  {
                    connectionId:
                      item.connection.id,
                    batch:
                      batchCount,
                    batchSize:
                      batch.length,
                    status:
                      syncResponse.status,
                    result:
                      syncResult,
                  },
                )

                continue
              }

              totals.selected +=
                syncResult.summary.selected ?? 0

              totals.attempted +=
                syncResult.summary.attempted ?? 0

              totals.stockUpdated +=
                syncResult.summary.stockUpdated ?? 0

              totals.autoPaused +=
                syncResult.summary.autoPaused ?? 0

              totals.reactivated +=
                syncResult.summary.reactivated ?? 0

              totals.unchanged +=
                syncResult.summary.unchanged ?? 0

              totals.skipped +=
                syncResult.summary.skipped ?? 0

              totals.pending +=
                syncResult.summary.pending ?? 0

              totals.failed +=
                syncResult.summary.failed ?? 0
            }

            console.log(
              'Automatic Allegro inventory sync completed:',
              {
                connectionId:
                  item.connection.id,
                connectionName:
                  item.connection.name,
                listings:
                  listingIds.length,
                batchCount,
                failedBatchCount,
                ...totals,
              },
            )
          }
        }
      } catch (error) {
        console.error(
          'Automatic inventory refresh error:',
          {
            connectionId:
              item.connection.id,
            error,
          },
        )
      } finally {
        const nextRunAt =
          calculateNextRunAt(
            settings,
            new Date(),
          )

        await db
          .update(
            dataConnectionSchedules,
          )
          .set({
            lastRunAt:
              startedAt,
            nextRunAt,
            updatedAt:
              new Date(),
          })
          .where(
            eq(
              dataConnectionSchedules.id,
              item.schedule.id,
            ),
          )
      }
    }
  } finally {
    refreshScheduleProcessorRunning =
      false
  }
}

/* ============================================================
   LIST CONNECTIONS
   ============================================================ */

dataConnectionsApi.get(
  '/',
  async (context) => {
    const database =
      requireDatabase()

    const rows =
      await database
        .select({
          connection:
            dataConnections,
          config:
            inventoryConnectionConfigs,
        })
        .from(dataConnections)
        .leftJoin(
          inventoryConnectionConfigs,
          eq(
            inventoryConnectionConfigs
              .connectionId,
            dataConnections.id,
          ),
        )
        .orderBy(
          desc(
            dataConnections.createdAt,
          ),
        )

    return context.json({
      data: rows,
    })
  },
)


/* ============================================================
   GOOGLE SHEETS INSPECTION
   ============================================================ */

dataConnectionsApi.post(
  '/google-sheets/inspect',
  async (context) => {
    try {
      const body =
        (await context.req
          .json()
          .catch(() => null)) as
          | {
              spreadsheet?:
                string
              sheetName?:
                string
              headerRow?:
                number
            }
          | null

      const spreadsheetId =
        body?.spreadsheet
          ? extractSpreadsheetId(
              body.spreadsheet,
            )
          : null

      if (!spreadsheetId) {
        return context.json(
          {
            error:
              'Érvénytelen Google Spreadsheet URL vagy ID.',
          },
          400,
        )
      }

      const metadata =
        await fetchSpreadsheetMetadata(
          spreadsheetId,
        )

      let headers:
        string[] | null = null

      if (body?.sheetName) {
        headers =
          await getHeaders(
            spreadsheetId,
            body.sheetName,
            Math.max(
              1,
              body.headerRow ?? 1,
            ),
          )
      }

      return context.json({
        spreadsheetId,
        title:
          metadata.properties
            ?.title ?? null,
        sheets:
          metadata.sheets
            ?.map((sheet) => ({
              id:
                sheet.properties
                  ?.sheetId ?? null,
              title:
                sheet.properties
                  ?.title ?? null,
              index:
                sheet.properties
                  ?.index ?? null,
              hidden:
                sheet.properties
                  ?.hidden ?? false,
            }))
            .filter(
              (sheet) =>
                sheet.title,
            ) ?? [],
        headers,
      })
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Google Sheets inspection failed.',
        },
        500,
      )
    }
  },
)


/* ============================================================
   CREATE CONNECTION
   ============================================================ */

dataConnectionsApi.post(
  '/',
  async (context) => {
    const database =
      requireDatabase()

    const body =
      (await context.req
        .json()
        .catch(() => null)) as
        | {
            name?: string
            spreadsheet?:
              string
            sheetName?: string
            headerRow?: number
            skuSourceField?:
              string
            stockSourceField?:
              string
          }
        | null

    const name =
      body?.name?.trim()

    const spreadsheet =
      body?.spreadsheet?.trim()

    const sheetName =
      body?.sheetName?.trim()

    const skuSourceField =
      body?.skuSourceField?.trim()

    const stockSourceField =
      body?.stockSourceField
        ?.trim()

    const spreadsheetId =
      spreadsheet
        ? extractSpreadsheetId(
            spreadsheet,
          )
        : null

    if (
      !name ||
      !spreadsheet ||
      !spreadsheetId ||
      !sheetName ||
      !skuSourceField ||
      !stockSourceField
    ) {
      return context.json(
        {
          error:
            'Hiányzó vagy hibás adatkapcsolati beállítás.',
        },
        400,
      )
    }

    const [connection] =
      await database
        .insert(
          dataConnections,
        )
        .values({
          name,
          sourceType:
            'GOOGLE_SHEETS',
          purpose:
            'INVENTORY',
          status:
            'NOT_CONFIGURED',
          isActive: false,
        })
        .returning()

    if (!connection) {
      return context.json(
        {
          error:
            'Az adatkapcsolat nem jött létre.',
        },
        500,
      )
    }

    try {
      const [config] =
        await database
          .insert(
            inventoryConnectionConfigs,
          )
          .values({
            connectionId:
              connection.id,
            spreadsheetId,
            spreadsheetUrl:
              spreadsheet,
            sheetName,
            headerRow:
              Math.max(
                1,
                body?.headerRow ?? 1,
              ),
            skuSourceField,
            stockSourceField,
          })
          .returning()

      return context.json(
        {
          connection,
          config,
        },
        201,
      )
    } catch (error) {
      await database
        .delete(dataConnections)
        .where(
          eq(
            dataConnections.id,
            connection.id,
          ),
        )

      throw error
    }
  },
)


/* ============================================================
   TEST CONNECTION
   ============================================================ */

dataConnectionsApi.post(
  '/:connectionId/test',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const stored =
      await getConnection(
        connectionId,
      )

    if (
      !stored ||
      !stored.config
    ) {
      return context.json(
        {
          error:
            'Adatkapcsolat nem található.',
        },
        404,
      )
    }

    try {
      const analysis =
        await analyzeInventorySheet(
          stored.config
            .spreadsheetId,
          stored.config
            .sheetName,
          stored.config
            .headerRow,
          stored.config
            .skuSourceField,
          stored.config
            .stockSourceField,
        )

      const hasDuplicates =
        analysis
          .duplicateSkuCount > 0

      await database
        .update(dataConnections)
        .set({
          status:
            hasDuplicates
              ? 'READY_WITH_WARNINGS'
              : 'READY',
          lastError: null,
          updatedAt:
            new Date(),
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )

      return context.json({
        ok: true,
        valid:
          !hasDuplicates,
        rowsRead:
          analysis.rowsRead,
        rowsImported:
          analysis.rowsImported,
        rowsNormalizedToZero:
          analysis
            .rowsNormalizedToZero,
        duplicateSkuCount:
          analysis
            .duplicateSkuCount,
        blankSkuCount:
          analysis.blankSkuCount,
        preview:
          analysis.items.slice(
            0,
            10,
          ),
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Connection test failed.'

      await database
        .update(dataConnections)
        .set({
          status: 'ERROR',
          lastError: message,
          updatedAt:
            new Date(),
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )

      return context.json(
        {
          ok: false,
          error: message,
        },
        500,
      )
    }
  },
)


/* ============================================================
   IMPORT INVENTORY
   ============================================================ */

dataConnectionsApi.post(
  '/:connectionId/import',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const stored =
      await getConnection(
        connectionId,
      )

    if (
      !stored ||
      !stored.config
    ) {
      return context.json(
        {
          error:
            'Adatkapcsolat nem található.',
        },
        404,
      )
    }

    const [run] =
      await database
        .insert(
          inventoryImportRuns,
        )
        .values({
          connectionId,
          status: 'RUNNING',
        })
        .returning()

    if (!run) {
      return context.json(
        {
          error:
            'Import futás nem hozható létre.',
        },
        500,
      )
    }

    try {
      const analysis =
        await analyzeInventorySheet(
          stored.config
            .spreadsheetId,
          stored.config
            .sheetName,
          stored.config
            .headerRow,
          stored.config
            .skuSourceField,
          stored.config
            .stockSourceField,
        )

      if (
        analysis.rowsImported === 0
      ) {
        const message =
          'A forrás nem tartalmaz használható cikkszámot.'

        const now =
          new Date()

        await database
          .update(
            inventoryImportRuns,
          )
          .set({
            status: 'FAILED',
            rowsRead:
              analysis.rowsRead,
            rowsImported: 0,
            rowsNormalizedToZero:
              analysis
                .rowsNormalizedToZero,
            duplicateSkuCount:
              analysis
                .duplicateSkuCount,
            changedItemCount: 0,
            sourceFingerprint:
              analysis.fingerprint,
            error: message,
            finishedAt: now,
          })
          .where(
            eq(
              inventoryImportRuns.id,
              run.id,
            ),
          )

        await database
          .update(dataConnections)
          .set({
            status: 'ERROR',
            lastError: message,
            updatedAt: now,
          })
          .where(
            eq(
              dataConnections.id,
              connectionId,
            ),
          )

        return context.json(
          {
            status: 'FAILED',
            error: message,
            rowsRead:
              analysis.rowsRead,
            rowsImported: 0,
          },
          422,
        )
      }
      if (
        analysis
          .duplicateSkuCount > 0
      ) {
        await database
          .update(
            inventoryImportRuns,
          )
          .set({
            status: 'FAILED',
            rowsRead:
              analysis.rowsRead,
            rowsImported: 0,
            rowsNormalizedToZero:
              analysis
                .rowsNormalizedToZero,
            duplicateSkuCount:
              analysis
                .duplicateSkuCount,
            sourceFingerprint:
              analysis.fingerprint,
            error:
              'Duplikált cikkszám található a forrásban.',
            finishedAt:
              new Date(),
          })
          .where(
            eq(
              inventoryImportRuns.id,
              run.id,
            ),
          )

        return context.json(
          {
            error:
              'Duplikált cikkszám található a forrásban.',
            duplicateSkuCount:
              analysis
                .duplicateSkuCount,
          },
          409,
        )
      }

      const [previousRun] =
        await database
          .select({
            sourceFingerprint:
              inventoryImportRuns
                .sourceFingerprint,
          })
          .from(
            inventoryImportRuns,
          )
          .where(
            and(
              eq(
                inventoryImportRuns
                  .connectionId,
                connectionId,
              ),
              or(
                eq(
                  inventoryImportRuns
                    .status,
                  'SUCCESS',
                ),
                eq(
                  inventoryImportRuns
                    .status,
                  'NO_CHANGE',
                ),
              ),
            ),
          )
          .orderBy(
            desc(
              inventoryImportRuns
                .startedAt,
            ),
          )
          .limit(1)

      const now =
        new Date()

      if (
        previousRun
          ?.sourceFingerprint ===
        analysis.fingerprint
      ) {
        await database
          .update(
            inventoryImportRuns,
          )
          .set({
            status:
              'NO_CHANGE',
            rowsRead:
              analysis.rowsRead,
            rowsImported:
              analysis.rowsImported,
            rowsNormalizedToZero:
              analysis
                .rowsNormalizedToZero,
            duplicateSkuCount: 0,
            changedItemCount: 0,
            sourceFingerprint:
              analysis.fingerprint,
            finishedAt: now,
          })
          .where(
            eq(
              inventoryImportRuns.id,
              run.id,
            ),
          )

        await database
          .update(
            dataConnections,
          )
          .set({
            status: 'READY',
            lastSuccessfulAt:
              now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            eq(
              dataConnections.id,
              connectionId,
            ),
          )

        return context.json({
          status: 'NO_CHANGE',
          rowsRead:
            analysis.rowsRead,
          rowsImported:
            analysis.rowsImported,
          rowsNormalizedToZero:
            analysis
              .rowsNormalizedToZero,
          changedItemCount: 0,
        })
      }

      const existingItems =
        await database
          .select({
            sku:
              inventorySourceItems
                .sku,
            stock:
              inventorySourceItems
                .stock,
          })
          .from(
            inventorySourceItems,
          )
          .where(
            eq(
              inventorySourceItems
                .connectionId,
              connectionId,
            ),
          )

      const existingBySku =
        new Map(
          existingItems.map(
            (item) => [
              item.sku,
              item.stock,
            ],
          ),
        )

      const currentSkuSet =
        new Set(
          analysis.items.map(
            (item) => item.sku,
          ),
        )

      const updatedOrAddedItemCount =
        analysis.items.filter(
          (item) =>
            existingBySku.get(
              item.sku,
            ) !== item.stock,
        ).length

      const removedItemCount =
        existingItems.filter(
          (item) =>
            !currentSkuSet.has(
              item.sku,
            ),
        ).length

      const changedItemCount =
        updatedOrAddedItemCount +
        removedItemCount

      const chunkSize = 200

      for (
        let offset = 0;
        offset <
        analysis.items.length;
        offset += chunkSize
      ) {
        const chunk =
          analysis.items.slice(
            offset,
            offset + chunkSize,
          )

        await database
          .insert(
            inventorySourceItems,
          )
          .values(
            chunk.map(
              (item) => ({
                connectionId,
                sku: item.sku,
                stock:
                  item.stock,
                sourceStockValue:
                  item
                    .sourceStockValue,
                normalizedToZero:
                  item
                    .normalizedToZero,
                lastImportRunId:
                  run.id,
                observedAt:
                  now,
                updatedAt:
                  now,
              }),
            ),
          )
          .onConflictDoUpdate({
            target: [
              inventorySourceItems
                .connectionId,
              inventorySourceItems
                .sku,
            ],
            set: {
              stock:
                sql`excluded.stock`,
              sourceStockValue:
                sql`excluded.source_stock_value`,
              normalizedToZero:
                sql`excluded.normalized_to_zero`,
              lastImportRunId:
                sql`excluded.last_import_run_id`,
              observedAt:
                sql`excluded.observed_at`,
              updatedAt:
                sql`excluded.updated_at`,
            },
          })
      }

      /*
       * Remove items that are not part of the new full snapshot.
       *
       * Every item seen in this import has already been upserted
       * with lastImportRunId = run.id. Anything else belongs to
       * an older snapshot and must no longer remain active.
       */
      await database
        .delete(
          inventorySourceItems,
        )
        .where(
          and(
            eq(
              inventorySourceItems
                .connectionId,
              connectionId,
            ),
            or(
              isNull(
                inventorySourceItems
                  .lastImportRunId,
              ),
              ne(
                inventorySourceItems
                  .lastImportRunId,
                run.id,
              ),
            ),
          ),
        )
      await database
        .update(
          inventoryImportRuns,
        )
        .set({
          status: 'SUCCESS',
          rowsRead:
            analysis.rowsRead,
          rowsImported:
            analysis.rowsImported,
          rowsNormalizedToZero:
            analysis
              .rowsNormalizedToZero,
          duplicateSkuCount: 0,
          changedItemCount,
          sourceFingerprint:
            analysis.fingerprint,
          finishedAt: now,
        })
        .where(
          eq(
            inventoryImportRuns.id,
            run.id,
          ),
        )

      await database
        .update(
          dataConnections,
        )
        .set({
          status: 'READY',
          lastSuccessfulAt:
            now,
          lastError: null,
          updatedAt: now,
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )

      return context.json({
        status: 'SUCCESS',
        rowsRead:
          analysis.rowsRead,
        rowsImported:
          analysis.rowsImported,
        rowsNormalizedToZero:
          analysis
            .rowsNormalizedToZero,
        changedItemCount,
        removedItemCount,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Inventory import failed.'

      await database
        .update(
          inventoryImportRuns,
        )
        .set({
          status: 'FAILED',
          error: message,
          finishedAt:
            new Date(),
        })
        .where(
          eq(
            inventoryImportRuns.id,
            run.id,
          ),
        )

      await database
        .update(dataConnections)
        .set({
          status: 'ERROR',
          lastError: message,
          updatedAt:
            new Date(),
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )

      return context.json(
        {
          status: 'FAILED',
          error: message,
        },
        500,
      )
    }
  },
)


/* ============================================================
   ACTIVATE INVENTORY SOURCE
   ============================================================ */

dataConnectionsApi.post(
  '/:connectionId/activate',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const [connection] =
      await database
        .select()
        .from(dataConnections)
        .where(
          and(
            eq(
              dataConnections.id,
              connectionId,
            ),
            eq(
              dataConnections.purpose,
              'INVENTORY',
            ),
          ),
        )
        .limit(1)

    if (!connection) {
      return context.json(
        {
          error:
            'Készlet adatkapcsolat nem található.',
        },
        404,
      )
    }

    if (
      connection.status !== 'READY' &&
      connection.status !== 'ACTIVE'
    ) {
      return context.json(
        {
          error:
            'Csak sikeresen tesztelt adatkapcsolat állítható be aktív készletforrásként.',
        },
        409,
      )
    }

    const now =
      new Date()

    await database
      .update(dataConnections)
      .set({
        isActive: false,
        updatedAt: now,
      })
      .where(
        eq(
          dataConnections.purpose,
          'INVENTORY',
        ),
      )

    const [activated] =
      await database
        .update(dataConnections)
        .set({
          isActive: true,
          updatedAt: now,
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )
        .returning()

    return context.json({
      connection: activated,
    })
  },
)

/* ============================================================
   ALLEGRO STOCK SYNC PREVIEW
   READ ONLY - NO DESIRED STATE OR ALLEGRO WRITE
   ============================================================ */

dataConnectionsApi.get(
  '/:connectionId/allegro-stock-preview',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const [connection] =
      await database
        .select()
        .from(dataConnections)
        .where(
          and(
            eq(
              dataConnections.id,
              connectionId,
            ),
            eq(
              dataConnections.purpose,
              'INVENTORY',
            ),
          ),
        )
        .limit(1)

    if (!connection) {
      return context.json(
        {
          error:
            'Készlet adatkapcsolat nem található.',
        },
        404,
      )
    }

    const inventoryItems =
      await database
        .select({
          sku:
            inventorySourceItems.sku,
          stock:
            inventorySourceItems.stock,
          normalizedToZero:
            inventorySourceItems
              .normalizedToZero,
          observedAt:
            inventorySourceItems
              .observedAt,
        })
        .from(
          inventorySourceItems,
        )
        .where(
          eq(
            inventorySourceItems
              .connectionId,
            connectionId,
          ),
        )

    const allegroListings =
      await database
        .select({
          listingId:
            platformListings.id,

          offerId:
            platformListings
              .externalListingId,

          sku:
            products.sku,

          listingName:
            platformListings
              .listingName,

          marketplace:
            platformListings
              .marketplace,

          remoteStock:
            listingRemoteStates
              .stockAvailable,

          desiredStock:
            listingDesiredStates
              .desiredStock,

          stockLocked:
            listingDesiredStates
              .stockLocked,

          autoStockSync:
            listingDesiredStates
              .autoStockSync,

          publicationStatus:
            listingRemoteStates
              .publicationStatus,

      stockAutoPaused:
        listingDesiredStates
          .stockAutoPaused,

      desiredPublicationStatus:
        listingDesiredStates
          .desiredPublicationStatus,
        })
        .from(
          platformListings,
        )
        .innerJoin(
          products,
          eq(
            platformListings.productId,
            products.id,
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
            listingRemoteStates
              .listingId,
            platformListings.id,
          ),
        )
        .leftJoin(
          listingDesiredStates,
          eq(
            listingDesiredStates
              .listingId,
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
              platformListings
                .marketplace,
              'allegro-hu',
            ),
          ),
        )

    const inventoryBySku =
      new Map(
        inventoryItems.map(
          (item) => [
            item.sku,
            item,
          ],
        ),
      )

    const listingsBySku =
      new Map<
        string,
        typeof allegroListings
      >()

    for (
      const listing of
      allegroListings
    ) {
      const current =
        listingsBySku.get(
          listing.sku,
        ) ?? []

      current.push(listing)

      listingsBySku.set(
        listing.sku,
        current,
      )
    }

    const rows =
      allegroListings.map(
        (listing) => {
          const source =
            inventoryBySku.get(
              listing.sku,
            )

          const duplicateOfferCount =
            listingsBySku.get(
              listing.sku,
            )?.length ?? 1

          if (!source) {
            /*
             * Manuálisan rögzített készlet esetén
             * a hiányzó forrásadat sem írhatja felül.
             */
            if (listing.stockLocked) {
              return {
                sku: listing.sku,
                listingId: listing.listingId,
                offerId: listing.offerId,
                listingName: listing.listingName,
                publicationStatus: listing.publicationStatus,
                stockAutoPaused: listing.stockAutoPaused ?? false,
                desiredPublicationStatus: listing.desiredPublicationStatus ?? 'UNKNOWN',

                sourceStock: null,
                sourceMissing: true,
                targetStock: listing.desiredStock,

                remoteStock: listing.remoteStock,
                desiredStock: listing.desiredStock,

                stockLocked: true,
                autoStockSync: listing.autoStockSync ?? false,
                duplicateOfferCount,

                reason: 'MANUAL_LOCK',
                status: 'LOCKED',
              }
            }

            /*
             * Nincs SKU a készletforrásban:
             * nincs igazolt eladható készlet, ezért a cél 0.
             */
            const targetStock = 0

            return {
              sku: listing.sku,
              listingId: listing.listingId,
              offerId: listing.offerId,
              listingName: listing.listingName,
              publicationStatus: listing.publicationStatus,
              stockAutoPaused: listing.stockAutoPaused ?? false,
              desiredPublicationStatus: listing.desiredPublicationStatus ?? 'UNKNOWN',

              sourceStock: null,
              sourceMissing: true,
              targetStock,

              remoteStock: listing.remoteStock,
              desiredStock: listing.desiredStock,

              stockLocked: false,
              autoStockSync: listing.autoStockSync ?? false,
              duplicateOfferCount,

              reason: 'MISSING_SOURCE',

              status:
                listing.remoteStock === null
                  ? 'REMOTE_STOCK_UNKNOWN'
                  : listing.remoteStock === targetStock
                    ? 'NO_CHANGE'
                    : 'CHANGE_NEEDED',
            }
          }

          if (
            listing.stockLocked
          ) {
            return {
              sku:
                listing.sku,
              listingId:
                listing.listingId,
              offerId:
                listing.offerId,
              listingName:
                listing.listingName,
              publicationStatus:
                listing
                  .publicationStatus,
              stockAutoPaused: listing.stockAutoPaused ?? false,
              desiredPublicationStatus: listing.desiredPublicationStatus ?? 'UNKNOWN',

              sourceStock:
                source.stock,

              sourceMissing: false,

              targetStock:
                listing.stockLocked
                  ? listing.desiredStock
                  : source.stock,

              remoteStock:
                listing.remoteStock,
              desiredStock:
                listing.desiredStock,

              stockLocked: true,

              autoStockSync:
                listing.autoStockSync ??
                false,

              duplicateOfferCount,

              reason:
                'MANUAL_LOCK',

              status:
                'LOCKED',
            }
          }

          if (
            listing.remoteStock ===
            null
          ) {
            return {
              sku:
                listing.sku,
              listingId:
                listing.listingId,
              offerId:
                listing.offerId,
              listingName:
                listing.listingName,
              publicationStatus:
                listing
                  .publicationStatus,
              stockAutoPaused: listing.stockAutoPaused ?? false,
              desiredPublicationStatus: listing.desiredPublicationStatus ?? 'UNKNOWN',

              sourceStock:
                source.stock,

              sourceMissing: false,

              targetStock:
                listing.stockLocked
                  ? listing.desiredStock
                  : source.stock,

              remoteStock: null,
              desiredStock:
                listing.desiredStock,

              stockLocked: false,

              autoStockSync:
                listing.autoStockSync ??
                false,

              duplicateOfferCount,

              reason: null,

              status:
                'REMOTE_STOCK_UNKNOWN',
            }
          }

          return {
            sku:
              listing.sku,
            listingId:
              listing.listingId,
            offerId:
              listing.offerId,
            listingName:
              listing.listingName,
            publicationStatus:
              listing
                .publicationStatus,
            stockAutoPaused: listing.stockAutoPaused ?? false,
            desiredPublicationStatus: listing.desiredPublicationStatus ?? 'UNKNOWN',

            sourceStock:
                source.stock,

              sourceMissing: false,

              targetStock:
                listing.stockLocked
                  ? listing.desiredStock
                  : source.stock,

              remoteStock:
              listing.remoteStock,
            desiredStock:
              listing.desiredStock,

            stockLocked: false,

            autoStockSync:
              listing.autoStockSync ??
              false,

            duplicateOfferCount,

            reason: null,

              status:
              source.stock ===
              listing.remoteStock
                ? 'NO_CHANGE'
                : 'CHANGE_NEEDED',
          }
        },
      )

    const matchedSkuSet =
      new Set(
        allegroListings
          .filter((listing) =>
            inventoryBySku.has(
              listing.sku,
            ),
          )
          .map(
            (listing) =>
              listing.sku,
          ),
      )

    const inventoryWithoutListing =
      inventoryItems.filter(
        (item) =>
          !listingsBySku.has(
            item.sku,
          ),
      )

    const duplicateSkuCount =
      [...listingsBySku.values()]
        .filter(
          (listings) =>
            listings.length > 1,
        )
        .length

    return context.json({
      connection: {
        id:
          connection.id,
        name:
          connection.name,
        isActive:
          connection.isActive,
      },

      summary: {
        inventorySkuCount:
          inventoryItems.length,

        allegroListingCount:
          allegroListings.length,

        matchedSkuCount:
          matchedSkuSet.size,

        changeNeededCount:
          rows.filter(
            (row) =>
              row.status ===
              'CHANGE_NEEDED',
          ).length,

        noChangeCount:
          rows.filter(
            (row) =>
              row.status ===
              'NO_CHANGE',
          ).length,

        lockedCount:
          rows.filter(
            (row) =>
              row.status ===
              'LOCKED',
          ).length,

    missingSourceCount:
      rows.filter(
        (row) =>
          'sourceMissing' in row &&
          row.sourceMissing === true,
      ).length,

    missingSourceChangeNeededCount:
      rows.filter(
        (row) =>
          'sourceMissing' in row &&
          row.sourceMissing === true &&
          row.status === 'CHANGE_NEEDED',
      ).length,

        remoteStockUnknownCount:
          rows.filter(
            (row) =>
              row.status ===
              'REMOTE_STOCK_UNKNOWN',
          ).length,

        inventoryWithoutListingCount:
          inventoryWithoutListing
            .length,

        duplicateSkuCount,
      },

      rows,

      inventoryWithoutListing:
        inventoryWithoutListing
          .slice(0, 50)
          .map((item) => ({
            sku:
              item.sku,
            stock:
              item.stock,
          })),
    })
  },
)

/* ============================================================
   CURRENT IMPORTED INVENTORY
   ============================================================ */

/* ============================================================
   APPLY INVENTORY TO DESIRED STOCK
   INTERNAL ONLY - NO ALLEGRO PUSH
   ============================================================ */

dataConnectionsApi.post(
  '/:connectionId/apply-stock-desired',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    /*
     * Ugyanazt a read-only preview logikát használjuk,
     * amit már ellenőriztünk.
     */
    const previewResponse =
      await dataConnectionsApi.request(
        `/${connectionId}/allegro-stock-preview`,
        {
          method: 'GET',
        },
      )

    if (!previewResponse.ok) {
      const previewError =
        await previewResponse
          .json()
          .catch(() => null)

      return context.json(
        {
          error:
            'A készletszinkron előnézet nem tölthető be.',
          details:
            previewError,
        },
        previewResponse.status as 400 | 404 | 409 | 500,
      )
    }

    const preview =
      (await previewResponse.json()) as {
        connection: {
          id: string
          name: string
          isActive: boolean
        }

        summary: {
          inventorySkuCount: number
          allegroListingCount: number
        }

        rows: Array<{
          sku: string
          listingId: string
          offerId: string | null
          listingName: string | null
          sourceStock: number | null
          remoteStock: number | null
          desiredStock: number | null
          stockLocked: boolean
          autoStockSync: boolean
          duplicateOfferCount: number
          status: string
        }>
      }

    if (!preview.connection.isActive) {
      return context.json(
        {
          error:
            'Csak az aktív készletforrás alkalmazható.',
        },
        409,
      )
    }

    let updated = 0
    let unchanged = 0
    let missingSource = 0
    let locked = 0
    let duplicateSkuSkipped = 0
    let remoteStockUnknown = 0
    let missingDesiredState = 0

    const results: Array<{
      sku: string
      listingId: string
      offerId: string | null
      previousDesiredStock: number | null
      newDesiredStock: number | null
      status: string
    }> = []

    for (
      const row of preview.rows
    ) {
      /*
       * 1. Manuálisan rögzített készlet.
       *
       * Ez minden automatikus készletforrásnál
       * magasabb prioritású.
       */
      if (row.stockLocked) {
        locked += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            row.desiredStock,
          status:
            'LOCKED',
        })

        continue
      }

      /*
       * 2. Ugyanaz a SKU több Allegro ajánlaton.
       *
       * Ezt egyelőre nem automatizáljuk.
       */
      if (
        row.duplicateOfferCount > 1
      ) {
        duplicateSkuSkipped += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            row.sourceStock ?? 0,
          status:
            'DUPLICATE_SKU_SKIPPED',
        })

        continue
      }

      /*
       * 3. A SKU nincs az aktív készletforrásban.
       *
       * Ebben az esetben nincs igazolt eladható
       * készletünk, ezért a biztonságos célérték 0.
       */
      if (
        row.status ===
          'MISSING_SOURCE' ||
        row.sourceStock === null
      ) {
        missingSource += 1

        if (
          row.desiredStock === 0
        ) {
          unchanged += 1

          results.push({
            sku:
              row.sku,
            listingId:
              row.listingId,
            offerId:
              row.offerId,
            previousDesiredStock:
              row.desiredStock,
            newDesiredStock:
              0,
            status:
              'MISSING_SOURCE_ZERO_NO_CHANGE',
          })

          continue
        }

        const [updatedRow] =
          await database
            .update(
              listingDesiredStates,
            )
            .set({
              desiredStock:
                0,

              updatedBy:
                'COMMERCE_HUB_INVENTORY',

              updatedAt:
                new Date(),
            })
            .where(
              eq(
                listingDesiredStates
                  .listingId,
                row.listingId,
              ),
            )
            .returning({
              listingId:
                listingDesiredStates
                  .listingId,
            })

        if (!updatedRow) {
          missingDesiredState += 1

          results.push({
            sku:
              row.sku,
            listingId:
              row.listingId,
            offerId:
              row.offerId,
            previousDesiredStock:
              row.desiredStock,
            newDesiredStock:
              0,
            status:
              'MISSING_DESIRED_STATE',
          })

          continue
        }

        updated += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            0,
          status:
            'MISSING_SOURCE_ZERO_APPLIED',
        })

        continue
      }
      /*
       * Ha az Allegro aktuális készletét nem ismerjük,
       * egyelőre szintén nem automatizálunk.
       */
      if (
        row.status ===
        'REMOTE_STOCK_UNKNOWN'
      ) {
        remoteStockUnknown += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            row.sourceStock,
          status:
            'REMOTE_STOCK_UNKNOWN',
        })

        continue
      }

      /*
       * A kívánt készlet már megegyezik
       * a forráskészlettel.
       */
      if (
        row.desiredStock ===
        row.sourceStock
      ) {
        unchanged += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            row.sourceStock,
          status:
            'NO_CHANGE',
        })

        continue
      }

      const [updatedRow] =
        await database
          .update(
            listingDesiredStates,
          )
          .set({
            desiredStock:
              row.sourceStock,

            updatedBy:
              'COMMERCE_HUB_INVENTORY',

            updatedAt:
              new Date(),
          })
          .where(
            eq(
              listingDesiredStates
                .listingId,
              row.listingId,
            ),
          )
          .returning({
            listingId:
              listingDesiredStates
                .listingId,
          })

      /*
       * Ha nincs desired-state rekord,
       * nem hozunk létre automatikusan újat.
       */
      if (!updatedRow) {
        missingDesiredState += 1

        results.push({
          sku:
            row.sku,
          listingId:
            row.listingId,
          offerId:
            row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock:
            row.sourceStock,
          status:
            'MISSING_DESIRED_STATE',
        })

        continue
      }

      updated += 1

      results.push({
        sku:
          row.sku,
        listingId:
          row.listingId,
        offerId:
          row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.sourceStock,
        status:
          'UPDATED',
      })
    }

    return context.json({
      status:
        'ok',

      mode:
        'DESIRED_STOCK_ONLY',

      allegroPushPerformed:
        false,

      summary: {
        inventorySkuCount:
          preview.summary
            .inventorySkuCount,

        allegroListingCount:
          preview.summary
            .allegroListingCount,

        updated,
        unchanged,
        missingSource,
        locked,
        duplicateSkuSkipped,
        remoteStockUnknown,
        missingDesiredState,
      },

      results,
    })
  },
)

dataConnectionsApi.get(
  '/:connectionId/items',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const [latestRun] =
      await database
        .select({
          id:
            inventoryImportRuns.id,
          status:
            inventoryImportRuns.status,
          startedAt:
            inventoryImportRuns.startedAt,
          finishedAt:
            inventoryImportRuns.finishedAt,
        })
        .from(
          inventoryImportRuns,
        )
        .where(
          and(
            eq(
              inventoryImportRuns
                .connectionId,
              connectionId,
            ),
            eq(
              inventoryImportRuns
                .status,
              'SUCCESS',
            ),
          ),
        )
        .orderBy(
          desc(
            inventoryImportRuns
              .startedAt,
          ),
        )
        .limit(1)

    if (!latestRun) {
      return context.json({
        run: null,
        data: [],
      })
    }

    const items =
      await database
        .select({
          sku:
            inventorySourceItems.sku,
          stock:
            inventorySourceItems.stock,
          sourceStockValue:
            inventorySourceItems
              .sourceStockValue,
          normalizedToZero:
            inventorySourceItems
              .normalizedToZero,
          observedAt:
            inventorySourceItems
              .observedAt,
        })
        .from(
          inventorySourceItems,
        )
        .where(
          eq(
            inventorySourceItems
              .lastImportRunId,
            latestRun.id,
          ),
        )

    return context.json({
      run: latestRun,
      data: items,
    })
  },
)


/* ============================================================
   SYNC INVENTORY STOCK TO ALLEGRO
   MANUAL + EXPLICIT CONFIRMATION
   ============================================================ */

dataConnectionsApi.post(
  '/:connectionId/sync-stock-to-allegro',
  async (context) => {
    const database = requireDatabase()
    const connectionId = context.req.param('connectionId')

    const body =
      (await context.req.json().catch(() => null)) as
        | {
            confirm?: boolean
            listingIds?: string[]
          }
        | null

    if (body?.confirm !== true) {
      return context.json(
        {
          status: 'error',
          message: 'Explicit confirm=true is required',
        },
        400,
      )
    }

    /*
     * Először a forrás alapján frissítjük a desiredStock értékeket.
     * Ez még önmagában nem ír az Allegróra.
     */
    const applyResponse =
      await dataConnectionsApi.request(
        '/' + connectionId + '/apply-stock-desired',
        { method: 'POST' },
      )

    const applyDetails =
      await applyResponse.json().catch(() => null)

    if (!applyResponse.ok) {
      return context.json(
        {
          status: 'error',
          message: 'Could not apply inventory desired stock',
          details: applyDetails,
        },
        409,
      )
    }

    /* Friss preview már az alkalmazott desiredStock alapján. */
    const previewResponse =
      await dataConnectionsApi.request(
        '/' + connectionId + '/allegro-stock-preview',
        { method: 'GET' },
      )

    if (!previewResponse.ok) {
      return context.json(
        {
          status: 'error',
          message: 'Could not load stock sync preview',
        },
        502,
      )
    }

    const preview =
      (await previewResponse.json()) as {
        connection: {
          id: string
          isActive: boolean
        }
        rows: Array<{
          sku: string
          listingId: string
          offerId: string | null
          targetStock: number | null
          remoteStock: number | null
          desiredStock: number | null
          stockLocked: boolean
          stockAutoPaused: boolean
          publicationStatus: string | null
          desiredPublicationStatus: string
          duplicateOfferCount: number
        }>
      }

    if (!preview.connection.isActive) {
      return context.json(
        {
          status: 'error',
          message: 'Only the active inventory source can be synced',
        },
        409,
      )
    }

    const requestedIds =
      new Set(
        (body.listingIds ?? []).map(String),
      )

    const rows =
      requestedIds.size > 0
        ? preview.rows.filter((row) =>
            requestedIds.has(row.listingId),
          )
        : preview.rows

    if (rows.length > 100) {
      return context.json(
        {
          status: 'error',
          message: 'Maximum 100 listings per stock sync run',
          count: rows.length,
        },
        409,
      )
    }

    const results: Array<Record<string, unknown>> = []

    let attempted = 0
    let stockUpdated = 0
    let autoPaused = 0
    let reactivated = 0
    let unchanged = 0
    let skipped = 0
    let pending = 0
    let failed = 0

    const postAllegro = async (path: string) => {
      const response =
        await allegroAuth.request(
          path,
          { method: 'POST' },
        )

      const details =
        (await response.json().catch(() => null)) as
          | {
              status?: string
              message?: string
            }
          | null

      return { response, details }
    }

    for (const row of rows) {

      if (row.stockLocked) {
        skipped += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'STOCK_LOCKED',
        })
        continue
      }

      if (row.duplicateOfferCount > 1) {
        skipped += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'DUPLICATE_SKU',
        })
        continue
      }

      if (row.targetStock === null) {
        skipped += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'TARGET_STOCK_UNKNOWN',
        })
        continue
      }

      const remoteEnded =
        row.publicationStatus === 'ENDED' ||
        row.publicationStatus === 'INACTIVE'

      const remoteActive =
        row.publicationStatus === 'ACTIVE' ||
        row.publicationStatus === 'ACTIVATING'

      /* ======================================================
         TARGET STOCK = 0
         Allegro quantity=0 nem használható, ezért END.
         ====================================================== */

      if (row.targetStock === 0) {

        if (row.stockAutoPaused && remoteEnded) {
          unchanged += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'NONE',
            status: 'ALREADY_AUTO_PAUSED',
          })
          continue
        }

        if (!row.stockAutoPaused && remoteEnded) {
          skipped += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'SKIP',
            status: 'MANUAL_INACTIVE',
          })
          continue
        }

        if (!remoteActive) {
          skipped += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'SKIP',
            status: 'UNSUPPORTED_PUBLICATION_STATE',
            publicationStatus: row.publicationStatus,
          })
          continue
        }

        await database
          .update(listingDesiredStates)
          .set({
            desiredPublicationStatus: 'INACTIVE',
            updatedBy: 'COMMERCE_HUB_INVENTORY',
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        attempted += 1

        const push =
          await postAllegro(
            '/push-status/' +
              encodeURIComponent(row.listingId),
          )

        if (push.response.status === 202) {
          pending += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'END',
            status: 'PENDING',
            details: push.details,
          })
          continue
        }

        if (!push.response.ok || push.details?.status !== 'ok') {
          failed += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'END',
            status: 'FAILED',
            details: push.details,
          })
          continue
        }

        await database
          .update(listingDesiredStates)
          .set({
            stockAutoPaused: true,
            updatedBy: 'COMMERCE_HUB_INVENTORY',
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        autoPaused += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'END',
          status: 'SUCCESS',
        })

        continue
      }

      /* ======================================================
         TARGET STOCK > 0
         ====================================================== */

      if (!row.stockAutoPaused && remoteEnded) {
        skipped += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'MANUAL_INACTIVE',
        })
        continue
      }

      if (row.remoteStock === null) {
        skipped += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'REMOTE_STOCK_UNKNOWN',
        })
        continue
      }

      let stockChanged = false

      if (row.remoteStock !== row.targetStock) {
        attempted += 1

        const push =
          await postAllegro(
            '/push-stock/' +
              encodeURIComponent(row.listingId),
          )

        if (push.response.status === 202) {
          pending += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'STOCK_UPDATE',
            status: 'PENDING',
            fromStock: row.remoteStock,
            toStock: row.targetStock,
            details: push.details,
          })
          continue
        }

        if (!push.response.ok || push.details?.status !== 'ok') {
          failed += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'STOCK_UPDATE',
            status: 'FAILED',
            fromStock: row.remoteStock,
            toStock: row.targetStock,
            details: push.details,
          })
          continue
        }

        stockChanged = true
        stockUpdated += 1
      }

      if (row.stockAutoPaused) {

        await database
          .update(listingDesiredStates)
          .set({
            desiredPublicationStatus: 'ACTIVE',
            updatedBy: 'COMMERCE_HUB_INVENTORY',
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        attempted += 1

        const push =
          await postAllegro(
            '/push-status/' +
              encodeURIComponent(row.listingId),
          )

        if (push.response.status === 202) {
          pending += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'ACTIVATE',
            status: 'PENDING',
            stockUpdated: stockChanged,
            details: push.details,
          })
          continue
        }

        if (!push.response.ok || push.details?.status !== 'ok') {
          failed += 1
          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'ACTIVATE',
            status: 'FAILED',
            stockUpdated: stockChanged,
            details: push.details,
          })
          continue
        }

        await database
          .update(listingDesiredStates)
          .set({
            stockAutoPaused: false,
            updatedBy: 'COMMERCE_HUB_INVENTORY',
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        reactivated += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: stockChanged
            ? 'STOCK_UPDATE_AND_ACTIVATE'
            : 'ACTIVATE',
          status: 'SUCCESS',
        })

        continue
      }

      if (stockChanged) {
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'STOCK_UPDATE',
          status: 'SUCCESS',
          fromStock: row.remoteStock,
          toStock: row.targetStock,
        })
      } else {
        unchanged += 1
        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'NONE',
          status: 'NO_CHANGE',
        })
      }
    }

    let refreshStatus = 'not-needed'
    let refreshDetails: unknown = null

    if (attempted > 0) {
      const refreshResponse =
        await allegroAuth.request(
          '/sync',
          { method: 'POST' },
        )

      refreshDetails =
        await refreshResponse.json().catch(() => null)

      refreshStatus =
        refreshResponse.ok
          ? 'success'
          : 'failed'
    }

    return context.json({
      status: 'ok',
      mode: 'MANUAL_CONFIRMED_STOCK_SYNC',
      summary: {
        selected: rows.length,
        attempted,
        stockUpdated,
        autoPaused,
        reactivated,
        unchanged,
        skipped,
        pending,
        failed,
      },
      applyDetails,
      refresh: {
        status: refreshStatus,
        details: refreshDetails,
      },
      results,
    })
  },
)

export {
  dataConnectionsApi,
}
