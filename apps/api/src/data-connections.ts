import { createHash } from 'node:crypto'

import {
  createDatabase,
  dataConnections,
  dataConnectionSchedules,
  dataConnectionRuns,
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
import { runInventoryRefreshAutomations } from './platform-automation.js'

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


/* ============================================================
   LATEST DATA CONNECTION RUN
   ============================================================ */

dataConnectionsApi.get(
  '/:connectionId/runs/latest',
  async (context) => {
    const database =
      requireDatabase()

    const connectionId =
      context.req.param(
        'connectionId',
      )

    const [run] =
      await database
        .select({
          id:
            dataConnectionRuns.id,
          connectionId:
            dataConnectionRuns.connectionId,
          triggerType:
            dataConnectionRuns.triggerType,
          status:
            dataConnectionRuns.status,
          importStatus:
            dataConnectionRuns.importStatus,
          rowsImported:
            dataConnectionRuns.rowsImported,
          changedItemCount:
            dataConnectionRuns.changedItemCount,
          error:
            dataConnectionRuns.error,
          startedAt:
            dataConnectionRuns.startedAt,
          finishedAt:
            dataConnectionRuns.finishedAt,
        })
        .from(dataConnectionRuns)
        .where(
          eq(
            dataConnectionRuns.connectionId,
            connectionId,
          ),
        )
        .orderBy(
          desc(
            dataConnectionRuns.startedAt,
          ),
        )
        .limit(1)

    return context.json({
      run: run ?? null,
    })
  },
)


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

export interface DataConnectionScheduleProcessorOptions {
  beforeAutomation?: () => Promise<void> | void
}

export async function processDueDataConnectionSchedules(
  options?: DataConnectionScheduleProcessorOptions,
): Promise<boolean> {
  if (
    refreshScheduleProcessorRunning
  ) {
    return false
  }

  if (!db) {
    return false
  }

  refreshScheduleProcessorRunning =
    true

  let processedAnySchedule = false

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

    processedAnySchedule =
      dueSchedules.length > 0

    for (
      const item of dueSchedules
    ) {
      const startedAt =
        new Date()

      const [connectionRun] =
        await db
          .insert(dataConnectionRuns)
          .values({
            connectionId:
              item.connection.id,
            triggerType: 'SCHEDULED',
            status: 'RUNNING',
            startedAt,
          })
          .returning({
            id: dataConnectionRuns.id,
          })

      if (!connectionRun) {
        throw new Error(
          'Data connection run could not be created.',
        )
      }

      let runStatus = 'COMPLETED'
      let runImportStatus: string | null = null
      let runRowsImported = 0
      let runChangedItemCount = 0
      let runError: string | null = null

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
              `/${item.connection.id}/import`,
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

        runImportStatus =
          result?.status ?? null

        runRowsImported =
          result?.rowsImported ?? 0

        runChangedItemCount =
          result?.changedItemCount ?? 0

        if (!response.ok) {
          runStatus = 'FAILED'
          runError =
            result?.error ??
            'Automatic inventory import failed.'

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

          try {
            if (options?.beforeAutomation) {
              await options.beforeAutomation()
            }
          } catch (beforeAutomationError) {
            runStatus = 'FAILED'
            runError =
              beforeAutomationError instanceof Error
                ? beforeAutomationError.message
                : 'Inventory pre-automation hook failed.'

            console.error(
              'Inventory refresh pre-automation hook error:',
              {
                connectionId:
                  item.connection.id,
                error:
                  beforeAutomationError instanceof Error
                    ? beforeAutomationError.message
                    : String(beforeAutomationError),
              },
            )
          }

          try {
            const automationResult =
              await runInventoryRefreshAutomations(
                requireDatabase(),
                item.connection.id,
              )

            const failedAutomation =
              automationResult.results.find(
                (result) => !result.ok,
              )

            if (failedAutomation) {
              runStatus = 'FAILED'
              runError =
                `${failedAutomation.platform} inventory automation reported a failed result (HTTP ${failedAutomation.status}).`
            } else if (
              automationResult.status === 'SKIPPED' ||
              automationResult.results.length === 0 ||
              automationResult.results.every(
                (result) => result.outcome === 'SKIPPED',
              )
            ) {
              if (runStatus !== 'FAILED') {
                runStatus = 'IMPORT_ONLY'
              }
            } else if (runStatus !== 'FAILED') {
              runStatus = 'COMPLETED'
            }

            console.log(
              'Inventory refresh platform automations:',
              JSON.stringify(
                automationResult,
                null,
                2,
              ),
            )
          } catch (automationError) {
            runStatus = 'FAILED'
            runError =
              automationError instanceof Error
                ? automationError.message
                : 'Inventory platform automation failed.'

            console.error(
              'Inventory refresh platform automation error:',
              {
                connectionId:
                  item.connection.id,
                error:
                  automationError instanceof Error
                    ? automationError.message
                    : String(automationError),
              },
            )
          }
        }
      } catch (error) {
        runStatus = 'FAILED'
        runError =
          error instanceof Error
            ? error.message
            : 'Automatic inventory refresh error.'

        console.error(
          'Automatic inventory refresh error:',
          {
            connectionId:
              item.connection.id,
            error,
          },
        )
      } finally {
        const finishedAt = new Date()

        await db
          .update(dataConnectionRuns)
          .set({
            status: runStatus,
            importStatus:
              runImportStatus,
            rowsImported:
              runRowsImported,
            changedItemCount:
              runChangedItemCount,
            error: runError,
            finishedAt,
          })
          .where(
            eq(
              dataConnectionRuns.id,
              connectionRun.id,
            ),
          )

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

  return processedAnySchedule
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

export {
  dataConnectionsApi,
}
