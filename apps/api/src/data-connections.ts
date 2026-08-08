import { createHash } from 'node:crypto'

import {
  createDatabase,
  dataConnections,
  inventoryConnectionConfigs,
  inventoryImportRuns,
  inventorySourceItems,
} from '@karcher-commerce-hub/database'
import {
  and,
  desc,
  eq,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { JWT } from 'google-auth-library'
import { Hono } from 'hono'

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
   CURRENT IMPORTED INVENTORY
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

export {
  dataConnectionsApi,
}