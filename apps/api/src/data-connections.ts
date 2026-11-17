import { createHash, randomUUID } from 'node:crypto'

import {
  createDatabase,
  catalogSyncRuns,
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
  lt,
  lte,
  gte,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { JWT } from 'google-auth-library'
import { Hono } from 'hono'
import { runInventoryRefreshAutomations, buildInventoryRefreshCursor, runInventoryRefreshSlice } from './platform-automation.js'
import {
  parseInventoryAutomationDiagnostics,
} from './inventory-automation-diagnostics.js'
import { requestArukeresoFeedGeneration, withRenewingSchedulerLease } from './arukereso.js'
import { executeInventoryRefresh, executeInventoryRefreshSlice, type InventoryRefreshState, type InventoryRefreshTrigger } from './inventory-refresh-workflow.js'
import { inventoryExecutionLeaseName } from './inventory-execution-lease.js'
import { createInventoryRefreshApi, InventoryRefreshError } from './inventory-refresh-api.js'
import { coordinateInventoryRefresh } from './inventory-refresh-coordinator.js'
import { canSkipInventoryImport } from './inventory-import-safety.js'
import { readInventoryRefreshCursor, serializeAutomationDetailsWithCursor, type InventoryRefreshCursor } from './inventory-refresh-slice.js'
import {
  classifyInventoryRefreshRun,
  resumeEligibleInventoryRefreshes,
  type InventoryRefreshRunRow,
  type ResumableInventoryRefresh,
} from './inventory-refresh-resume.js'

export type RelatedImportChild<TStartedAt = Date> = {
  connectionId: string
  startedAt: TStartedAt
}

/*
 * Selects the child import belonging to one scheduler
 * wrapper run without a persisted parent link (no schema
 * change): same connection, started at/after the wrapper
 * start, but strictly before the next wrapper start for
 * that connection, and within the wrapper's own finished
 * window when it has one. Earliest match wins, because a
 * wrapper triggers its import synchronously at start.
 * Returns null when no child falls inside the window.
 */
export function selectRelatedImportForWrapper<
  TChild extends RelatedImportChild,
>(
  wrapper: {
    connectionId: string
    startedAt: Date
    finishedAt: Date | null
  },
  nextWrapperStartedAt: Date | null,
  children: TChild[],
): TChild | null {
  let best: TChild | null = null

  for (const child of children) {
    if (
      child.connectionId !==
      wrapper.connectionId
    ) {
      continue
    }

    const childStart =
      child.startedAt.getTime()

    if (
      childStart <
      wrapper.startedAt.getTime()
    ) {
      continue
    }

    if (
      nextWrapperStartedAt !== null &&
      childStart >=
        nextWrapperStartedAt.getTime()
    ) {
      continue
    }

    if (
      wrapper.finishedAt !== null &&
      childStart >
        wrapper.finishedAt.getTime()
    ) {
      continue
    }

    if (
      best === null ||
      childStart <
        best.startedAt.getTime()
    ) {
      best = child
    }
  }

  return best
}

/*
 * Stale-run age thresholds. Chosen from observed production
 * runtimes (44 successful catalog runs peak at 33 s; wrapper
 * COMPLETED runs peak near 55 min):
 *
 * - catalog sync does fixed work (offer pagination plus
 *   targeted syncs), so 15 minutes is a wide margin that a
 *   legitimate run cannot reach;
 * - inventory wrappers legitimately run for most of an hour,
 *   so 30 minutes only reaps rows no live run could still be
 *   using once a newer run for the same scope finalizes.
 *
 * Neither table carries an updatedAt/heartbeat column, so
 * startedAt is the consistent staleness anchor for both.
 * A falsely reaped but still-alive run heals itself: its own
 * finalize overwrites INTERRUPTED with its real outcome.
 */
export const CATALOG_SYNC_STALE_THRESHOLD_MS =
  15 * 60 * 1000

export const DATA_CONNECTION_RUN_STALE_THRESHOLD_MS =
  30 * 60 * 1000

export function staleReapCutoff(
  now: Date,
  thresholdMs: number,
): Date {
  return new Date(
    now.getTime() - thresholdMs,
  )
}

/*
 * Mirror of the dataConnectionRuns orphan reaper below:
 * when a catalog sync run finalizes, any older run still
 * stuck at RUNNING belongs to a dead runtime and can
 * never finish itself. Mark it INTERRUPTED so History
 * distinguishes it from a live run. Only rows older than
 * the staleness threshold are touched, so a merely slow
 * legitimate run is never reaped. Self-healing: if the
 * older runtime is somehow still alive, its own finalize
 * overwrites this. The current run id is always excluded,
 * so fresh RUNNING jobs are never touched.
 */
export async function reapStaleCatalogSyncRuns(
  database: ReturnType<typeof createDatabase>,
  currentRunId: string,
  currentStartedAt: Date,
  now: Date = new Date(),
): Promise<{ reaped: number }> {
  try {
    await database
      .update(catalogSyncRuns)
      .set({
        status: 'INTERRUPTED',
        error:
          'A futást a runtime leállása szakította meg; egy újabb futás zárta le.',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(catalogSyncRuns.status, 'RUNNING'),
          ne(catalogSyncRuns.id, currentRunId),
          lt(
            catalogSyncRuns.startedAt,
            currentStartedAt,
          ),
          lt(
            catalogSyncRuns.startedAt,
            staleReapCutoff(
              now,
              CATALOG_SYNC_STALE_THRESHOLD_MS,
            ),
          ),
        ),
      )

    return { reaped: 1 }
  } catch (reapError) {
    console.error(
      'Catalog sync orphan run reap failed:',
      reapError,
    )

    return { reaped: 0 }
  }
}

/*
 * Inventory-wrapper twin of reapStaleCatalogSyncRuns:
 * when a wrapper run for a connection finalizes, any older
 * run for the same connection that is still RUNNING belongs
 * to a dead runtime. Same threshold guard, same message, same
 * self-healing finalize. Connection scoping keeps unrelated
 * connections untouched.
 */
export async function reapStaleDataConnectionRuns(
  database: ReturnType<typeof createDatabase>,
  connectionId: string,
  currentRunId: string,
  currentStartedAt: Date,
  now: Date = new Date(),
): Promise<{ reaped: number }> {
  try {
    await database
      .update(dataConnectionRuns)
      .set({
        status: 'INTERRUPTED',
        error:
          'A futást a runtime leállása szakította meg; egy újabb futás zárta le.',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(
            dataConnectionRuns.connectionId,
            connectionId,
          ),
          eq(
            dataConnectionRuns.status,
            'RUNNING',
          ),
          // Never reap a run with persisted automation state.
          // This includes valid and potentially corrupt cursors.
          isNull(dataConnectionRuns.automationDetailsJson),
          ne(
            dataConnectionRuns.id,
            currentRunId,
          ),
          lt(
            dataConnectionRuns.startedAt,
            currentStartedAt,
          ),
          lt(
            dataConnectionRuns.startedAt,
            staleReapCutoff(
              now,
              DATA_CONNECTION_RUN_STALE_THRESHOLD_MS,
            ),
          ),
        ),
      )

    return { reaped: 1 }
  } catch (reapError) {
    console.error(
      'Inventory refresh orphan run reap failed:',
      {
        connectionId,
        error: reapError,
      },
    )

    return { reaped: 0 }
  }
}

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
      `CikkszÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡m oszlop nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ: ${skuSourceField}`,
    )
  }

  if (stockIndex < 0) {
    throw new Error(
      `KÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©szlet oszlop nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ: ${stockSourceField}`,
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

    const existingItem =
      itemsBySku.get(sku)

    if (existingItem) {
      duplicateSkuCount += 1

      if (
        normalizedStock.stock >=
        existingItem.stock
      ) {
        itemsBySku.set(sku, {
          sku,
          ...normalizedStock,
        })
      }
    } else {
      itemsBySku.set(sku, {
        sku,
        ...normalizedStock,
      })
    }
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
          automationDetailsJson:
            dataConnectionRuns.automationDetailsJson,
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

    if (!run) {
      return context.json({ run: null })
    }

    const {
      automationDetailsJson,
      ...runFields
    } = run

    return context.json({
      run: {
        ...runFields,
        automationDetails:
          parseInventoryAutomationDiagnostics(
            automationDetailsJson,
          ),
      },
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
            'Adatkapcsolat nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ.',
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
            'Automatikus frissÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­tÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©s csak az aktÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­v kÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©szletforrÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡son kapcsolhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ be.',
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
            'Adj meg legalÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡bb egy napi frissÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­tÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©si idÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬Ă‚Â¦Ä‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Âpontot.',
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
            'Az intervallum 15 Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©s 1440 perc kÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â¶zÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â¶tt lehet.',
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
            'A kÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â¶vetkezÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬Ă‚Â¦Ä‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â frissÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­tÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©si idÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬Ă‚Â¦Ä‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Âpont nem szÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡mÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­thatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ ki.',
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

let manualInventoryCatalogStep: (() => Promise<void>) | null = null
export function configureManualInventoryCatalogStep(step: () => Promise<void>) {
  manualInventoryCatalogStep = step
}

async function getInventoryRefreshRun(connectionId: string, runId: string) {
  const [run] = await requireDatabase().select().from(dataConnectionRuns)
    .where(and(eq(dataConnectionRuns.id, runId), eq(dataConnectionRuns.connectionId, connectionId))).limit(1)
  return run ? { ...run, runId: run.id } : null
}

export async function runFullInventoryRefresh(input: {
  connectionId: string
  trigger: InventoryRefreshTrigger
  runId?: string
  catalog?: () => Promise<void> | void
}) {
  const database = requireDatabase()
  const [connection] = await database.select().from(dataConnections).where(eq(dataConnections.id, input.connectionId)).limit(1)
  if (!connection) throw new InventoryRefreshError('Inventory connection not found', 404)
  if (connection.purpose !== 'INVENTORY' || !connection.isActive) throw new InventoryRefreshError('An active INVENTORY connection is required', 409)
  const runId = input.runId ?? randomUUID()
  try {
    return await coordinateInventoryRefresh({
      trigger: input.trigger,
      existing: () => getInventoryRefreshRun(input.connectionId, runId),
      withLease: action => withRenewingSchedulerLease({
      database, name: inventoryExecutionLeaseName(input.connectionId), waitMs: 0,
      logLabel: 'Inventory refresh',
      busyError: () => new InventoryRefreshError('Inventory refresh is already executing for this connection', 409),
      lostError: () => new InventoryRefreshError('Inventory refresh execution lease lost', 409),
      action,
      }),
      recentRun: () => recentRunningInventoryRun(database, input.connectionId),
      execute: async (lease: { name: string; ownerId: string; assertOwned: () => Promise<void> }) => {
        const startedAt = new Date()
        const assertOwned = async () => {
await lease.assertOwned()
        }
        const result = await executeInventoryRefresh({
          trigger: input.trigger, runId, assertOwned,
          create: async state => {
            await database.insert(dataConnectionRuns).values({ id: runId, connectionId: input.connectionId,
              triggerType: input.trigger, startedAt, ...state })
          },
          persist: async state => {
            await database.update(dataConnectionRuns).set(state).where(eq(dataConnectionRuns.id, runId))
          },
          importSource: async () => {
            const result = await executeInventoryImport(input.connectionId, lease, runId)
            const body = result.body as { status?: string; rowsImported?: number; changedItemCount?: number; error?: string }
            return { ...body, ok: result.status >= 200 && result.status < 300 }
          },
          catalog: input.catalog,
          automate: progress => runInventoryRefreshAutomations(database, input.connectionId, {
            executionLease: { name: lease.name, ownerId: lease.ownerId }, assertOwned, onProgress: progress,
          }),
        })
        return { ...result, startedAt }
      },
    })
  } catch (error) {
    // A busy scheduled candidate must not advance timestamps or reap wrappers.
    if (input.trigger === 'SCHEDULED' && error instanceof InventoryRefreshError && error.status === 409) return null
    throw error
  }
}

function inventoryRefreshLeaseOptions(
  database: ReturnType<typeof requireDatabase>,
  connectionId: string,
) {
  return {
    database,
    name: inventoryExecutionLeaseName(connectionId),
    waitMs: 0,
    logLabel: 'Inventory refresh',
    busyError: () => new InventoryRefreshError('Inventory refresh is already executing for this connection', 409),
    lostError: () => new InventoryRefreshError('Inventory refresh execution lease lost', 409),
  }
}

async function recentRunningInventoryRun(
  database: ReturnType<typeof requireDatabase>,
  connectionId: string,
) {
  const [running] = await database
    .select({ id: dataConnectionRuns.id })
    .from(dataConnectionRuns)
    .where(and(
      eq(dataConnectionRuns.connectionId, connectionId),
      eq(dataConnectionRuns.status, 'RUNNING'),
    ))
    .orderBy(desc(dataConnectionRuns.startedAt))
    .limit(1)

  // A RUNNING row always blocks a new import, regardless of age
  // or cursor validity. Recovery must be handled separately.
  return running ? { id: running.id } : undefined
}
function runStateFromRow(row: {
  importStatus: string | null
  rowsImported: number
  changedItemCount: number
  automationDetailsJson: string | null
  error: string | null
}): InventoryRefreshState {
  return {
    status: 'RUNNING',
    importStatus: row.importStatus,
    rowsImported: row.rowsImported,
    changedItemCount: row.changedItemCount,
    automationDetailsJson: row.automationDetailsJson,
    error: row.error,
    finishedAt: null,
  }
}

/**
 * Begin a manual full inventory refresh.
 *
 * Imports the source and freezes the batch plan once, then runs the
 * first bounded slice. Every later slice is driven by
 * `advanceManualFullInventoryRefresh`.
 */
export async function beginSlicedInventoryRefresh(input: {
  connectionId: string
  runId?: string
  catalog?: () => Promise<void> | void
  trigger?: InventoryRefreshTrigger
}) {
  const trigger = input.trigger ?? 'MANUAL'
  const database = requireDatabase()
  const [connection] = await database.select().from(dataConnections).where(eq(dataConnections.id, input.connectionId)).limit(1)
  if (!connection) throw new InventoryRefreshError('Inventory connection not found', 404)
  if (connection.purpose !== 'INVENTORY' || !connection.isActive) throw new InventoryRefreshError('An active INVENTORY connection is required', 409)
  const runId = input.runId ?? randomUUID()

  return coordinateInventoryRefresh({
    trigger,
    existing: () => getInventoryRefreshRun(input.connectionId, runId),
    withLease: action => withRenewingSchedulerLease({
      ...inventoryRefreshLeaseOptions(database, input.connectionId),
      action,
    }),
    recentRun: () => recentRunningInventoryRun(database, input.connectionId),
    execute: async (lease: { name: string; ownerId: string; assertOwned: () => Promise<void> }) => {
      const startedAt = new Date()
      const assertOwned = async () => {
        await lease.assertOwned()
      }
      const persist = async (state: InventoryRefreshState) => {
        await database.update(dataConnectionRuns).set(state).where(eq(dataConnectionRuns.id, runId))
      }

      const state: InventoryRefreshState = {
        status: 'RUNNING', importStatus: null, rowsImported: 0, changedItemCount: 0,
        automationDetailsJson: null, error: null, finishedAt: null,
      }

      await database.insert(dataConnectionRuns).values({
        id: runId, connectionId: input.connectionId, triggerType: trigger, startedAt, ...state,
      })

      const importedResult = await executeInventoryImport(input.connectionId, lease, runId)
      const importedResponse = { ok: importedResult.status >= 200 && importedResult.status < 300 }
      const imported = importedResult.body as {
        status?: string; rowsImported?: number; changedItemCount?: number; error?: string
      }

      state.importStatus = imported.status ?? null
      state.rowsImported = imported.rowsImported ?? 0
      state.changedItemCount = imported.changedItemCount ?? 0
      await persist({ ...state })

      if (!importedResponse.ok || imported.status === 'FAILED') {
        state.status = 'FAILED'
        state.error = imported.error ?? 'Automatic inventory import failed.'
        state.finishedAt = new Date()
        await persist({ ...state })

        return {
          runId, triggerType: trigger, ...state,
          advance: { done: true, nextAdvanceAt: null, stopReason: null, mutationAttempts: 0, rateLimited: false },
        }
      }

      await assertOwned()

      // Preserve scheduled behavior: a catalog failure is recorded, but the
      // guarded inventory automation still evaluates known listings.
      try {
        await (input.catalog ?? manualInventoryCatalogStep)?.()
      } catch (error) {
        state.error = error instanceof Error ? error.message : 'Inventory pre-automation hook failed.'
      }

      await assertOwned()

      const cursor = await buildInventoryRefreshCursor(database, input.connectionId, runId)

      /*
       * Persist the frozen plan before the first slice so a crash
       * during slice one still leaves a resumable run.
       */
      state.automationDetailsJson = serializeAutomationDetailsWithCursor({ version: 1, platforms: [] }, cursor)
      await persist({ ...state })

      const advance = (next: InventoryRefreshCursor) =>
        runInventoryRefreshSlice(input.connectionId, next, {
          executionLease: { name: lease.name, ownerId: lease.ownerId }, assertOwned,
        })

      let result = await executeInventoryRefreshSlice({
        trigger, runId, cursor, state, assertOwned, persist, advance,
      })

      if (trigger === 'SCHEDULED') {
        result = await continueScheduledSlices({
          result,
          runSlice: currentState => executeInventoryRefreshSlice({
            trigger, runId, cursor, state: currentState, assertOwned, persist, advance,
          }),
        })
      }

      return result
    },
  })
}

/**
 * Run the next bounded slice of an in-flight manual refresh.
 *
 * Read-only preconditions (run state, cursor, cooldown) are checked
 * before any remote call, so a mis-sequenced client cannot burn a
 * write budget or defeat the 429 cooldown.
 */

export async function beginManualFullInventoryRefresh(input: {
  connectionId: string
  runId?: string
  catalog?: () => Promise<void> | void
}) {
  return beginSlicedInventoryRefresh({ ...input, trigger: 'MANUAL' })
}
/**
 * Time-bounded continuation loop for SCHEDULED inventory refreshes.
 *
 * MANUAL runs are paced by the browser's `/advance` polling loop.
 * SCHEDULED runs have no such driver — the resume scheduler fires
 * every 15 minutes and was advancing only one slice per tick.  This
 * helper closes the gap by looping through slices within a single
 * execution context, honoring cooldowns and a wall-clock budget so
 * the execution lease, rate-limit back-off and write pacing are
 * never bypassed.
 */
export const SCHEDULED_TICK_BUDGET_MS = positiveIntegerEnv(
  'COMMERCE_HUB_SCHEDULED_TICK_BUDGET_MS',
  2 * 60 * 1000,
)
export const SCHEDULED_MAX_COOLDOWN_MS = 30_000

function positiveIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export type ScheduledSliceResult = {
  advance: { done: boolean; rateLimited: boolean; nextAdvanceAt: number | null }
  status: string
  importStatus: string | null
  rowsImported: number
  changedItemCount: number
  automationDetailsJson: string | null
  error: string | null
  finishedAt: Date | null
}

export async function continueScheduledSlices<T extends ScheduledSliceResult>(input: {
  result: T
  runSlice: (state: InventoryRefreshState) => Promise<T>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  tickBudgetMs?: number
  maxCooldownMs?: number
}): Promise<T> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const tickBudgetMs = input.tickBudgetMs ?? SCHEDULED_TICK_BUDGET_MS
  const maxCooldownMs = input.maxCooldownMs ?? SCHEDULED_MAX_COOLDOWN_MS
  const tickStart = now()
  let result = input.result

  while (
    !result.advance.done &&
    !result.advance.rateLimited &&
    now() - tickStart < tickBudgetMs
  ) {
    const cooldownMs = Math.max(
      0,
      (result.advance.nextAdvanceAt ?? now()) - now(),
    )
    if (cooldownMs > maxCooldownMs) break
    if (cooldownMs > 0) {
      await sleep(cooldownMs)
    }

    result = await input.runSlice({
      status: result.status as InventoryRefreshState['status'],
      importStatus: result.importStatus,
      rowsImported: result.rowsImported,
      changedItemCount: result.changedItemCount,
      automationDetailsJson: result.automationDetailsJson,
      error: result.error,
      finishedAt: result.finishedAt,
    })
  }

  return result
}

async function advanceSlicedInventoryRefresh(input: {
  connectionId: string
  runId: string
  trigger: InventoryRefreshTrigger
}) {
  const database = requireDatabase()

  return withRenewingSchedulerLease({
    ...inventoryRefreshLeaseOptions(database, input.connectionId),
    action: async (lease: { name: string; ownerId: string; assertOwned: () => Promise<void> }) => {
      const run = await getInventoryRefreshRun(input.connectionId, input.runId)
      if (!run) throw new InventoryRefreshError('Inventory refresh run not found', 404)
      if (run.triggerType !== input.trigger) throw new InventoryRefreshError('Only manual runs can be advanced', 409)
      if (run.status !== 'RUNNING') throw new InventoryRefreshError('Inventory refresh run is already finished', 409)

      const cursor = readInventoryRefreshCursor(run.automationDetailsJson)
      if (!cursor) throw new InventoryRefreshError('Inventory refresh run has no resumable cursor', 409)

      if (cursor.nextAdvanceAt !== null && Date.now() < cursor.nextAdvanceAt) {
        throw new InventoryRefreshError(
          `Inventory refresh is cooling down until ${new Date(cursor.nextAdvanceAt).toISOString()}`,
          409,
        )
      }

      const assertOwned = async () => {
        await lease.assertOwned()
      }
      const persist = async (state: InventoryRefreshState) => {
        await database.update(dataConnectionRuns).set(state).where(eq(dataConnectionRuns.id, input.runId))
      }

      const advance = (next: InventoryRefreshCursor) =>
        runInventoryRefreshSlice(input.connectionId, next, {
          executionLease: { name: lease.name, ownerId: lease.ownerId }, assertOwned,
        })

      let result = await executeInventoryRefreshSlice({
        trigger: input.trigger, runId: input.runId, cursor, state: runStateFromRow(run),
        assertOwned, persist, advance,
      })

      if (input.trigger === 'SCHEDULED') {
        result = await continueScheduledSlices({
          result,
          runSlice: currentState => executeInventoryRefreshSlice({
            trigger: input.trigger, runId: input.runId, cursor,
            state: currentState, assertOwned, persist, advance,
          }),
        })
      }

      return result
    },
  })
}

/**
 * Every MANUAL RUNNING row, unfiltered.
 *
 * The eligibility decision lives in the pure resume module so the same
 * rule set is used by the scheduler and by the UI adoption endpoint.
 */

export async function advanceManualFullInventoryRefresh(input: {
  connectionId: string
  runId: string
}) {
  return advanceSlicedInventoryRefresh({ ...input, trigger: 'MANUAL' })
}
async function loadRunningManualInventoryRunRows(): Promise<InventoryRefreshRunRow[]> {
  return requireDatabase()
    .select({
      id: dataConnectionRuns.id,
      connectionId: dataConnectionRuns.connectionId,
      triggerType: dataConnectionRuns.triggerType,
      status: dataConnectionRuns.status,
      automationDetailsJson: dataConnectionRuns.automationDetailsJson,
      startedAt: dataConnectionRuns.startedAt,
    })
    .from(dataConnectionRuns)
    .where(
      and(
        eq(dataConnectionRuns.triggerType, 'MANUAL'),
        eq(dataConnectionRuns.status, 'RUNNING'),
      ),
    )
    .orderBy(desc(dataConnectionRuns.startedAt))
}

export async function scanResumableInventoryRefreshRuns(
  _now = Date.now(),
): Promise<InventoryRefreshRunRow[]> {
  return requireDatabase()
    .select({
      id: dataConnectionRuns.id,
      connectionId: dataConnectionRuns.connectionId,
      triggerType: dataConnectionRuns.triggerType,
      status: dataConnectionRuns.status,
      automationDetailsJson: dataConnectionRuns.automationDetailsJson,
      startedAt: dataConnectionRuns.startedAt,
    })
    .from(dataConnectionRuns)
    .where(eq(dataConnectionRuns.status, 'RUNNING'))
    .orderBy(desc(dataConnectionRuns.startedAt))
}

/**
 * The newest MANUAL RUNNING run that may actually be resumed.
 *
 * Legacy RUNNING orphans (no cursor) and corrupt cursors are excluded
 * by the same classifier the scheduler uses.
 */
export async function findResumableInventoryRefresh(
  connectionId: string,
  now = Date.now(),
): Promise<ResumableInventoryRefresh | null> {
  const rows = (await loadRunningManualInventoryRunRows()).filter(
    row => row.connectionId === connectionId,
  )

  for (const row of rows) {
    const eligibility = classifyInventoryRefreshRun(row, now, {
      requireDue: false,
    })
    if (eligibility.resumable) return eligibility.target
  }

  return null
}

/**
 * One scheduler tick: advance each eligible run by at most one slice.
 *
 * This calls `advanceManualFullInventoryRefresh`, the exact function the
 * HTTP `/advance` route calls, so the per-connection execution lease
 * decides which executor runs. A frontend advance that wins the race
 * makes this call fail with 409 and nothing is mutated twice.
 */
export async function resumeInventoryRefreshSchedulerTick(options?: {
  now?: () => number
  limit?: number
}) {
  const result = await resumeEligibleInventoryRefreshes({
    scan: scanResumableInventoryRefreshRuns,
    advance: async target => {
      if (target.triggerType === 'SCHEDULED') {
        return advanceSlicedInventoryRefresh({
          connectionId: target.connectionId,
          runId: target.runId,
          trigger: 'SCHEDULED',
        })
      }
      return advanceManualFullInventoryRefresh(target)
    },
    now: options?.now,
    limit: options?.limit,
    onSkip: entry => {
      if (entry.reason === 'CORRUPT_CURSOR' || entry.reason === 'RUN_MISMATCH') {
        console.warn('Inventory refresh self-resume skipped a run:', entry)
      }
    },
    onError: entry => {
      console.error('Inventory refresh self-resume failed:', entry)
    },
  })

  if (result.advanced.length > 0 || result.failed.length > 0) {
    console.info('Inventory refresh self-resume tick', {
      considered: result.considered,
      eligible: result.eligible,
      advanced: result.advanced,
      failed: result.failed,
    })
  }

  return result
}

dataConnectionsApi.route('/', createInventoryRefreshApi({
  run: async (connectionId, runId) => {
    if (!manualInventoryCatalogStep) throw new InventoryRefreshError('Inventory catalog integration is not initialized', 503)
    return beginManualFullInventoryRefresh({ connectionId, runId, catalog: manualInventoryCatalogStep })
  },
  advance: async (connectionId, runId) => advanceManualFullInventoryRefresh({ connectionId, runId }),
  getRun: getInventoryRefreshRun,
  getResumableRun: connectionId => findResumableInventoryRefresh(connectionId),
}))

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

      let result: Awaited<ReturnType<typeof beginSlicedInventoryRefresh>> | null = null

      try {
        result = await beginSlicedInventoryRefresh({
          connectionId: item.connection.id,
          trigger: 'SCHEDULED',
          catalog: options?.beforeAutomation,
        })
      } catch (error) {
        if (!(error instanceof InventoryRefreshError && error.status === 409)) {
          throw error
        }

        console.info('Scheduled inventory refresh deferred: active execution', {
          connectionId: item.connection.id,
        })
      }

      if (result) {
        const startedAt = new Date()


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
              'Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â°rvÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©nytelen Google Spreadsheet URL vagy ID.',
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
            'HiÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡nyzÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ vagy hibÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡s adatkapcsolati beÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡llÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­tÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡s.',
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
            'Az adatkapcsolat nem jÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â¶tt lÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©tre.',
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
            'Adatkapcsolat nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ.',
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

type InventoryImportFeedInput = {
  status: string
  changedItemCount: number
}

type InventoryFeedGenerationRequest = (
  triggerType: 'INVENTORY_SYNC',
) => Promise<unknown>

function shouldRequestInventoryFeedGeneration(
  input: InventoryImportFeedInput,
) {
  return (
    input.status === 'SUCCESS' &&
    input.changedItemCount > 0
  )
}

async function runPostInventoryImportFeedHook(
  input: InventoryImportFeedInput,
  requestGeneration: InventoryFeedGenerationRequest =
    requestArukeresoFeedGeneration,
  automaticGenerationEnabled =
    process.env.ARUKERESO_AUTO_GENERATE_ENABLED === 'true',
) {
  if (!shouldRequestInventoryFeedGeneration(input)) {
    return {
      status: 'skipped' as const,
      reason: 'UNCHANGED_INVENTORY' as const,
    }
  }

  if (!automaticGenerationEnabled) {
    return {
      status: 'skipped' as const,
      reason:
        'AUTOMATIC_GENERATION_DISABLED' as const,
    }
  }

  try {
    return await requestGeneration('INVENTORY_SYNC')
  } catch (error) {
    console.error(
      'Inventory import succeeded, but Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚ÂrukeresÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬Ă‚Â¦Ä‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â feed generation failed:',
      error,
    )

    return {
      status: 'error' as const,
      message:
        error instanceof Error
          ? error.message
          : 'Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚ÂrukeresÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬Ă‚Â¦Ä‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â feed generation failed.',
    }
  }
}

type InventoryImportLease = {
  name: string
  ownerId: string
  assertOwned: () => Promise<void>
}

function inventoryImportResponse(
  body: Record<string, unknown>,
  status: number = 200,
) {
  return { body, status }
}
async function executeInventoryImport(
  connectionId: string,
  lease: InventoryImportLease,
  parentRunId?: string,
) {
  const database = requireDatabase()
  await lease.assertOwned()

    const stored =
      await getConnection(
        connectionId,
      )

    if (
      !stored ||
      !stored.config
    ) {
      return inventoryImportResponse(
        {
          error:
            'Adatkapcsolat nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ.',
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
          parentRunId: parentRunId ?? null,
          status: 'RUNNING',
        })
        .returning()

    if (!run) {
      return inventoryImportResponse(
        {
          error:
            'Import futÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡s nem hozhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ lÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©tre.',
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
          'A forrÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡s nem tartalmaz hasznÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ cikkszÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡mot.'

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

        return inventoryImportResponse(
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
      const [previousRun] =
        await database
          .select({
            status:
              inventoryImportRuns.status,
            sourceFingerprint:
              inventoryImportRuns
                .sourceFingerprint,
          })
          .from(inventoryImportRuns)
          .where(
            and(
              eq(
                inventoryImportRuns.connectionId,
                connectionId,
              ),
              ne(
                inventoryImportRuns.id,
                run.id,
              ),
            ),
          )
          .orderBy(
            desc(inventoryImportRuns.startedAt),
            desc(inventoryImportRuns.createdAt),
            desc(inventoryImportRuns.id),
          )
          .limit(1)

      const now =
        new Date()

      if (
        canSkipInventoryImport({
          latestRun: previousRun ?? null,
          currentFingerprint: analysis.fingerprint,
        })
      ) {
        await lease.assertOwned()

        await database.execute(sql`
          SELECT finalize_unchanged_inventory_import(
            ${connectionId}::uuid,
            ${run.id}::uuid,
            ${analysis.rowsRead},
            ${analysis.rowsImported},
            ${analysis.rowsNormalizedToZero},
            ${analysis.duplicateSkuCount},
            ${analysis.fingerprint},
            ${lease.name},
            ${lease.ownerId}::uuid
          )
        `)

        return inventoryImportResponse({
          status: 'NO_CHANGE',
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
          changedItemCount: 0,
        })
      }

      const existingItems = await database
        .select({
          sku: inventorySourceItems.sku,
        })
        .from(inventorySourceItems)
        .where(eq(inventorySourceItems.connectionId, connectionId))

      const currentSkuSet = new Set(
        analysis.items.map((item) => item.sku),
      )

      const removedItemCount = existingItems.filter(
        (item) => !currentSkuSet.has(item.sku),
      ).length

      const snapshot = analysis.items.map((item) => ({
        sku: item.sku,
        stock: item.stock,
        source_stock_value: item.sourceStockValue,
        normalized_to_zero: item.normalizedToZero,
      }))

      const applied = await database.execute<{
        changed_item_count: number
      }>(sql`
        SELECT apply_inventory_snapshot(
          ${connectionId}::uuid,
          ${run.id}::uuid,
          ${JSON.stringify(snapshot)}::jsonb,
          ${analysis.rowsRead},
          ${analysis.rowsNormalizedToZero},
          ${analysis.duplicateSkuCount},
          ${analysis.fingerprint},
          ${lease.name},
          ${lease.ownerId}::uuid
        ) AS changed_item_count
      `)

      const changedItemCount = Number(
        applied.rows[0]?.changed_item_count ?? 0,
      )

      const feedGeneration = await (async () => {
        try {
          return await runPostInventoryImportFeedHook({
            status: 'SUCCESS',
            changedItemCount,
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Feed generation failed'

          console.error('Post-import feed generation failed:', message)

          return {
            status: 'failed' as const,
            error: message,
          }
        }
      })()

      return inventoryImportResponse({
        status: 'SUCCESS',
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
        changedItemCount,
        removedItemCount,
        feedGeneration,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Inventory import failed.'

      await database.execute(sql`
        SELECT fail_inventory_import(
          ${connectionId}::uuid,
          ${run.id}::uuid,
          ${message},
          ${lease.name},
          ${lease.ownerId}::uuid
        )
      `)


      return inventoryImportResponse(
        {
          status: 'FAILED',
          error: message,
        },
        500,
      )
    }
}

dataConnectionsApi.post(
  '/:connectionId/import',
  async (context) => {
    const connectionId = context.req.param('connectionId')
    const database = requireDatabase()

    return withRenewingSchedulerLease({
      ...inventoryRefreshLeaseOptions(database, connectionId),
      action: async (lease) => {
        const result = await executeInventoryImport(connectionId, lease)
        return context.json(result.body, result.status as 200)
      },
    })
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
            'KÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©szlet adatkapcsolat nem talÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡lhatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ.',
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
            'Csak sikeresen tesztelt adatkapcsolat Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡llÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­thatÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇĂ„â€šĂ˘â‚¬ĹľÄ‚â€žĂ˘â‚¬Â¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇ be aktÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â­v kÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©szletforrÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬Ă„â€¦Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ä‚â€ąĂ˘â‚¬Ë‡skÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©nt.',
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
  shouldRequestInventoryFeedGeneration,
  runPostInventoryImportFeedHook,
}
