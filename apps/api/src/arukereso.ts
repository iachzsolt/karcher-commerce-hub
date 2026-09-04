import {
  catalogSourceItems,
  createDatabase,
  dataConnectionRuns,
  dataConnections,
  inventorySourceItems,
  pricingSourceItems,
  productIdentifiers,
  products,
} from '@karcher-commerce-hub/database'
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  and,
  eq,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { Hono } from 'hono'
import * as XLSX from 'xlsx'

const arukeresoApi = new Hono()

const databaseUrl =
  process.env.DATABASE_URL

const db = databaseUrl
  ? createDatabase(databaseUrl)
  : null

function requireDatabase() {
  if (!db) {
    throw new Error(
      'DATABASE_URL is not configured.',
    )
  }

  return db
}

const EXPECTED_CATALOG_HEADERS = [
  'Identifier',
  'EanCode',
  'Manufacturer',
  'Name',
  'Description',
  'Category',
  'ProductUrl',
  'ImageUrl',
  'ImageUrl2',
  'Price',
  'NetPrice',
  'DeliveryCost',
  'DeliveryTime',
] as const

const PREVIEW_LIMIT = 50

const INVALID_ROWS_LIMIT = 100

type CatalogHeader =
  (typeof EXPECTED_CATALOG_HEADERS)[number]

type CatalogPreviewItem = {
  rowNumber: number
  identifier: string | null
  eanCode: string | null
  manufacturer: string | null
  name: string | null
  category: string | null
  productUrl: string | null
  imageUrl: string | null
  imageUrl2: string | null
  priceRaw: string | null
  priceMinor: number | null
  netPriceRaw: string | null
  netPriceMinor: number | null
  deliveryCostRaw: string | null
  deliveryCostMinor: number | null
  deliveryTimeRaw: string | null
  deliveryTimeDays: number | null
  normalizedSku: string | null
  matchStatus:
    | 'MATCHED'
    | 'UNMATCHED'
    | 'CONFLICT'
  matchMethod:
    | 'SKU'
    | 'EAN'
    | null
  matchedProductId: string | null
  matchedSku: string | null
  errors: string[]
}

type CatalogAnalyzedItem =
  CatalogPreviewItem & {
    description: string | null
    rawSource: Record<CatalogHeader, string>
  }

class CatalogCsvValidationError extends Error {
  constructor(
    message: string,
    readonly headers?: string[],
    readonly missingHeaders?: CatalogHeader[],
  ) {
    super(message)
    this.name = 'CatalogCsvValidationError'
  }
}

function cmsIdentifierToSku(
  identifier: string,
): string | null {
  const value =
    identifier.trim()

  const match =
    /^(\d)(\d{3})(\d{3})(\d)$/.exec(
      value,
    )

  if (!match) {
    return null
  }

  return (
    match[1] +
    '.' +
    match[2] +
    '-' +
    match[3] +
    '.' +
    match[4]
  )
}

function parseSemicolonCsv(
  input: string,
): string[][] {
  const text = input.replace(/^\uFEFF/, '')
  const rows: string[][] = []

  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += character
      }

      continue
    }

    if (character === '"') {
      inQuotes = true
      continue
    }

    if (character === ';') {
      row.push(field)
      field = ''
      continue
    }

    if (character === '\n') {
      row.push(field)
      field = ''

      if (
        row.some(
          (value) => value.trim() !== '',
        )
      ) {
        rows.push(row)
      }

      row = []
      continue
    }

    if (character === '\r') {
      continue
    }

    field += character
  }

  if (inQuotes) {
    throw new Error(
      'A CSV fajlban le nem zart idezojeles mezo talalhato.',
    )
  }

  if (
    field.length > 0 ||
    row.length > 0
  ) {
    row.push(field)

    if (
      row.some(
        (value) => value.trim() !== '',
      )
    ) {
      rows.push(row)
    }
  }

  return rows
}

function parseMoneyMinor(
  rawValue: string,
): number | null {
  const sourceValue =
    rawValue.trim()

  if (
    /^ingyenes$/i.test(
      sourceValue,
    )
  ) {
    return 0
  }

  const trimmed =
    sourceValue
      .replace(/\u00a0/g, '')
      .replace(/\s+/g, '')
      .replace(/HUF/gi, '')
      .replace(/Ft/gi, '')

  if (!trimmed) {
    return null
  }

  const numeric =
    trimmed.replace(/[^\d,.-]/g, '')

  if (!numeric) {
    return null
  }

  const commaIndex =
    numeric.lastIndexOf(',')

  const dotIndex =
    numeric.lastIndexOf('.')

  let normalized = numeric

  if (
    commaIndex >= 0 &&
    dotIndex >= 0
  ) {
    const decimalSeparator =
      commaIndex > dotIndex
        ? ','
        : '.'

    const thousandsSeparator =
      decimalSeparator === ','
        ? '.'
        : ','

    normalized =
      numeric
        .split(thousandsSeparator)
        .join('')
        .replace(
          decimalSeparator,
          '.',
        )
  } else if (
    commaIndex >= 0 ||
    dotIndex >= 0
  ) {
    const separator =
      commaIndex >= 0
        ? ','
        : '.'

    const separatorIndex =
      numeric.lastIndexOf(separator)

    const decimalLength =
      numeric.length -
      separatorIndex -
      1

    if (
      decimalLength === 1 ||
      decimalLength === 2
    ) {
      normalized =
        numeric.replace(
          separator,
          '.',
        )
    } else {
      normalized =
        numeric
          .split(separator)
          .join('')
    }
  }

  const value = Number(normalized)

  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null
  }

  return Math.round(value * 100)
}

function parseDeliveryTimeDays(
  rawValue: string,
): number | null {
  const trimmed =
    rawValue.trim()

  if (!trimmed) {
    return null
  }

  const match =
    /^(\d+)(?:\s*munkanap)?$/i.exec(
      trimmed,
    )

  if (!match?.[1]) {
    return null
  }

  const value =
    Number.parseInt(
      match[1],
      10,
    )

  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 365
  ) {
    return null
  }

  return value
}

function normalizeCell(
  value: string | undefined,
) {
  const trimmed =
    value?.trim() ?? ''

  return trimmed || null
}

function countDuplicates(
  values: Array<string | null>,
) {
  const counts =
    new Map<string, number>()

  for (const value of values) {
    if (!value) {
      continue
    }

    const key =
      value.trim().toLowerCase()

    counts.set(
      key,
      (counts.get(key) ?? 0) + 1,
    )
  }

  return [...counts.values()]
    .filter((count) => count > 1)
    .length
}

async function analyzeCatalogCsv(
  csvText: string,
) {
  const csvRows =
    parseSemicolonCsv(csvText)

  if (csvRows.length === 0) {
    throw new CatalogCsvValidationError(
      'A CSV fajl ures.',
    )
  }

  const headers =
    csvRows[0].map(
      (header) =>
        header
          .replace(/^\uFEFF/, '')
          .trim(),
    )

  const headerIndex =
    new Map<string, number>()

  headers.forEach(
    (header, index) => {
      headerIndex.set(
        header.toLowerCase(),
        index,
      )
    },
  )

  const missingHeaders =
    EXPECTED_CATALOG_HEADERS
      .filter(
        (header) =>
          !headerIndex.has(
            header.toLowerCase(),
          ),
      )

  if (missingHeaders.length > 0) {
    throw new CatalogCsvValidationError(
      'A CMS CSV fejlece nem megfelelo.',
      headers,
      [...missingHeaders],
    )
  }

  const getValue = (
    row: string[],
    header: CatalogHeader,
  ) => {
    const index =
      headerIndex.get(
        header.toLowerCase(),
      )

    if (index === undefined) {
      return ''
    }

    return row[index] ?? ''
  }

  const database =
    requireDatabase()

  const [
    hubProducts,
    hubIdentifiers,
  ] = await Promise.all([
    database
      .select({
        id: products.id,
        sku: products.sku,
      })
      .from(products),

    database
      .select({
        productId:
          productIdentifiers.productId,
        type:
          productIdentifiers.type,
        value:
          productIdentifiers.value,
      })
      .from(productIdentifiers),
  ])

  const productBySku =
    new Map(
      hubProducts.map(
        (product) => [
          product.sku,
          product,
        ],
      ),
    )

  const productById =
    new Map(
      hubProducts.map(
        (product) => [
          product.id,
          product,
        ],
      ),
    )

  const productByEan =
    new Map<
      string,
      {
        id: string
        sku: string
      }
    >()

  for (
    const identifierRow
    of hubIdentifiers
  ) {
    if (
      identifierRow.type !==
      'EAN'
    ) {
      continue
    }

    const product =
      productById.get(
        identifierRow.productId,
      )

    if (!product) {
      continue
    }

    productByEan.set(
      identifierRow.value.trim(),
      product,
    )
  }

  const allItems:
    CatalogAnalyzedItem[] = []

  let validRows = 0
  let invalidRows = 0
  let zeroPriceRows = 0
  let invalidPriceRows = 0
  let invalidDeliveryTimeRows = 0
  let missingEanRows = 0

  let matchedBySku = 0
  let matchedByEan = 0
  let unmatched = 0
  let invalidIdentifierFormat = 0
  let matchConflicts = 0

  const identifiers:
    Array<string | null> = []

  const eanCodes:
    Array<string | null> = []

  for (
    let index = 1;
    index < csvRows.length;
    index += 1
  ) {
    const row = csvRows[index]

    const rawSource =
      Object.fromEntries(
        EXPECTED_CATALOG_HEADERS.map(
          (header) => [
            header,
            getValue(row, header),
          ],
        ),
      ) as Record<CatalogHeader, string>

    const identifier =
      normalizeCell(
        rawSource.Identifier,
      )

    const eanCode =
      normalizeCell(
        rawSource.EanCode,
      )

    const normalizedSku =
      identifier
        ? cmsIdentifierToSku(
            identifier,
          )
        : null

    const hasInvalidIdentifierFormat =
      Boolean(
        identifier && !normalizedSku,
      )

    const skuMatchedProduct =
      normalizedSku
        ? productBySku.get(
            normalizedSku,
          ) ?? null
        : null

    const eanMatchedProduct =
      eanCode
        ? productByEan.get(
            eanCode.trim(),
          ) ?? null
        : null

    let matchStatus:
      | 'MATCHED'
      | 'UNMATCHED'
      | 'CONFLICT'

    let matchMethod:
      | 'SKU'
      | 'EAN'
      | null = null

    let matchedProductId:
      string | null = null

    let matchedSku:
      string | null = null

    if (
      skuMatchedProduct &&
      eanMatchedProduct &&
      skuMatchedProduct.id !==
        eanMatchedProduct.id
    ) {
      matchStatus = 'CONFLICT'
    } else if (skuMatchedProduct) {
      matchStatus = 'MATCHED'
      matchMethod = 'SKU'
      matchedProductId =
        skuMatchedProduct.id
      matchedSku =
        skuMatchedProduct.sku
    } else if (eanMatchedProduct) {
      matchStatus = 'MATCHED'
      matchMethod = 'EAN'
      matchedProductId =
        eanMatchedProduct.id
      matchedSku =
        eanMatchedProduct.sku
    } else {
      matchStatus = 'UNMATCHED'
    }

    const name =
      normalizeCell(rawSource.Name)

    const productUrl =
      normalizeCell(
        rawSource.ProductUrl,
      )

    const imageUrl =
      normalizeCell(rawSource.ImageUrl)

    const priceRaw =
      normalizeCell(rawSource.Price)

    const priceMinor =
      priceRaw
        ? parseMoneyMinor(priceRaw)
        : null

    const netPriceRaw =
      normalizeCell(rawSource.NetPrice)

    const deliveryCostRaw =
      normalizeCell(
        rawSource.DeliveryCost,
      )

    const deliveryTimeRaw =
      normalizeCell(
        rawSource.DeliveryTime,
      )

    const deliveryTimeDays =
      deliveryTimeRaw
        ? parseDeliveryTimeDays(
            deliveryTimeRaw,
          )
        : null

    const errors: string[] = []

    if (!identifier) {
      errors.push('MISSING_IDENTIFIER')
    }

    if (!eanCode) {
      errors.push('MISSING_EAN')
      missingEanRows += 1
    }

    if (!name) {
      errors.push('MISSING_NAME')
    }

    if (!productUrl) {
      errors.push('MISSING_PRODUCT_URL')
    }

    if (!imageUrl) {
      errors.push('MISSING_IMAGE')
    }

    if (
      priceMinor === null ||
      priceMinor <= 0
    ) {
      errors.push('INVALID_PRICE')
      invalidPriceRows += 1

      if (priceMinor === 0) {
        zeroPriceRows += 1
      }
    }

    if (deliveryTimeDays === null) {
      errors.push(
        'INVALID_DELIVERY_TIME',
      )
      invalidDeliveryTimeRows += 1
    }

    if (errors.length === 0) {
      validRows += 1

      if (
        hasInvalidIdentifierFormat
      ) {
        invalidIdentifierFormat += 1
      }

      if (matchStatus === 'CONFLICT') {
        matchConflicts += 1
      } else if (
        matchStatus === 'MATCHED' &&
        matchMethod === 'SKU'
      ) {
        matchedBySku += 1
      } else if (
        matchStatus === 'MATCHED' &&
        matchMethod === 'EAN'
      ) {
        matchedByEan += 1
      } else {
        unmatched += 1
      }
    } else {
      invalidRows += 1
    }

    identifiers.push(identifier)
    eanCodes.push(eanCode)

    allItems.push({
      rowNumber: index + 1,
      identifier,
      eanCode,
      manufacturer:
        normalizeCell(
          rawSource.Manufacturer,
        ),
      name,
      description:
        normalizeCell(
          rawSource.Description,
        ),
      category:
        normalizeCell(rawSource.Category),
      productUrl,
      imageUrl,
      imageUrl2:
        normalizeCell(rawSource.ImageUrl2),
      priceRaw,
      priceMinor,
      netPriceRaw,
      netPriceMinor:
        netPriceRaw
          ? parseMoneyMinor(netPriceRaw)
          : null,
      deliveryCostRaw,
      deliveryCostMinor:
        deliveryCostRaw
          ? parseMoneyMinor(
              deliveryCostRaw,
            )
          : null,
      deliveryTimeRaw,
      deliveryTimeDays,
      normalizedSku,
      matchStatus,
      matchMethod,
      matchedProductId,
      matchedSku,
      errors,
      rawSource,
    })
  }

  return {
    headers,
    summary: {
      rows: csvRows.length - 1,
      validRows,
      invalidRows,
      zeroPriceRows,
      invalidPriceRows,
      invalidDeliveryTimeRows,
      missingEanRows,
      matchedBySku,
      matchedByEan,
      unmatched,
      invalidIdentifierFormat,
      matchConflicts,
      hubProductCount:
        hubProducts.length,
      duplicateIdentifierCount:
        countDuplicates(identifiers),
      duplicateEanCount:
        countDuplicates(eanCodes),
      previewRows:
        Math.min(
          allItems.length,
          PREVIEW_LIMIT,
        ),
    },
    allItems,
  }
}

function toCatalogPreviewItem(
  item: CatalogAnalyzedItem,
): CatalogPreviewItem {
  const {
    description: _description,
    rawSource: _rawSource,
    ...previewItem
  } = item

  return previewItem
}

function createCatalogSourceFingerprint(
  item: CatalogAnalyzedItem,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rawSource: item.rawSource,
        normalizedSku: item.normalizedSku,
        priceMinor: item.priceMinor,
        netPriceMinor: item.netPriceMinor,
        deliveryCostMinor:
          item.deliveryCostMinor,
        deliveryTimeDays:
          item.deliveryTimeDays,
        matchStatus: item.matchStatus,
        matchMethod: item.matchMethod,
        matchedProductId:
          item.matchedProductId,
      }),
    )
    .digest('hex')
}

arukeresoApi.post(
  '/catalog/preview',
  async (context) => {
    try {
      const formData =
        await context.req.formData()

      const uploadedFile =
        formData.get('file')

      if (
        !uploadedFile ||
        typeof uploadedFile === 'string'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'CMS CSV fajl feltoltese szukseges a file mezoben.',
          },
          400,
        )
      }

      const csvText =
        await uploadedFile.text()

      const analysis =
        await analyzeCatalogCsv(csvText)

      const data =
        analysis.allItems
          .slice(0, PREVIEW_LIMIT)
          .map(toCatalogPreviewItem)

      const invalidRows =
        analysis.allItems
          .filter(
            (item) =>
              item.errors.length > 0,
          )
          .slice(0, INVALID_ROWS_LIMIT)
          .map((item) => ({
            rowNumber: item.rowNumber,
            identifier: item.identifier,
            eanCode: item.eanCode,
            name: item.name,
            priceRaw: item.priceRaw,
            deliveryTimeRaw:
              item.deliveryTimeRaw,
            errors: item.errors,
          }))

      return context.json({
        status: 'ok',
        fileName: uploadedFile.name,
        headers: analysis.headers,
        summary: analysis.summary,
        data,
        invalidRows,
      })

    } catch (error) {
      if (
        error instanceof
          CatalogCsvValidationError
      ) {
        return context.json(
          {
            status: 'error',
            message: error.message,
            ...(error.headers
              ? {
                  headers: error.headers,
                  missingHeaders:
                    error.missingHeaders ?? [],
                }
              : {}),
          },
          400,
        )
      }

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'CMS CSV preview failed.',
        },
        500,
      )
    }
  },
)

arukeresoApi.post(
  '/catalog/import',
  async (context) => {
    try {
      const formData =
        await context.req.formData()

      if (formData.get('confirm') !== 'true') {
        return context.json(
          {
            status: 'error',
            message:
              'Az importáláshoz explicit confirm=true szükséges.',
          },
          400,
        )
      }

      const uploadedFile =
        formData.get('file')

      if (
        !uploadedFile ||
        typeof uploadedFile === 'string'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'CMS CSV fajl feltoltese szukseges a file mezoben.',
          },
          400,
        )
      }

      const analysis =
        await analyzeCatalogCsv(
          await uploadedFile.text(),
        )

      const validItems =
        analysis.allItems.filter(
          (item) => item.errors.length === 0,
        )

      if (validItems.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'A katalógus import nem tartalmaz érvényes importálható sort.',
            summary: analysis.summary,
          },
          422,
        )
      }

      const sourceItemKeys =
        validItems.map(
          (item) => item.identifier as string,
        )

      if (
        new Set(sourceItemKeys).size !==
        sourceItemKeys.length
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Az érvényes CSV sorok között duplikált Identifier található.',
            summary: analysis.summary,
          },
          409,
        )
      }

      const requestedConnection =
        formData.get('connectionId')

      const requestedConnectionId =
        typeof requestedConnection === 'string'
          ? requestedConnection.trim() || null
          : null

      const database = requireDatabase()

      const activeConnections = await database
        .select({
          id: dataConnections.id,
        })
        .from(dataConnections)
        .where(
          and(
            eq(
              dataConnections.sourceType,
              'CSV_UPLOAD',
            ),
            eq(
              dataConnections.purpose,
              'CATALOG',
            ),
            eq(dataConnections.isActive, true),
            ...(requestedConnectionId
              ? [
                  eq(
                    dataConnections.id,
                    requestedConnectionId,
                  ),
                ]
              : []),
          ),
        )
        .limit(2)

      if (activeConnections.length !== 1) {
        return context.json(
          {
            status: 'error',
            message:
              activeConnections.length === 0
                ? 'Nem található aktív CSV katalógusforrás.'
                : 'Több aktív CSV katalógusforrás található; connectionId szükséges.',
          },
          409,
        )
      }

      const connectionId =
        activeConnections[0].id

      const now = new Date()

      const sourceItems = validItems.map(
        (item) => ({
          connectionId,
          productId: item.matchedProductId,
          sourceItemKey:
            item.identifier as string,
          identifier: item.identifier,
          eanCode: item.eanCode,
          manufacturer: item.manufacturer,
          name: item.name,
          description: item.description,
          category: item.category,
          productUrl: item.productUrl,
          imageUrl: item.imageUrl,
          imageUrl2: item.imageUrl2,
          priceMinor: item.priceMinor,
          netPriceMinor: item.netPriceMinor,
          deliveryCostMinor:
            item.deliveryCostMinor,
          deliveryTimeRaw:
            item.deliveryTimeRaw,
          deliveryTimeDays:
            item.deliveryTimeDays,
          additionalImageUrlsJson: '[]',
          sourceFingerprint:
            createCatalogSourceFingerprint(
              item,
            ),
          rawDataJson:
            JSON.stringify(item.rawSource),
          matchStatus: item.matchStatus,
          matchError:
            item.matchStatus === 'CONFLICT'
              ? 'SKU_EAN_CONFLICT'
              : null,
          observedAt: now,
          updatedAt: now,
        }),
      )

      const existingItems = await database
        .select({
          sourceItemKey:
            catalogSourceItems.sourceItemKey,
          sourceFingerprint:
            catalogSourceItems.sourceFingerprint,
        })
        .from(catalogSourceItems)
        .where(
          eq(
            catalogSourceItems.connectionId,
            connectionId,
          ),
        )

      const currentKeySet =
        new Set(sourceItemKeys)

      const existingFingerprintByKey =
        new Map(
          existingItems.map((item) => [
            item.sourceItemKey,
            item.sourceFingerprint,
          ]),
        )

      const staleRemoved =
        existingItems.filter(
          (item) =>
            !currentKeySet.has(
              item.sourceItemKey,
            ),
        ).length

      const changedItemCount =
        sourceItems.filter(
          (item) =>
            existingFingerprintByKey.get(
              item.sourceItemKey,
            ) !== item.sourceFingerprint,
        ).length + staleRemoved

      const [run] = await database
        .insert(dataConnectionRuns)
        .values({
          connectionId,
          triggerType: 'MANUAL',
          status: 'RUNNING',
          importStatus: 'RUNNING',
          startedAt: now,
        })
        .returning({
          id: dataConnectionRuns.id,
        })

      if (!run) {
        throw new Error(
          'A katalógus import futása nem hozható létre.',
        )
      }

      try {
        const chunkSize = 200
        const upsertQueries = []

        for (
          let offset = 0;
          offset < sourceItems.length;
          offset += chunkSize
        ) {
          const chunk = sourceItems
            .slice(
              offset,
              offset + chunkSize,
            )
            .map((item) => ({
              ...item,
              lastImportRunId: run.id,
            }))

          upsertQueries.push(
            database
              .insert(catalogSourceItems)
              .values(chunk)
              .onConflictDoUpdate({
                target: [
                  catalogSourceItems.connectionId,
                  catalogSourceItems.sourceItemKey,
                ],
                set: {
                  productId:
                    sql`excluded.product_id`,
                  identifier:
                    sql`excluded.identifier`,
                  eanCode:
                    sql`excluded.ean_code`,
                  manufacturer:
                    sql`excluded.manufacturer`,
                  name: sql`excluded.name`,
                  description:
                    sql`excluded.description`,
                  category:
                    sql`excluded.category`,
                  productUrl:
                    sql`excluded.product_url`,
                  imageUrl:
                    sql`excluded.image_url`,
                  imageUrl2:
                    sql`excluded.image_url_2`,
                  priceMinor:
                    sql`excluded.price_minor`,
                  netPriceMinor:
                    sql`excluded.net_price_minor`,
                  deliveryCostMinor:
                    sql`excluded.delivery_cost_minor`,
                  deliveryTimeRaw:
                    sql`excluded.delivery_time_raw`,
                  deliveryTimeDays:
                    sql`excluded.delivery_time_days`,
                  additionalImageUrlsJson:
                    sql`excluded.additional_image_urls_json`,
                  sourceFingerprint:
                    sql`excluded.source_fingerprint`,
                  rawDataJson:
                    sql`excluded.raw_data_json`,
                  matchStatus:
                    sql`excluded.match_status`,
                  matchError:
                    sql`excluded.match_error`,
                  lastImportRunId:
                    sql`excluded.last_import_run_id`,
                  observedAt:
                    sql`excluded.observed_at`,
                  updatedAt:
                    sql`excluded.updated_at`,
                },
              }),
          )
        }

        const staleDelete = database
          .delete(catalogSourceItems)
          .where(
            and(
              eq(
                catalogSourceItems.connectionId,
                connectionId,
              ),
              or(
                isNull(
                  catalogSourceItems.lastImportRunId,
                ),
                ne(
                  catalogSourceItems.lastImportRunId,
                  run.id,
                ),
              ),
            ),
          )

        const completeRun = database
          .update(dataConnectionRuns)
          .set({
            status: 'COMPLETED',
            importStatus:
              analysis.summary.invalidRows > 0
                ? 'SUCCESS_WITH_INVALID_ROWS'
                : 'SUCCESS',
            rowsImported: sourceItems.length,
            changedItemCount,
            finishedAt: new Date(),
          })
          .where(
            eq(dataConnectionRuns.id, run.id),
          )

        const markConnectionReady = database
          .update(dataConnections)
          .set({
            status: 'READY',
            lastSuccessfulAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            eq(dataConnections.id, connectionId),
          )

        const batchQueries = [
          ...upsertQueries,
          staleDelete,
          completeRun,
          markConnectionReady,
        ]

        await database.batch(
          batchQueries as [
            (typeof batchQueries)[number],
            ...(typeof batchQueries)[number][],
          ],
        )

        return context.json({
          status: 'ok',
          importRunId: run.id,
          connectionId,
          summary: {
            ...analysis.summary,
            upserted: sourceItems.length,
            staleRemoved,
          },
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'CMS katalógus import sikertelen.'

        try {
          await database.batch([
            database
              .update(dataConnectionRuns)
              .set({
                status: 'FAILED',
                importStatus: 'FAILED',
                error: message,
                finishedAt: new Date(),
              })
              .where(
                eq(dataConnectionRuns.id, run.id),
              ),
            database
              .update(dataConnections)
              .set({
                status: 'ERROR',
                lastError: message,
                updatedAt: new Date(),
              })
              .where(
                eq(
                  dataConnections.id,
                  connectionId,
                ),
              ),
          ])
        } catch (statusError) {
          console.error(
            'Catalog import failure status update failed:',
            statusError,
          )
        }

        console.error(
          'Catalog import failed:',
          error,
        )

        return context.json(
          {
            status: 'error',
            importRunId: run.id,
            message,
          },
          500,
        )
      }
    } catch (error) {
      if (
        error instanceof
          CatalogCsvValidationError
      ) {
        return context.json(
          {
            status: 'error',
            message: error.message,
            ...(error.headers
              ? {
                  headers: error.headers,
                  missingHeaders:
                    error.missingHeaders ?? [],
                }
              : {}),
          },
          400,
        )
      }

      console.error(
        'Catalog import setup failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'CMS katalógus import sikertelen.',
        },
        500,
      )
    }
  },
)

const PRICING_SHEET_NAME = 'Napi adatok'

const PRICING_REQUIRED_HEADERS = [
  'Cikkszám',
  'Index',
  'Mediánindex',
  'Átlagindex',
] as const

const PRICING_PREVIEW_LIMIT = 50
const PRICING_INVALID_ROWS_LIMIT = 100
const PRICING_NO_COMPETITOR_PREVIEW_LIMIT = 20

type PricingHeader =
  (typeof PRICING_REQUIRED_HEADERS)[number]

type PricingMarketStatus =
  | 'HAS_COMPETITOR'
  | 'NO_COMPETITOR'
  | 'PARTIAL_MARKET_DATA'

type PricingPreviewItem = {
  productId: string
  sku: string
  sourceItemKey: string
  identifier: string
  index: number | null
  medianIndex: number | null
  averageIndex: number | null
  indexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  marketStatus: PricingMarketStatus
}

type PricingInvalidRow = {
  rowNumber: number
  sku: string
  errors: string[]
}

type PricingValidItem = {
  productId: string
  sku: string
  sourceItemKey: string
  identifier: string
  index: number | null
  medianIndex: number | null
  averageIndex: number | null
  indexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  marketStatus: PricingMarketStatus
}

class PricingWorkbookValidationError extends Error {
  constructor(
    message: string,
    readonly missingHeaders?: string[],
  ) {
    super(message)
    this.name =
      'PricingWorkbookValidationError'
  }
}

function parsePricingRatio(
  value: unknown,
):
  | { valid: true; ratio: number | null }
  | { valid: false } {
  if (
    value === null ||
    value === undefined
  ) {
    return { valid: true, ratio: null }
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { valid: true, ratio: value }
      : { valid: false }
  }

  if (typeof value === 'string') {
    const trimmed = value
      .replace(/\u00a0/g, '')
      .replace(/\s+/g, '')
      .trim()

    if (!trimmed) {
      return { valid: true, ratio: null }
    }

    const normalized =
      trimmed.includes(',') &&
      trimmed.includes('.')
        ? trimmed
            .split('.')
            .join('')
            .replace(',', '.')
        : trimmed.replace(',', '.')

    const parsed = Number(normalized)

    return Number.isFinite(parsed)
      ? { valid: true, ratio: parsed }
      : { valid: false }
  }

  return { valid: false }
}

function toPricingBps(
  value: number | null,
) {
  return value === null
    ? null
    : Math.round(value * 10000)
}

async function analyzePricingWorkbook(
  workbookBytes: Uint8Array,
) {
  let workbook: XLSX.WorkBook

  try {
    workbook = XLSX.read(
      workbookBytes,
      { type: 'array' },
    )
  } catch {
    throw new PricingWorkbookValidationError(
      'A feltöltött fájl nem olvasható XLSX munkafüzetként.',
    )
  }

  const sheet =
    workbook.Sheets[
      PRICING_SHEET_NAME
    ]

  if (!sheet) {
    throw new PricingWorkbookValidationError(
      `A "${PRICING_SHEET_NAME}" munkalap nem található a munkafüzetben.`,
    )
  }

  const sheetRows =
    XLSX.utils.sheet_to_json<unknown[]>(
      sheet,
      {
        header: 1,
        defval: null,
        raw: true,
      },
    )

  let headerRowIndex = -1
  let headerIndexByName = new Map<
    string,
    number
  >()

  for (
    let rowIndex = 0;
    rowIndex <
    Math.min(sheetRows.length, 10);
    rowIndex += 1
  ) {
    const row = sheetRows[rowIndex] ?? []
    const candidate = new Map<
      string,
      number
    >()

    row.forEach(
      (cell, cellIndex) => {
        if (
          typeof cell === 'string' ||
          typeof cell === 'number'
        ) {
          candidate.set(
            String(cell).trim(),
            cellIndex,
          )
        }
      },
    )

    if (
      candidate.has('Cikkszám')
    ) {
      headerRowIndex = rowIndex
      headerIndexByName = candidate
      break
    }
  }

  if (headerRowIndex < 0) {
    throw new PricingWorkbookValidationError(
      'A fejlécsor nem található a "Napi adatok" munkalapon.',
      [...PRICING_REQUIRED_HEADERS],
    )
  }

  const missingHeaders =
    PRICING_REQUIRED_HEADERS.filter(
      (header) =>
        !headerIndexByName.has(header),
    )

  if (missingHeaders.length > 0) {
    throw new PricingWorkbookValidationError(
      `Hiányzó kötelező oszlopok: ${missingHeaders.join(', ')}.`,
      [...missingHeaders],
    )
  }

  const getCell = (
    row: unknown[],
    header: PricingHeader,
  ) => {
    const cellIndex =
      headerIndexByName.get(header)

    if (cellIndex === undefined) {
      return null
    }

    return row[cellIndex] ?? null
  }

  const database =
    requireDatabase()

  const hubProducts = await database
    .select({
      id: products.id,
      sku: products.sku,
    })
    .from(products)

  const productBySku = new Map(
    hubProducts.map(
      (product) => [
        product.sku,
        product,
      ],
    ),
  )

  const previewRows: PricingPreviewItem[] =
    []

  const validItems: PricingValidItem[] =
    []

  const invalidRows: PricingInvalidRow[] =
    []

  const noCompetitorPreviewRows: Array<{
    productId: string
    sku: string
    marketStatus: PricingMarketStatus
  }> = []

  let rows = 0
  let matchedRows = 0
  let unmatchedRows = 0
  let validMatchedRows = 0
  let invalidMatchedRows = 0
  let duplicateSkuRows = 0
  let rowsWithIndex = 0
  let rowsWithMedianIndex = 0
  let rowsWithAverageIndex = 0
  let matchedRowsWithCompetitor = 0
  let matchedRowsWithoutCompetitor = 0
  let matchedRowsWithPartialMarketData = 0

  const skuOccurrences = new Map<
    string,
    number
  >()

  for (
    let scanIndex = headerRowIndex + 1;
    scanIndex < sheetRows.length;
    scanIndex += 1
  ) {
    const scanRow =
      sheetRows[scanIndex] ?? []

    const scanSkuCell = getCell(
      scanRow,
      'Cikkszám',
    )

    const scanSku =
      scanSkuCell === null ||
      scanSkuCell === undefined
        ? ''
        : String(scanSkuCell).trim()

    if (
      !scanSku &&
      getCell(scanRow, 'Index') ===
        null &&
      getCell(
        scanRow,
        'Mediánindex',
      ) === null &&
      getCell(
        scanRow,
        'Átlagindex',
      ) === null
    ) {
      continue
    }

    if (scanSku) {
      skuOccurrences.set(
        scanSku,
        (skuOccurrences.get(scanSku) ??
          0) + 1,
      )
    }
  }

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < sheetRows.length;
    rowIndex += 1
  ) {
    const row = sheetRows[rowIndex] ?? []

    const rawSku = getCell(
      row,
      'Cikkszám',
    )

    const sku =
      rawSku === null ||
      rawSku === undefined
        ? ''
        : String(rawSku).trim()

    const rawIndex = getCell(
      row,
      'Index',
    )

    const rawMedianIndex = getCell(
      row,
      'Mediánindex',
    )

    const rawAverageIndex = getCell(
      row,
      'Átlagindex',
    )

    const isEmptyRow =
      !sku &&
      rawIndex === null &&
      rawMedianIndex === null &&
      rawAverageIndex === null

    if (isEmptyRow) {
      continue
    }

    rows += 1

    const rowNumber = rowIndex + 1

    const isDuplicateSku =
      (skuOccurrences.get(sku) ?? 0) >
      1

    if (isDuplicateSku) {
      duplicateSkuRows += 1
    }

    const matchedProduct = sku
      ? (productBySku.get(sku) ?? null)
      : null

    if (!matchedProduct) {
      unmatchedRows += 1
      continue
    }

    matchedRows += 1

    const parsedIndex =
      parsePricingRatio(rawIndex)

    const parsedMedianIndex =
      parsePricingRatio(rawMedianIndex)

    const parsedAverageIndex =
      parsePricingRatio(
        rawAverageIndex,
      )

    const errors: string[] = []

    if (isDuplicateSku) {
      errors.push('DUPLICATE_SKU')
    }

    if (
      !parsedIndex.valid ||
      (parsedIndex.valid &&
        parsedIndex.ratio !== null &&
        !(parsedIndex.ratio > 0))
    ) {
      errors.push('INVALID_INDEX')
    }

    if (
      !parsedMedianIndex.valid ||
      (parsedMedianIndex.valid &&
        parsedMedianIndex.ratio !==
          null &&
        !(parsedMedianIndex.ratio > 0))
    ) {
      errors.push(
        'INVALID_MEDIAN_INDEX',
      )
    }

    if (
      !parsedAverageIndex.valid ||
      (parsedAverageIndex.valid &&
        parsedAverageIndex.ratio !==
          null &&
        !(parsedAverageIndex.ratio > 0))
    ) {
      errors.push(
        'INVALID_AVERAGE_INDEX',
      )
    }

    if (errors.length > 0) {
      invalidMatchedRows += 1

      if (
        invalidRows.length <
        PRICING_INVALID_ROWS_LIMIT
      ) {
        invalidRows.push({
          rowNumber,
          sku,
          errors,
        })
      }

      continue
    }

    validMatchedRows += 1

    const index =
      parsedIndex.valid
        ? parsedIndex.ratio
        : null

    const medianIndex =
      parsedMedianIndex.valid
        ? parsedMedianIndex.ratio
        : null

    const averageIndex =
      parsedAverageIndex.valid
        ? parsedAverageIndex.ratio
        : null

    if (index !== null) {
      rowsWithIndex += 1
    }

    if (medianIndex !== null) {
      rowsWithMedianIndex += 1
    }

    if (averageIndex !== null) {
      rowsWithAverageIndex += 1
    }

    const marketStatus =
      derivePricingMarketStatus(
        index,
        medianIndex,
        averageIndex,
      )

    if (
      marketStatus === 'HAS_COMPETITOR'
    ) {
      matchedRowsWithCompetitor += 1
    } else if (
      marketStatus === 'NO_COMPETITOR'
    ) {
      matchedRowsWithoutCompetitor += 1

      if (
        noCompetitorPreviewRows.length <
        PRICING_NO_COMPETITOR_PREVIEW_LIMIT
      ) {
        noCompetitorPreviewRows.push({
          productId: matchedProduct.id,
          sku,
          marketStatus,
        })
      }
    } else {
      matchedRowsWithPartialMarketData += 1
    }

    const validItem: PricingValidItem = {
      productId: matchedProduct.id,
      sku,
      sourceItemKey: sku,
      identifier: sku,
      index,
      medianIndex,
      averageIndex,
      indexBps: toPricingBps(index),
      medianIndexBps:
        toPricingBps(medianIndex),
      averageIndexBps:
        toPricingBps(averageIndex),
      marketStatus,
    }

    validItems.push(validItem)

    if (
      previewRows.length <
      PRICING_PREVIEW_LIMIT
    ) {
      previewRows.push(validItem)
    }
  }

  return {
    summary: {
      rows,
      matchedRows,
      unmatchedRows,
      validMatchedRows,
      invalidMatchedRows,
      duplicateSkuRows,
      rowsWithIndex,
      rowsWithMedianIndex,
      rowsWithAverageIndex,
      matchedRowsWithCompetitor,
      matchedRowsWithoutCompetitor,
      matchedRowsWithPartialMarketData,
    },
    previewRows,
    invalidRows,
    noCompetitorPreviewRows,
    validItems,
  }
}

arukeresoApi.post(
  '/pricing/preview',
  async (context) => {
    try {
      const formData =
        await context.req.formData()

      const uploadedFile =
        formData.get('file')

      if (
        !uploadedFile ||
        typeof uploadedFile === 'string'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'XLSX fájl feltöltése szükséges a file mezőben.',
          },
          400,
        )
      }

      const workbookBytes = new Uint8Array(
        await uploadedFile.arrayBuffer(),
      )

      const analysis =
        await analyzePricingWorkbook(
          workbookBytes,
        )

      return context.json({
        status: 'ok',
        fileName: uploadedFile.name,
        summary: analysis.summary,
        previewRows:
          analysis.previewRows,
        invalidRows:
          analysis.invalidRows,
        noCompetitorPreviewRows:
          analysis.noCompetitorPreviewRows,
      })
    } catch (error) {
      if (
        error instanceof
        PricingWorkbookValidationError
      ) {
        return context.json(
          {
            status: 'error',
            message: error.message,
            ...(error.missingHeaders
              ? {
                  missingHeaders:
                    error.missingHeaders,
                }
              : {}),
          },
          422,
        )
      }

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Pricing preview failed.',
        },
        500,
      )
    }
  },
)

const PRICING_MARKET_CODE = 'HU'
const PRICING_CURRENCY = 'HUF'
const PRICING_IMPORT_CHUNK_SIZE = 200

type NormalizedPricingItem = {
  productId: string
  sku: string
  sourceItemKey: string
  identifier: string
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  marketStatus: PricingMarketStatus
}

function createPricingSourceFingerprint(
  item: NormalizedPricingItem,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sku: item.sku,
        priceIndexBps:
          item.priceIndexBps,
        medianIndexBps:
          item.medianIndexBps,
        averageIndexBps:
          item.averageIndexBps,
        marketStatus: item.marketStatus,
      }),
    )
    .digest('hex')
}

async function applyPricingSnapshot(args: {
  connectionId: string
  items: NormalizedPricingItem[]
}): Promise<{
  importedRows: number
  inserted: number
  updated: number
  unchanged: number
  staleRemoved: number
}> {
  const { connectionId, items } = args
  const database = requireDatabase()
  const now = new Date()

  const sourceItems = items.map(
    (item) => ({
      connectionId,
      productId: item.productId,
      sourceItemKey:
        item.sourceItemKey,
      identifier: item.identifier,
      marketCode:
        PRICING_MARKET_CODE,
      currency: PRICING_CURRENCY,
      priceIndexBps:
        item.priceIndexBps,
      medianIndexBps:
        item.medianIndexBps,
      averageIndexBps:
        item.averageIndexBps,
      dataStatus: item.marketStatus,
      sourceFingerprint:
        createPricingSourceFingerprint(
          item,
        ),
      rawDataJson: JSON.stringify({
        sku: item.sku,
        index:
          item.priceIndexBps === null
            ? null
            : item.priceIndexBps /
              10000,
        medianIndex:
          item.medianIndexBps ===
          null
            ? null
            : item.medianIndexBps /
              10000,
        averageIndex:
          item.averageIndexBps ===
          null
            ? null
            : item.averageIndexBps /
              10000,
        marketStatus:
          item.marketStatus,
      }),
      observedAt: now,
      updatedAt: now,
    }),
  )

  const currentKeySet = new Set(
    sourceItems.map(
      (item) => item.sourceItemKey,
    ),
  )

  const existingItems = await database
    .select({
      sourceItemKey:
        pricingSourceItems.sourceItemKey,
      sourceFingerprint:
        pricingSourceItems.sourceFingerprint,
    })
    .from(pricingSourceItems)
    .where(
      and(
        eq(
          pricingSourceItems.connectionId,
          connectionId,
        ),
        eq(
          pricingSourceItems.marketCode,
          PRICING_MARKET_CODE,
        ),
        eq(
          pricingSourceItems.currency,
          PRICING_CURRENCY,
        ),
      ),
    )

  const existingFingerprintByKey =
    new Map(
      existingItems.map((item) => [
        item.sourceItemKey,
        item.sourceFingerprint,
      ]),
    )

  let inserted = 0
  let updated = 0
  let unchanged = 0

  const changedItems = sourceItems.filter(
    (item) => {
      const existing =
        existingFingerprintByKey.get(
          item.sourceItemKey,
        )

      if (existing === undefined) {
        inserted += 1
        return true
      }

      if (
        existing !==
        item.sourceFingerprint
      ) {
        updated += 1
        return true
      }

      unchanged += 1
      return false
    },
  )

  const staleRemoved =
    existingItems.filter(
      (item) =>
        !currentKeySet.has(
          item.sourceItemKey,
        ),
    ).length

  try {
    const writeQueries = []

    for (
      let offset = 0;
      offset < changedItems.length;
      offset +=
        PRICING_IMPORT_CHUNK_SIZE
    ) {
      writeQueries.push(
        database
          .insert(pricingSourceItems)
          .values(
            changedItems.slice(
              offset,
              offset +
                PRICING_IMPORT_CHUNK_SIZE,
            ),
          )
          .onConflictDoUpdate({
            target: [
              pricingSourceItems.connectionId,
              pricingSourceItems.sourceItemKey,
              pricingSourceItems.marketCode,
              pricingSourceItems.currency,
            ],
            set: {
              productId:
                sql`excluded.product_id`,
              identifier:
                sql`excluded.identifier`,
              priceIndexBps:
                sql`excluded.price_index_bps`,
              medianIndexBps:
                sql`excluded.median_index_bps`,
              averageIndexBps:
                sql`excluded.average_index_bps`,
              dataStatus:
                sql`excluded.data_status`,
              sourceFingerprint:
                sql`excluded.source_fingerprint`,
              rawDataJson:
                sql`excluded.raw_data_json`,
              observedAt:
                sql`excluded.observed_at`,
              updatedAt:
                sql`excluded.updated_at`,
            },
          }),
      )
    }

    writeQueries.push(
      database
        .delete(pricingSourceItems)
        .where(
          and(
            eq(
              pricingSourceItems.connectionId,
              connectionId,
            ),
            eq(
              pricingSourceItems.marketCode,
              PRICING_MARKET_CODE,
            ),
            eq(
              pricingSourceItems.currency,
              PRICING_CURRENCY,
            ),
            notInArray(
              pricingSourceItems.sourceItemKey,
              [...currentKeySet],
            ),
          ),
        ),
    )

    writeQueries.push(
      database
        .update(dataConnections)
        .set({
          status: 'READY',
          lastSuccessfulAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        ),
    )

    await database.batch(
      writeQueries as [
        (typeof writeQueries)[number],
        ...(typeof writeQueries)[number][],
      ],
    )

    return {
      importedRows: sourceItems.length,
      inserted,
      updated,
      unchanged,
      staleRemoved,
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Árazási import sikertelen.'

    try {
      await database
        .update(dataConnections)
        .set({
          status: 'ERROR',
          lastError: message,
          updatedAt: new Date(),
        })
        .where(
          eq(
            dataConnections.id,
            connectionId,
          ),
        )
    } catch (statusError) {
      console.error(
        'Pricing import failure status update failed:',
        statusError,
      )
    }

    console.error(
      'Pricing import failed:',
      error,
    )

    throw new Error(message)
  }
}

const PRICING_SYNC_MAX_ROWS = 10000
const PRICING_SYNC_SAMPLE_LIMIT = 20

const PRICING_SYNC_TOKEN_ENV =
  'COMMERCE_HUB_ARUKERESO_PRICING_SYNC_TOKEN'

function derivePricingMarketStatus(
  index: number | null,
  medianIndex: number | null,
  averageIndex: number | null,
): PricingMarketStatus {
  const hasIndex = index !== null
  const hasMedianIndex =
    medianIndex !== null
  const hasAverageIndex =
    averageIndex !== null

  if (
    hasIndex &&
    hasMedianIndex &&
    hasAverageIndex
  ) {
    return 'HAS_COMPETITOR'
  }

  if (
    !hasIndex &&
    !hasMedianIndex &&
    !hasAverageIndex
  ) {
    return 'NO_COMPETITOR'
  }

  return 'PARTIAL_MARKET_DATA'
}

async function resolveActivePricingConnection(
  requestedConnectionId: string | null,
): Promise<
  | { ok: true; connectionId: string }
  | { ok: false; message: string }
> {
  const database = requireDatabase()

  const activeConnections = await database
    .select({
      id: dataConnections.id,
    })
    .from(dataConnections)
    .where(
      and(
        eq(
          dataConnections.purpose,
          'PRICING',
        ),
        eq(
          dataConnections.isActive,
          true,
        ),
        ...(requestedConnectionId
          ? [
              eq(
                dataConnections.id,
                requestedConnectionId,
              ),
            ]
          : []),
      ),
    )
    .limit(2)

  if (activeConnections.length !== 1) {
    return {
      ok: false,
      message:
        activeConnections.length === 0
          ? 'Nem található aktív árazási forrás.'
          : 'Több aktív árazási forrás található; connectionId szükséges.',
    }
  }

  return {
    ok: true,
    connectionId: activeConnections[0].id,
  }
}

function isPricingSyncTokenValid(
  provided: string,
  expected: string,
) {
  const providedBuffer = Buffer.from(
    provided,
    'utf8',
  )

  const expectedBuffer = Buffer.from(
    expected,
    'utf8',
  )

  if (
    providedBuffer.length !==
    expectedBuffer.length
  ) {
    return false
  }

  try {
    return timingSafeEqual(
      providedBuffer,
      expectedBuffer,
    )
  } catch {
    return false
  }
}

type PricingSyncAuthResult =
  | { ok: true }
  | { ok: false; status: 503 | 401 }

function checkPricingSyncAuth(
  authorizationHeader:
    | string
    | undefined
    | null,
): PricingSyncAuthResult {
  const configuredToken =
    process.env[PRICING_SYNC_TOKEN_ENV]

  if (
    !configuredToken ||
    !configuredToken.trim()
  ) {
    return { ok: false, status: 503 }
  }

  if (!authorizationHeader) {
    return { ok: false, status: 401 }
  }

  const bearerMatch =
    /^Bearer (.+)$/.exec(
      authorizationHeader.trim(),
    )

  if (
    !bearerMatch?.[1] ||
    !isPricingSyncTokenValid(
      bearerMatch[1],
      configuredToken,
    )
  ) {
    return { ok: false, status: 401 }
  }

  return { ok: true }
}

type PricingSyncPayloadSummary = {
  rows: number
  matchedRows: number
  unmatchedRows: number
  validMatchedRows: number
  invalidMatchedRows: number
  duplicateSkuRows: number
  hasCompetitor: number
  noCompetitor: number
  partialMarketData: number
}

type NormalizePricingPayloadResult =
  | {
      ok: true
      validItems: NormalizedPricingItem[]
      summary: PricingSyncPayloadSummary
      unmatchedSample: string[]
    }
  | {
      ok: false
      message: string
      summary: PricingSyncPayloadSummary
      invalidRows: Array<{
        sku: string
        errors: string[]
      }>
      duplicateSkus: string[]
    }

async function normalizePricingPayload(
  body: unknown,
): Promise<NormalizePricingPayloadResult> {
  const emptySummary: PricingSyncPayloadSummary =
    {
      rows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      validMatchedRows: 0,
      invalidMatchedRows: 0,
      duplicateSkuRows: 0,
      hasCompetitor: 0,
      noCompetitor: 0,
      partialMarketData: 0,
    }

  const fail = (
    message: string,
    partial?: Partial<
      Omit<
        Extract<
          NormalizePricingPayloadResult,
          { ok: false }
        >,
        'ok' | 'message'
      >
    >,
  ): Extract<
    NormalizePricingPayloadResult,
    { ok: false }
  > => ({
    ok: false,
    message,
    summary: {
      ...emptySummary,
      ...(partial?.summary ?? {}),
    },
    invalidRows: partial?.invalidRows ?? [],
    duplicateSkus:
      partial?.duplicateSkus ?? [],
  })

  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return fail(
      'Érvénytelen szinkron kérés: items tömb szükséges.',
    )
  }

  const { items } = body as {
    items?: unknown
  }

  if (!Array.isArray(items)) {
    return fail(
      'Érvénytelen szinkron kérés: items tömb szükséges.',
    )
  }

  if (items.length === 0) {
    return fail(
      'A szinkron kérés üres items tömböt tartalmaz.',
    )
  }

  if (
    items.length > PRICING_SYNC_MAX_ROWS
  ) {
    return fail(
      `Túl nagy szinkron kérés: legfeljebb ${PRICING_SYNC_MAX_ROWS} sor küldhető.`,
    )
  }

  const skuOccurrences = new Map<
    string,
    number
  >()

  for (const row of items) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      continue
    }

    const { sku } = row as {
      sku?: unknown
    }

    if (
      typeof sku === 'string' &&
      sku.trim()
    ) {
      const key = sku.trim()

      skuOccurrences.set(
        key,
        (skuOccurrences.get(key) ?? 0) +
          1,
      )
    }
  }

  const duplicateSkus = [...skuOccurrences]
    .filter(([, count]) => count > 1)
    .map(([sku]) => sku)
    .slice(0, PRICING_SYNC_SAMPLE_LIMIT)

  const duplicateSkuRows = [
    ...skuOccurrences,
  ]
    .filter(([, count]) => count > 1)
    .reduce(
      (total, [, count]) =>
        total + count,
      0,
    )

  if (duplicateSkus.length > 0) {
    return fail(
      'A szinkron kérés duplikált Cikkszám sorokat tartalmaz.',
      {
        summary: {
          ...emptySummary,
          rows: items.length,
          duplicateSkuRows,
        },
        duplicateSkus,
      },
    )
  }

  const database = requireDatabase()

  const hubProducts = await database
    .select({
      id: products.id,
      sku: products.sku,
    })
    .from(products)

  const productBySku = new Map(
    hubProducts.map(
      (product) => [
        product.sku,
        product,
      ],
    ),
  )

  const validItems: NormalizedPricingItem[] =
    []

  const invalidRows: Array<{
    sku: string
    errors: string[]
  }> = []

  const unmatchedSample: string[] = []

  let matchedRows = 0
  let unmatchedRows = 0
  let hasCompetitor = 0
  let noCompetitor = 0
  let partialMarketData = 0

  for (const row of items) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      invalidRows.push({
        sku: '',
        errors: ['INVALID_ROW'],
      })
      continue
    }

    const {
      sku: rawSku,
      index: rawIndex,
      medianIndex: rawMedianIndex,
      averageIndex: rawAverageIndex,
    } = row as {
      sku?: unknown
      index?: unknown
      medianIndex?: unknown
      averageIndex?: unknown
    }

    if (
      typeof rawSku !== 'string' ||
      !rawSku.trim()
    ) {
      invalidRows.push({
        sku:
          typeof rawSku === 'string'
            ? rawSku
            : '',
        errors: ['INVALID_SKU'],
      })
      continue
    }

    const sku = rawSku.trim()
    const errors: string[] = []

    const parseField = (
      value: unknown,
      code: string,
    ): number | null | undefined => {
      if (
        value === null ||
        value === undefined
      ) {
        return null
      }

      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !(value > 0)
      ) {
        errors.push(code)
        return undefined
      }

      return value
    }

    const index = parseField(
      rawIndex,
      'INVALID_INDEX',
    )

    const medianIndex = parseField(
      rawMedianIndex,
      'INVALID_MEDIAN_INDEX',
    )

    const averageIndex = parseField(
      rawAverageIndex,
      'INVALID_AVERAGE_INDEX',
    )

    if (
      index === undefined ||
      medianIndex === undefined ||
      averageIndex === undefined
    ) {
      invalidRows.push({ sku, errors })
      continue
    }

    const matchedProduct =
      productBySku.get(sku) ?? null

    if (!matchedProduct) {
      unmatchedRows += 1

      if (
        unmatchedSample.length <
        PRICING_SYNC_SAMPLE_LIMIT
      ) {
        unmatchedSample.push(sku)
      }

      continue
    }

    if (errors.length > 0) {
      invalidRows.push({ sku, errors })
      continue
    }

    matchedRows += 1

    const marketStatus =
      derivePricingMarketStatus(
        index,
        medianIndex,
        averageIndex,
      )

    if (
      marketStatus === 'HAS_COMPETITOR'
    ) {
      hasCompetitor += 1
    } else if (
      marketStatus === 'NO_COMPETITOR'
    ) {
      noCompetitor += 1
    } else {
      partialMarketData += 1
    }

    validItems.push({
      productId: matchedProduct.id,
      sku,
      sourceItemKey: sku,
      identifier: sku,
      priceIndexBps: toPricingBps(index),
      medianIndexBps:
        toPricingBps(medianIndex),
      averageIndexBps:
        toPricingBps(averageIndex),
      marketStatus,
    })
  }

  const summary: PricingSyncPayloadSummary =
    {
      rows: items.length,
      matchedRows,
      unmatchedRows,
      validMatchedRows:
        validItems.length,
      invalidMatchedRows:
        invalidRows.length,
      duplicateSkuRows: 0,
      hasCompetitor,
      noCompetitor,
      partialMarketData,
    }

  if (invalidRows.length > 0) {
    return {
      ok: false,
      message:
        'A szinkron kérés hibás sorokat tartalmaz.',
      summary,
      invalidRows:
        invalidRows.slice(
          0,
          PRICING_SYNC_SAMPLE_LIMIT,
        ),
      duplicateSkus: [],
    }
  }

  if (validItems.length === 0) {
    return {
      ok: false,
      message:
        'A szinkron kérés nem tartalmaz érvényes importálható sort.',
      summary,
      invalidRows: [],
      duplicateSkus: [],
    }
  }

  return {
    ok: true,
    validItems,
    summary,
    unmatchedSample,
  }
}

arukeresoApi.post(
  '/pricing/source/setup',
  async (context) => {
    let body: unknown

    try {
      body = await context.req.json()
    } catch {
      body = null
    }

    const { confirm, name } = (body ?? {}) as {
      confirm?: unknown
      name?: unknown
    }

    if (confirm !== true) {
      return context.json(
        {
          status: 'error',
          message:
            'A pricing forrás létrehozásához explicit confirm=true szükséges.',
        },
        400,
      )
    }

    let connectionName = 'Árukereső Pricing'

    if (name !== undefined && name !== null) {
      if (
        typeof name !== 'string' ||
        !name.trim()
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Érvénytelen connection név.',
          },
          400,
        )
      }

      connectionName = name.trim()
    }

    const database = requireDatabase()

    const existingConnections = await database
      .select()
      .from(dataConnections)
      .where(
        eq(
          dataConnections.purpose,
          'PRICING',
        ),
      )

    if (
      existingConnections.length === 0
    ) {
      const [connection] = await database
        .insert(dataConnections)
        .values({
          name: connectionName,
          sourceType: 'GOOGLE_SHEETS',
          purpose: 'PRICING',
          status: 'NOT_CONFIGURED',
          isActive: true,
        })
        .returning()

      if (!connection) {
        return context.json(
          {
            status: 'error',
            message:
              'Az árazási forrás nem jött létre.',
          },
          500,
        )
      }

      return context.json(
        {
          status: 'ok',
          created: true,
          connection,
        },
        201,
      )
    }

    if (
      existingConnections.length === 1
    ) {
      const existing =
        existingConnections[0]

      if (!existing.isActive) {
        return context.json(
          {
            status: 'error',
            message:
              'Létezik inaktív árazási forrás, manuális beavatkozás szükséges.',
            connectionId: existing.id,
          },
          409,
        )
      }

      return context.json({
        status: 'ok',
        created: false,
        connection: existing,
      })
    }

    return context.json(
      {
        status: 'error',
        message:
          'Több árazási forrás létezik, manuális beavatkozás szükséges.',
        connectionIds:
          existingConnections.map(
            (connection) =>
              connection.id,
          ),
      },
      409,
    )
  },
)

arukeresoApi.post(
  '/pricing/import',
  async (context) => {
    try {
      const formData =
        await context.req.formData()

      if (
        formData.get('confirm') !==
        'true'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Az importáláshoz explicit confirm=true szükséges.',
          },
          400,
        )
      }

      const uploadedFile =
        formData.get('file')

      if (
        !uploadedFile ||
        typeof uploadedFile === 'string'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'XLSX fájl feltöltése szükséges a file mezőben.',
          },
          400,
        )
      }

      const workbookBytes = new Uint8Array(
        await uploadedFile.arrayBuffer(),
      )

      const analysis =
        await analyzePricingWorkbook(
          workbookBytes,
        )

      if (
        analysis.summary
          .invalidMatchedRows > 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'A munkafüzet hibás egyező sorokat tartalmaz, az import megszakítva.',
            summary: analysis.summary,
            invalidRows:
              analysis.invalidRows,
          },
          422,
        )
      }

      if (
        analysis.summary
          .duplicateSkuRows > 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'A munkafüzet duplikált Cikkszám sorokat tartalmaz, az import megszakítva.',
            summary: analysis.summary,
          },
          422,
        )
      }

      if (
        analysis.validItems.length === 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Az árazási import nem tartalmaz érvényes importálható sort.',
            summary: analysis.summary,
          },
          422,
        )
      }

      const requestedConnection =
        formData.get('connectionId')

      const requestedConnectionId =
        typeof requestedConnection ===
        'string'
          ? requestedConnection.trim() ||
            null
          : null

      const resolvedConnection =
        await resolveActivePricingConnection(
          requestedConnectionId,
        )

      if (!resolvedConnection.ok) {
        return context.json(
          {
            status: 'error',
            message:
              resolvedConnection.message,
          },
          409,
        )
      }

      const connectionId =
        resolvedConnection.connectionId

      const normalizedItems: NormalizedPricingItem[] =
        analysis.validItems.map(
          (item) => ({
            productId: item.productId,
            sku: item.sku,
            sourceItemKey:
              item.sourceItemKey,
            identifier: item.identifier,
            priceIndexBps: item.indexBps,
            medianIndexBps:
              item.medianIndexBps,
            averageIndexBps:
              item.averageIndexBps,
            marketStatus:
              item.marketStatus,
          }),
        )

      let snapshot: Awaited<
        ReturnType<
          typeof applyPricingSnapshot
        >
      >

      try {
        snapshot =
          await applyPricingSnapshot({
            connectionId,
            items: normalizedItems,
          })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Árazási import sikertelen.'

        return context.json(
          {
            status: 'error',
            message,
          },
          500,
        )
      }

      return context.json({
        status: 'ok',
        connectionId,
        summary: {
          rows: analysis.summary.rows,
          matchedRows:
            analysis.summary.matchedRows,
          unmatchedRows:
            analysis.summary
              .unmatchedRows,
          importedRows:
            snapshot.importedRows,
          hasCompetitor:
            analysis.summary
              .matchedRowsWithCompetitor,
          noCompetitor:
            analysis.summary
              .matchedRowsWithoutCompetitor,
          partialMarketData:
            analysis.summary
              .matchedRowsWithPartialMarketData,
          inserted: snapshot.inserted,
          updated: snapshot.updated,
          unchanged: snapshot.unchanged,
          staleRemoved:
            snapshot.staleRemoved,
        },
      })
    } catch (error) {
      if (
        error instanceof
        PricingWorkbookValidationError
      ) {
        return context.json(
          {
            status: 'error',
            message: error.message,
            ...(error.missingHeaders
              ? {
                  missingHeaders:
                    error.missingHeaders,
                }
              : {}),
          },
          422,
        )
      }

      console.error(
        'Pricing import setup failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Árazási import sikertelen.',
        },
        500,
      )
    }
  },
)

arukeresoApi.post(
  '/pricing/sync',
  async (context) => {
    const auth =
      checkPricingSyncAuth(
        context.req.header('Authorization'),
      )

    if (!auth.ok) {
      return context.json(
        {
          status: 'error',
          message:
            auth.status === 503
              ? 'Az árazási szinkronizálás nincs konfigurálva.'
              : 'Hiányzó vagy érvénytelen hitelesítés.',
        },
        auth.status,
      )
    }

    let body: unknown

    try {
      body = await context.req.json()
    } catch {
      body = null
    }

    const normalized =
      await normalizePricingPayload(body)

    if (!normalized.ok) {
      return context.json(
        {
          status: 'error',
          message: normalized.message,
          summary: normalized.summary,
          invalidRows:
            normalized.invalidRows,
          duplicateSkus:
            normalized.duplicateSkus,
        },
        422,
      )
    }

    const resolvedConnection =
      await resolveActivePricingConnection(
        null,
      )

    if (!resolvedConnection.ok) {
      return context.json(
        {
          status: 'error',
          message:
            resolvedConnection.message,
        },
        409,
      )
    }

    let snapshot: Awaited<
      ReturnType<
        typeof applyPricingSnapshot
      >
    >

    try {
      snapshot =
        await applyPricingSnapshot({
          connectionId:
            resolvedConnection.connectionId,
          items: normalized.validItems,
        })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Árazási szinkronizálás sikertelen.'

      return context.json(
        {
          status: 'error',
          message,
        },
        500,
      )
    }

    return context.json({
      status: 'ok',
      connectionId:
        resolvedConnection.connectionId,
      summary: {
        rows: normalized.summary.rows,
        matchedRows:
          normalized.summary.matchedRows,
        unmatchedRows:
          normalized.summary
            .unmatchedRows,
        importedRows:
          snapshot.importedRows,
        hasCompetitor:
          normalized.summary
            .hasCompetitor,
        noCompetitor:
          normalized.summary
            .noCompetitor,
        partialMarketData:
          normalized.summary
            .partialMarketData,
        inserted: snapshot.inserted,
        updated: snapshot.updated,
        unchanged: snapshot.unchanged,
        staleRemoved:
          snapshot.staleRemoved,
      },
    })
  },
)

const PROMOTION_PREVIEW_LIMIT_DEFAULT = 100
const PROMOTION_PREVIEW_LIMIT_MAX = 500

type CatalogPromotionStatus =
  | 'SAFE_NEW_PRODUCT'
  | 'EXISTING_SKU'
  | 'EAN_CONFLICT'
  | 'SKU_EAN_CONFLICT'
  | 'DUPLICATE_CATALOG_SKU'
  | 'DUPLICATE_CATALOG_EAN'
  | 'MISSING_REQUIRED_DATA'
  | 'INVENTORY_MISSING'

type CatalogPromotionItem = {
  catalogSourceItemId: string
  identifier: string | null
  normalizedSku: string | null
  eanCode: string | null
  name: string | null
  manufacturer: string | null
  category: string | null
  storedProductId: string | null
  inventoryFound: boolean
  inventoryStock: number | null
  promotionStatus: CatalogPromotionStatus
  existingProductId: string | null
  existingProductSku: string | null
  detail: string | null
}

type CatalogPromotionSummary = {
  unmatchedCatalogItems: number
  inventoryCovered: number
  safeNewProducts: number
  existingSku: number
  eanConflicts: number
  skuEanConflicts: number
  duplicateCatalogSku: number
  duplicateCatalogEan: number
  missingRequiredData: number
  inventoryMissing: number
}

type CatalogPromotionAnalysis = {
  catalogRows: Array<
    typeof catalogSourceItems.$inferSelect
  >
  items: CatalogPromotionItem[]
  summary: CatalogPromotionSummary
}

async function analyzeCatalogPromotion(): Promise<CatalogPromotionAnalysis> {
  const database =
    requireDatabase()

  const [
        catalogRows,
        hubProducts,
        hubIdentifiers,
        inventoryRows,
      ] = await Promise.all([
        database
          .select()
          .from(catalogSourceItems)
          .where(
            eq(
              catalogSourceItems.matchStatus,
              'UNMATCHED',
            ),
          ),

        database
          .select({
            id: products.id,
            sku: products.sku,
          })
          .from(products),

        database
          .select({
            productId:
              productIdentifiers.productId,
            type:
              productIdentifiers.type,
            value:
              productIdentifiers.value,
          })
          .from(productIdentifiers),

        database
          .select({
            sku: inventorySourceItems.sku,
            stock:
              inventorySourceItems.stock,
          })
          .from(inventorySourceItems),
      ])

      const productBySku =
        new Map(
          hubProducts.map(
            (product) => [
              product.sku,
              product,
            ],
          ),
        )

      const productById =
        new Map(
          hubProducts.map(
            (product) => [
              product.id,
              product,
            ],
          ),
        )

      const productByEan =
        new Map<
          string,
          {
            id: string
            sku: string
          }
        >()

      for (
        const identifierRow
        of hubIdentifiers
      ) {
        if (
          identifierRow.type !==
          'EAN'
        ) {
          continue
        }

        const product =
          productById.get(
            identifierRow.productId,
          )

        if (!product) {
          continue
        }

        productByEan.set(
          identifierRow.value.trim(),
          product,
        )
      }

      const inventoryStockBySku =
        new Map<string, number>()

      for (const row of inventoryRows) {
        const existing =
          inventoryStockBySku.get(
            row.sku,
          )

        if (
          existing === undefined ||
          row.stock > existing
        ) {
          inventoryStockBySku.set(
            row.sku,
            row.stock,
          )
        }
      }

      const normalizedSkuByCatalogId =
        new Map<string, string | null>()

      const skuGroupCounts =
        new Map<string, number>()

      const eanGroupCounts =
        new Map<string, number>()

      for (const row of catalogRows) {
        const normalizedSku =
          row.identifier
            ? cmsIdentifierToSku(
                row.identifier,
              )
            : null

        normalizedSkuByCatalogId.set(
          row.id,
          normalizedSku,
        )

        if (normalizedSku) {
          skuGroupCounts.set(
            normalizedSku,
            (skuGroupCounts.get(
              normalizedSku,
            ) ?? 0) + 1,
          )
        }

        const eanKey =
          row.eanCode?.trim() || null

        if (eanKey) {
          eanGroupCounts.set(
            eanKey,
            (eanGroupCounts.get(
              eanKey,
            ) ?? 0) + 1,
          )
        }
      }

      const items = catalogRows.map(
        (row) => {
          const normalizedSku =
            normalizedSkuByCatalogId.get(
              row.id,
            ) ?? null

          const eanKey =
            row.eanCode?.trim() || null

          const inventoryStock =
            normalizedSku
              ? inventoryStockBySku.get(
                  normalizedSku,
                ) ?? null
              : null

          const skuOwner =
            normalizedSku
              ? productBySku.get(
                  normalizedSku,
                ) ?? null
              : null

          const eanOwner =
            eanKey
              ? productByEan.get(
                  eanKey,
                ) ?? null
              : null

          let promotionStatus: CatalogPromotionStatus
          let detail: string | null =
            null

          if (
            !normalizedSku ||
            !row.name?.trim()
          ) {
            promotionStatus =
              'MISSING_REQUIRED_DATA'

            detail = !normalizedSku
              ? 'Identifier cannot be normalized to a Hub SKU.'
              : 'Product name is missing.'
          } else if (
            !inventoryStockBySku.has(
              normalizedSku,
            )
          ) {
            promotionStatus =
              'INVENTORY_MISSING'

            detail =
              'Normalized SKU was not found in inventory_source_items.'
          } else if (
            (skuGroupCounts.get(
              normalizedSku,
            ) ?? 0) > 1
          ) {
            promotionStatus =
              'DUPLICATE_CATALOG_SKU'

            detail = `Multiple catalog items normalize to SKU ${normalizedSku}.`
          } else if (
            eanKey &&
            (eanGroupCounts.get(
              eanKey,
            ) ?? 0) > 1
          ) {
            promotionStatus =
              'DUPLICATE_CATALOG_EAN'

            detail = `Multiple catalog items share EAN ${eanKey}.`
          } else if (
            skuOwner &&
            eanOwner &&
            skuOwner.id !==
              eanOwner.id
          ) {
            promotionStatus =
              'SKU_EAN_CONFLICT'

            detail = `SKU belongs to ${skuOwner.sku} but EAN belongs to ${eanOwner.sku}.`
          } else if (
            !skuOwner &&
            eanOwner
          ) {
            promotionStatus =
              'EAN_CONFLICT'

            detail = `EAN already belongs to ${eanOwner.sku}.`
          } else if (skuOwner) {
            promotionStatus =
              'EXISTING_SKU'

            detail =
              'SKU already exists in products but this catalog row is still UNMATCHED; its stored match state is stale and needs a rematch.'
          } else {
            promotionStatus =
              'SAFE_NEW_PRODUCT'
          }

          return {
            catalogSourceItemId: row.id,
            identifier: row.identifier,
            normalizedSku,
            eanCode: row.eanCode,
            name: row.name,
            manufacturer:
              row.manufacturer,
            category: row.category,
            storedProductId:
              row.productId,
            inventoryFound:
              normalizedSku
                ? inventoryStockBySku.has(
                    normalizedSku,
                  )
                : false,
            inventoryStock,
            promotionStatus,
            existingProductId:
              skuOwner?.id ??
              eanOwner?.id ??
              null,
            existingProductSku:
              skuOwner?.sku ??
              eanOwner?.sku ??
              null,
            detail,
          }
        },
      )

      const countStatus = (
        status: CatalogPromotionStatus,
      ) =>
        items.filter(
          (item) =>
            item.promotionStatus ===
            status,
        ).length

      const summary = {
        unmatchedCatalogItems:
          items.length,
        inventoryCovered: items.filter(
          (item) => item.inventoryFound,
        ).length,
        safeNewProducts: countStatus(
          'SAFE_NEW_PRODUCT',
        ),
        existingSku: countStatus(
          'EXISTING_SKU',
        ),
        eanConflicts: countStatus(
          'EAN_CONFLICT',
        ),
        skuEanConflicts: countStatus(
          'SKU_EAN_CONFLICT',
        ),
        duplicateCatalogSku: countStatus(
          'DUPLICATE_CATALOG_SKU',
        ),
        duplicateCatalogEan: countStatus(
          'DUPLICATE_CATALOG_EAN',
        ),
        missingRequiredData: countStatus(
          'MISSING_REQUIRED_DATA',
        ),
        inventoryMissing: countStatus(
          'INVENTORY_MISSING',
        ),
      }

  return {
    catalogRows,
    items,
    summary,
  }
}

arukeresoApi.get(
  '/catalog/promotion-preview',
  async (context) => {
    try {
      const limitParam = Number(
        context.req.query('limit') ??
          PROMOTION_PREVIEW_LIMIT_DEFAULT,
      )

      const offsetParam = Number(
        context.req.query('offset') ?? 0,
      )

      const limit =
        Number.isFinite(limitParam)
          ? Math.min(
              Math.max(
                Math.trunc(limitParam),
                0,
              ),
              PROMOTION_PREVIEW_LIMIT_MAX,
            )
          : PROMOTION_PREVIEW_LIMIT_DEFAULT

      const offset =
        Number.isFinite(offsetParam)
          ? Math.max(
              Math.trunc(offsetParam),
              0,
            )
          : 0

      const analysis =
        await analyzeCatalogPromotion()

      return context.json({
        status: 'ok',
        summary: analysis.summary,
        pagination: {
          limit,
          offset,
          total: analysis.items.length,
        },
        data: analysis.items.slice(
          offset,
          offset + limit,
        ),
      })
    } catch (error) {
      console.error(
        'Catalog promotion preview failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'CMS katalógus promotion preview sikertelen.',
        },
        500,
      )
    }
  },
)

arukeresoApi.post(
  '/catalog/promote',
  async (context) => {
    try {
      const body =
        (await context.req
          .json()
          .catch(() => null)) as
          | {
              confirm?: unknown
              expectedSafeCount?: unknown
            }
          | null

      if (body?.confirm !== true) {
        return context.json(
          {
            status: 'error',
            message:
              'A termék-promócióhoz explicit confirm=true szükséges.',
          },
          400,
        )
      }

      const analysis =
        await analyzeCatalogPromotion()

      const blockingItems =
        analysis.items.filter(
          (item) =>
            item.promotionStatus !==
            'SAFE_NEW_PRODUCT',
        )

      if (blockingItems.length > 0) {
        return context.json(
          {
            status: 'error',
            message:
              'A katalógus-promóció nem biztonságos: nem minden tétel SAFE_NEW_PRODUCT.',
            summary: analysis.summary,
          },
          409,
        )
      }

      if (
        body.expectedSafeCount !==
          undefined &&
        body.expectedSafeCount !==
          null &&
        body.expectedSafeCount !==
          analysis.summary.safeNewProducts
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'A várt biztonságos tételszám nem egyezik a friss elemzéssel.',
            summary: analysis.summary,
          },
          409,
        )
      }

      const database =
        requireDatabase()

      const now = new Date()

      const catalogById =
        new Map(
          analysis.catalogRows.map(
            (row) => [row.id, row],
          ),
        )

      const productValues: Array<{
        id: string
        sku: string
        name: string
        category: string | null
      }> = []

      const eanValues: Array<{
        productId: string
        type: 'EAN'
        value: string
      }> = []

      const catalogValues: Array<
        typeof catalogSourceItems.$inferInsert
      > = []

      for (const item of analysis.items) {
        const sourceRow =
          catalogById.get(
            item.catalogSourceItemId,
          )

        if (
          !sourceRow ||
          !item.normalizedSku ||
          !item.name?.trim()
        ) {
          throw new Error(
            'A promóciós terv inkonzisztens a friss elemzéssel.',
          )
        }

        const productId = randomUUID()

        productValues.push({
          id: productId,
          sku: item.normalizedSku,
          name: item.name.trim(),
          category:
            sourceRow.category ?? null,
        })

        const eanKey =
          item.eanCode?.trim() || null

        if (eanKey) {
          eanValues.push({
            productId,
            type: 'EAN',
            value: eanKey,
          })
        }

        catalogValues.push({
          ...sourceRow,
          productId,
          matchStatus: 'MATCHED',
          matchError: null,
          updatedAt: now,
        })
      }

      const chunkSize = 200
      const batchQueries = []

      for (
        let offset = 0;
        offset < productValues.length;
        offset += chunkSize
      ) {
        batchQueries.push(
          database
            .insert(products)
            .values(
              productValues.slice(
                offset,
                offset + chunkSize,
              ),
            ),
        )
      }

      for (
        let offset = 0;
        offset < eanValues.length;
        offset += chunkSize
      ) {
        batchQueries.push(
          database
            .insert(productIdentifiers)
            .values(
              eanValues.slice(
                offset,
                offset + chunkSize,
              ),
            ),
        )
      }

      for (
        let offset = 0;
        offset < catalogValues.length;
        offset += chunkSize
      ) {
        batchQueries.push(
          database
            .insert(catalogSourceItems)
            .values(
              catalogValues.slice(
                offset,
                offset + chunkSize,
              ),
            )
            .onConflictDoUpdate({
              target:
                catalogSourceItems.id,
              set: {
                productId:
                  sql`excluded.product_id`,
                matchStatus:
                  sql`excluded.match_status`,
                matchError:
                  sql`excluded.match_error`,
                updatedAt:
                  sql`excluded.updated_at`,
              },
            }),
        )
      }

      await database.batch(
        batchQueries as [
          (typeof batchQueries)[number],
          ...(typeof batchQueries)[number][],
        ],
      )

      return context.json({
        status: 'ok',
        promoted: analysis.items.length,
        productsCreated:
          productValues.length,
        eanIdentifiersCreated:
          eanValues.length,
        catalogItemsLinked:
          catalogValues.length,
      })
    } catch (error) {
      console.error(
        'Catalog promotion failed:',
        error,
      )

      const message =
        error instanceof Error
          ? error.message
          : 'CMS katalógus promóció sikertelen.'

      const isConflict =
        /unique|duplicate|23505/i.test(
          message,
        )

      return context.json(
        {
          status: 'error',
          message,
        },
        isConflict ? 409 : 500,
      )
    }
  },
)

export {
  arukeresoApi,
}
