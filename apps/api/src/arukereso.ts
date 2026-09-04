import {
  catalogSourceItems,
  createDatabase,
  dataConnectionRuns,
  dataConnections,
  inventorySourceItems,
  productIdentifiers,
  products,
} from '@karcher-commerce-hub/database'
import {
  createHash,
  randomUUID,
} from 'node:crypto'
import {
  and,
  eq,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { Hono } from 'hono'

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
