import {
  catalogSourceItems,
  createDatabase,
  dataConnectionRuns,
  dataConnections,
  feedChannels,
  feedProductOverrides,
  feedRunItems,
  feedRuns,
  inventorySourceItems,
  pricingSourceItems,
  productIdentifiers,
  products,
} from '@karcher-commerce-hub/database'
import { getCommerceHubUser } from './access-auth.js'
import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { Hono, type Context } from 'hono'
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
const SNAPSHOT_MIN_RATIO_ENV =
  'ARUKERESO_SNAPSHOT_MIN_RATIO'
const SNAPSHOT_MIN_RATIO_DEFAULT = 0.6
const SNAPSHOT_GUARD_MIN_PREVIOUS_ROWS = 100

class SnapshotSizeRejectedError extends Error {
  readonly code = 'SNAPSHOT_BELOW_MIN_RATIO'

  constructor(
    readonly source: 'CATALOG' | 'PRICING',
    readonly previousRows: number,
    readonly incomingRows: number,
    readonly minRatio: number,
  ) {
    const ratio = incomingRows / previousRows

    super(
      `A(z) ${source} snapshot túl kicsi: előző ${previousRows}, beérkező ${incomingRows}, arány ${ratio.toFixed(3)}, minimum ${minRatio.toFixed(3)}. A jelenlegi snapshot változatlan maradt.`,
    )
    this.name = 'SnapshotSizeRejectedError'
  }
}

class SnapshotSafetyConfigurationError extends Error {
  readonly code =
    'INVALID_SNAPSHOT_SAFETY_CONFIGURATION'

  constructor() {
    super(
      `${SNAPSHOT_MIN_RATIO_ENV} must be greater than 0 and at most 1.`,
    )
    this.name = 'SnapshotSafetyConfigurationError'
  }
}

function getSnapshotMinRatio() {
  const configured =
    process.env[SNAPSHOT_MIN_RATIO_ENV]?.trim()

  if (!configured) {
    return SNAPSHOT_MIN_RATIO_DEFAULT
  }

  const ratio = Number(configured)

  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    ratio > 1
  ) {
    throw new SnapshotSafetyConfigurationError()
  }

  return ratio
}

function assertSnapshotSizeSafety(input: {
  source: 'CATALOG' | 'PRICING'
  previousRows: number
  incomingRows: number
}) {
  const minRatio = getSnapshotMinRatio()

  if (
    input.previousRows >=
      SNAPSHOT_GUARD_MIN_PREVIOUS_ROWS &&
    input.incomingRows / input.previousRows <
      minRatio
  ) {
    console.warn('Arukereso snapshot rejected:', {
      source: input.source,
      previousRows: input.previousRows,
      incomingRows: input.incomingRows,
      minRatio,
    })

    throw new SnapshotSizeRejectedError(
      input.source,
      input.previousRows,
      input.incomingRows,
      minRatio,
    )
  }
}

function snapshotSafetyErrorBody(
  error:
    | SnapshotSizeRejectedError
    | SnapshotSafetyConfigurationError,
) {
  if (error instanceof SnapshotSizeRejectedError) {
    return {
      status: 'error' as const,
      code: error.code,
      message: error.message,
      snapshot: {
        source: error.source,
        previousRows: error.previousRows,
        incomingRows: error.incomingRows,
        ratio:
          error.incomingRows / error.previousRows,
        minRatio: error.minRatio,
      },
    }
  }

  return {
    status: 'error' as const,
    code: error.code,
    message:
      'Az Árukereső snapshot biztonsági beállítása érvénytelen.',
  }
}

function isSnapshotSafetyError(
  error: unknown,
): error is
  | SnapshotSizeRejectedError
  | SnapshotSafetyConfigurationError {
  return (
    error instanceof SnapshotSizeRejectedError ||
    error instanceof SnapshotSafetyConfigurationError
  )
}

function assertArukeresoConfiguration() {
  getSnapshotMinRatio()
}

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

      // A catalog import is a full current snapshot.
      // Reject partial validity so a malformed row
      // cannot be mistaken for a removed product and
      // delete its previously valid current record.
      if (analysis.summary.invalidRows > 0) {
        return context.json(
          {
            status: 'error',
            message:
              'A katalógus import hibás sorokat tartalmaz; a jelenlegi snapshot változatlan maradt.',
            summary: analysis.summary,
            invalidRows: analysis.allItems
              .filter(
                (item) => item.errors.length > 0,
              )
              .slice(0, INVALID_ROWS_LIMIT)
              .map((item) => ({
                rowNumber: item.rowNumber,
                identifier: item.identifier,
                eanCode: item.eanCode,
                name: item.name,
                errors: item.errors,
              })),
          },
          422,
        )
      }

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

      assertSnapshotSizeSafety({
        source: 'CATALOG',
        previousRows: existingItems.length,
        incomingRows: sourceItems.length,
      })

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

      if (isSnapshotSafetyError(error)) {
        return context.json(
          snapshotSafetyErrorBody(error),
          error instanceof SnapshotSizeRejectedError
            ? 409
            : 503,
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
      duplicateSkuRows: 0,
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
        productId: item.productId,
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

  assertSnapshotSizeSafety({
    source: 'PRICING',
    previousRows: existingItems.length,
    incomingRows: sourceItems.length,
  })

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

type UnmatchedPricingPayloadItem = {
  rowIndex: number
  sku: string
  name: string | null
  ean: string | null
  index: number | null
  medianIndex: number | null
  averageIndex: number | null
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  marketStatus: PricingMarketStatus
}

type NormalizePricingPayloadResult =
  | {
      ok: true
      validItems: NormalizedPricingItem[]
      summary: PricingSyncPayloadSummary
      unmatchedSample: string[]
      unmatchedItems: UnmatchedPricingPayloadItem[]
      invalidRows: Array<{
        rowIndex: number
        sku: string
        errors: string[]
      }>
      duplicateRows: Array<{
        rowIndex: number
        sku: string
      }>
    }
  | {
      ok: false
      message: string
      summary: PricingSyncPayloadSummary
      invalidRows: Array<{
        rowIndex: number
        sku: string
        errors: string[]
      }>
      duplicateSkus: string[]
    }

async function normalizePricingPayload(
  body: unknown,
  options?: {
    allowNoMatches?: boolean
    fullDiagnostics?: boolean
  },
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

  const allDuplicateSkus = [...skuOccurrences]
    .filter(([, count]) => count > 1)
    .map(([sku]) => sku)
  const duplicateSkus = options?.fullDiagnostics
    ? allDuplicateSkus
    : allDuplicateSkus.slice(
        0,
        PRICING_SYNC_SAMPLE_LIMIT,
      )

  const duplicateSkuRows = [
    ...skuOccurrences,
  ]
    .filter(([, count]) => count > 1)
    .reduce(
      (total, [, count]) =>
        total + count,
      0,
    )

  if (
    duplicateSkus.length > 0 &&
    !options?.fullDiagnostics
  ) {
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
    rowIndex: number
    sku: string
    errors: string[]
  }> = []

  const unmatchedSample: string[] = []
  const unmatchedItems: UnmatchedPricingPayloadItem[] = []
  const duplicateRows: Array<{
    rowIndex: number
    sku: string
  }> = []
  const duplicateSkuSet = new Set(
    allDuplicateSkus,
  )

  let matchedRows = 0
  let unmatchedRows = 0
  let hasCompetitor = 0
  let noCompetitor = 0
  let partialMarketData = 0

  for (const [rowIndex, row] of items.entries()) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      invalidRows.push({
        rowIndex,
        sku: '',
        errors: ['INVALID_ROW'],
      })
      continue
    }

    const {
      sku: rawSku,
      name: rawName,
      productName: rawProductName,
      ean: rawEan,
      eanCode: rawEanCode,
      index: rawIndex,
      medianIndex: rawMedianIndex,
      averageIndex: rawAverageIndex,
    } = row as {
      sku?: unknown
      name?: unknown
      productName?: unknown
      ean?: unknown
      eanCode?: unknown
      index?: unknown
      medianIndex?: unknown
      averageIndex?: unknown
    }

    if (
      typeof rawSku !== 'string' ||
      !rawSku.trim()
    ) {
      invalidRows.push({
        rowIndex,
        sku:
          typeof rawSku === 'string'
            ? rawSku
            : '',
        errors: ['INVALID_SKU'],
      })
      continue
    }

    const sku = rawSku.trim()

    if (duplicateSkuSet.has(sku)) {
      duplicateRows.push({ rowIndex, sku })
      continue
    }

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
      invalidRows.push({ rowIndex, sku, errors })
      continue
    }

    const marketStatus =
      derivePricingMarketStatus(
        index,
        medianIndex,
        averageIndex,
      )

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

      unmatchedItems.push({
        rowIndex,
        sku,
        name:
          [rawName, rawProductName].find(
            (value): value is string =>
              typeof value === 'string' &&
              Boolean(value.trim()),
          )?.trim() ?? null,
        ean:
          [rawEan, rawEanCode].find(
            (value): value is string =>
              typeof value === 'string' &&
              Boolean(value.trim()),
          )?.trim() ?? null,
        index,
        medianIndex,
        averageIndex,
        priceIndexBps: toPricingBps(index),
        medianIndexBps:
          toPricingBps(medianIndex),
        averageIndexBps:
          toPricingBps(averageIndex),
        marketStatus,
      })

      continue
    }

    if (errors.length > 0) {
      invalidRows.push({ rowIndex, sku, errors })
      continue
    }

    matchedRows += 1

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
      duplicateSkuRows,
      hasCompetitor,
      noCompetitor,
      partialMarketData,
    }

  if (
    invalidRows.length > 0 &&
    !options?.fullDiagnostics
  ) {
    return {
      ok: false,
      message:
        'A szinkron kérés hibás sorokat tartalmaz.',
      summary,
      invalidRows:
        options?.fullDiagnostics
          ? invalidRows
          : invalidRows.slice(
              0,
              PRICING_SYNC_SAMPLE_LIMIT,
            ),
      duplicateSkus: [],
    }
  }

  if (
    validItems.length === 0 &&
    !options?.allowNoMatches
  ) {
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
    unmatchedItems,
    invalidRows,
    duplicateRows,
  }
}

function normalizeSkuForDiagnostic(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

arukeresoApi.post(
  '/pricing/reconcile',
  async (context) => {
    const auth = checkPricingSyncAuth(
      context.req.header('Authorization'),
    )

    if (!auth.ok) {
      return context.json(
        {
          status: 'error',
          message:
            auth.status === 503
              ? 'Az árazási egyeztetés nincs konfigurálva.'
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
      await normalizePricingPayload(body, {
        allowNoMatches: true,
        fullDiagnostics: true,
      })

    if (!normalized.ok) {
      return context.json(
        {
          status: 'error',
          message: normalized.message,
          summary: {
            payloadRows: normalized.summary.rows,
            validRows:
              normalized.summary.rows -
              normalized.summary.invalidMatchedRows,
            duplicateRows:
              normalized.summary.duplicateSkuRows,
            invalidRows:
              normalized.summary.invalidMatchedRows,
            matchedRows:
              normalized.summary.matchedRows,
            unmatchedRows:
              normalized.summary.unmatchedRows,
          },
          invalidRows: normalized.invalidRows.map(
            (row) => ({
              ...row,
              classification:
                row.errors.includes('INVALID_SKU')
                  ? 'G_INVALID_COCKPIT_SKU'
                  : 'H_PAYLOAD_ROW_REJECTED',
            }),
          ),
          duplicateSkus:
            normalized.duplicateSkus.map((sku) => ({
              sku,
              classification:
                'F_DUPLICATE_COCKPIT_SKU',
            })),
        },
        422,
      )
    }

    const database = requireDatabase()
    const resolvedConnection =
      await resolveActivePricingConnection(null)

    if (!resolvedConnection.ok) {
      return context.json(
        {
          status: 'error',
          message: resolvedConnection.message,
        },
        409,
      )
    }

    const [
      hubProducts,
      identifiers,
      catalogConnections,
      storedPricingRows,
    ] = await Promise.all([
      database
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          active: products.active,
        })
        .from(products),
      database
        .select({
          productId:
            productIdentifiers.productId,
          type: productIdentifiers.type,
          value: productIdentifiers.value,
        })
        .from(productIdentifiers),
      database
        .select({ id: dataConnections.id })
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
          ),
        ),
      database
        .select({
          productId: pricingSourceItems.productId,
          sku: pricingSourceItems.sourceItemKey,
          priceIndexBps:
            pricingSourceItems.priceIndexBps,
          medianIndexBps:
            pricingSourceItems.medianIndexBps,
          averageIndexBps:
            pricingSourceItems.averageIndexBps,
          dataStatus: pricingSourceItems.dataStatus,
        })
        .from(pricingSourceItems)
        .where(
          and(
            eq(
              pricingSourceItems.connectionId,
              resolvedConnection.connectionId,
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
        ),
    ])

    if (catalogConnections.length !== 1) {
      return context.json(
        {
          status: 'error',
          message:
            catalogConnections.length === 0
              ? 'Nincs aktív CMS katalógusforrás.'
              : 'Több aktív CMS katalógusforrás található; a diagnosztika nem egyértelmű.',
        },
        409,
      )
    }

    const catalogConnectionIds =
      catalogConnections.map(
        (connection) => connection.id,
      )
    const catalogRows =
      catalogConnectionIds.length > 0
        ? await database
            .select({
              id: catalogSourceItems.id,
              productId:
                catalogSourceItems.productId,
              sourceItemKey:
                catalogSourceItems.sourceItemKey,
              identifier:
                catalogSourceItems.identifier,
              eanCode: catalogSourceItems.eanCode,
              name: catalogSourceItems.name,
              matchStatus:
                catalogSourceItems.matchStatus,
              matchError:
                catalogSourceItems.matchError,
            })
            .from(catalogSourceItems)
            .where(
              inArray(
                catalogSourceItems.connectionId,
                catalogConnectionIds,
              ),
            )
        : []
    const productById = new Map(
      hubProducts.map((product) => [
        product.id,
        product,
      ]),
    )
    const productsByNormalizedSku = new Map<
      string,
      typeof hubProducts
    >()

    for (const product of hubProducts) {
      const key = normalizeSkuForDiagnostic(
        product.sku,
      )
      const candidates =
        productsByNormalizedSku.get(key) ?? []
      candidates.push(product)
      productsByNormalizedSku.set(key, candidates)
    }

    const currentCmsProductIds = new Set(
      catalogRows.flatMap((row) =>
        row.productId ? [row.productId] : [],
      ),
    )
    const storedPricingBySku = new Map(
      storedPricingRows.map((row) => [row.sku, row]),
    )
    const valueMismatches: Array<{
      sku: string
      fields: string[]
      payload: Record<string, number | string | null>
      stored: Record<string, number | string | null>
    }> = []
    const missingStoredMatched: string[] = []
    const alreadyStoredPricingRows =
      normalized.validItems.filter((item) =>
        storedPricingBySku.has(item.sku),
      ).length
    const incomingMatchedSkus = new Set(
      normalized.validItems.map((item) => item.sku),
    )
    // Full snapshot sync also removes stored SKUs absent
    // from the payload, not just submitted unmatched SKUs.
    const storedRowsPendingRemoval = storedPricingRows
      .filter((item) => !incomingMatchedSkus.has(item.sku))
      .map((item) => item.sku)

    for (const item of normalized.validItems) {
      const stored = storedPricingBySku.get(item.sku)

      if (!stored) {
        missingStoredMatched.push(item.sku)
        continue
      }

      const fields = [
        [
          'productAssociation',
          item.productId,
          stored.productId,
        ],
        [
          'priceIndexBps',
          item.priceIndexBps,
          stored.priceIndexBps,
        ],
        [
          'medianIndexBps',
          item.medianIndexBps,
          stored.medianIndexBps,
        ],
        [
          'averageIndexBps',
          item.averageIndexBps,
          stored.averageIndexBps,
        ],
        [
          'marketStatus',
          item.marketStatus,
          stored.dataStatus,
        ],
      ].filter(([, expected, actual]) =>
        expected !== actual,
      )

      if (fields.length > 0) {
        valueMismatches.push({
          sku: item.sku,
          fields: fields.map(([field]) =>
            String(field),
          ),
          payload: {
            priceIndexBps: item.priceIndexBps,
            medianIndexBps:
              item.medianIndexBps,
            averageIndexBps:
              item.averageIndexBps,
            marketStatus: item.marketStatus,
          },
          stored: {
            priceIndexBps: stored.priceIndexBps,
            medianIndexBps:
              stored.medianIndexBps,
            averageIndexBps:
              stored.averageIndexBps,
            marketStatus: stored.dataStatus,
          },
        })
      }
    }

    const classificationCounts: Record<string, number> = {}
    const groupCounts: Record<string, number> = {}
    const unmatched = normalized.unmatchedItems.map(
      (item) => {
        const compactSku =
          normalizeSkuForDiagnostic(item.sku)
        const candidateProducts = new Map<
          string,
          {
            productId: string
            sku: string
            name: string
            active: boolean
            matchMethods: Set<string>
          }
        >()
        const addProductCandidate = (
          productId: string,
          method: string,
        ) => {
          const product = productById.get(productId)

          if (!product) return

          const candidate =
            candidateProducts.get(productId) ?? {
              productId: product.id,
              sku: product.sku,
              name: product.name,
              active: product.active,
              matchMethods: new Set<string>(),
            }
          candidate.matchMethods.add(method)
          candidateProducts.set(productId, candidate)
        }

        for (const product of
          productsByNormalizedSku.get(compactSku) ?? []) {
          addProductCandidate(
            product.id,
            'NORMALIZED_SKU',
          )
        }

        const identifierCandidates = identifiers
          .filter(
            (identifier) =>
              identifier.value === item.sku ||
              (item.ean !== null &&
                identifier.value === item.ean),
          )
          .map((identifier) => {
            addProductCandidate(
              identifier.productId,
              `PRODUCT_IDENTIFIER_${identifier.type}`,
            )
            const product = productById.get(
              identifier.productId,
            )

            return {
              productId: identifier.productId,
              productSku: product?.sku ?? null,
              productName: product?.name ?? null,
              type: identifier.type,
              value: identifier.value,
            }
          })
        const catalogCandidates = catalogRows
          .flatMap((row) => {
            const methods: string[] = []
            const candidateValues = [
              row.sourceItemKey,
              row.identifier,
              row.eanCode,
            ].filter(
              (value): value is string =>
                typeof value === 'string' &&
                Boolean(value),
            )

            if (
              candidateValues.includes(item.sku)
            ) {
              methods.push('CATALOG_EXACT_VALUE')
            }

            if (
              item.ean !== null &&
              row.eanCode === item.ean
            ) {
              methods.push('CATALOG_EAN')
            }

            if (
              candidateValues.some(
                (value) =>
                  normalizeSkuForDiagnostic(value) ===
                  compactSku,
              )
            ) {
              methods.push('CATALOG_NORMALIZED_VALUE')
            }

            if (methods.length === 0) return []

            if (row.productId) {
              addProductCandidate(
                row.productId,
                'CATALOG_LINKED_PRODUCT',
              )
            }

            const product = row.productId
              ? productById.get(row.productId)
              : null

            return [
              {
                catalogSourceItemId: row.id,
                sourceItemKey: row.sourceItemKey,
                identifier: row.identifier,
                normalizedSku:
                  row.identifier
                    ? cmsIdentifierToSku(
                        row.identifier,
                      )
                    : null,
                eanCode: row.eanCode,
                name: row.name,
                productId: row.productId,
                productSku: product?.sku ?? null,
                matchStatus: row.matchStatus,
                matchError: row.matchError,
                matchMethods: methods,
              },
            ]
          })
        const productCandidates = [
          ...candidateProducts.values(),
        ].map((candidate) => ({
          ...candidate,
          matchMethods: [
            ...candidate.matchMethods,
          ].sort(),
        }))
        const hasEanMatch =
          identifierCandidates.some(
            (candidate) => candidate.type === 'EAN',
          ) ||
          catalogCandidates.some((candidate) =>
            candidate.matchMethods.includes(
              'CATALOG_EAN',
            ),
          )
        const cmsMatch =
          catalogCandidates.length > 0 ||
          productCandidates.some((candidate) =>
            currentCmsProductIds.has(
              candidate.productId,
            ),
          )
        const methods = new Set(
          productCandidates.flatMap(
            (candidate) => candidate.matchMethods,
          ),
        )
        let classification: string
        let recommendedAction: string

        if (productCandidates.length > 1) {
          classification =
            'I_AMBIGUOUS_PRODUCT_CANDIDATES'
          recommendedAction =
            'Manuális termékazonosítás szükséges; ne módosíts automatikusan.'
        } else if (productCandidates.length === 1) {
          if (hasEanMatch) {
            classification = 'D_PRODUCT_IDENTIFIED_BY_EAN'
          } else if (methods.has('NORMALIZED_SKU')) {
            classification =
              'C_SKU_NORMALIZATION_MISMATCH'
          } else if (
            [...methods].some((method) =>
              method.startsWith(
                'PRODUCT_IDENTIFIER_',
              ),
            )
          ) {
            classification =
              'E_PRODUCT_IDENTIFIER_ALIAS'
          } else {
            classification = 'B_HUB_SKU_DIFFERS'
          }
          recommendedAction = cmsMatch
            ? `A Cockpit SKU-t igazítsd a kanonikus Hub/CMS SKU-hoz: ${productCandidates[0]?.sku}.`
            : 'A Hub-termék létezik, de nincs aktuális CMS-sor; feedhez CMS-forrás szükséges.'
        } else if (catalogCandidates.length > 0) {
          classification = 'A_HUB_PRODUCT_MISSING'
          recommendedAction =
            'A CMS-sor alapján csak ütközésmentes promotion/linking ellenőrzés után javítható.'
        } else {
          classification = 'I_NO_AUTHORITATIVE_MATCH'
          recommendedAction =
            'Nincs Hub/CMS/EAN/alias bizonyíték; manuális forrásellenőrzés szükséges.'
        }

        const group = cmsMatch
          ? productCandidates.length > 0
            ? 'GROUP_3_CMS_AND_HUB_MAPPING_BUG'
            : 'GROUP_1_CMS_EXISTS_HUB_MISSING'
          : productCandidates.length > 0
            ? 'GROUP_2_HUB_EXISTS_CMS_MISSING'
            : 'GROUP_4_NO_HUB_OR_CMS'

        classificationCounts[classification] =
          (classificationCounts[classification] ?? 0) + 1
        groupCounts[group] =
          (groupCounts[group] ?? 0) + 1
        const catalogNormalizedSkus = [
          ...new Set(
            catalogCandidates.flatMap((candidate) => [
              candidate.productSku,
              candidate.normalizedSku,
            ]).filter(
              (value): value is string =>
                typeof value === 'string',
            ),
          ),
        ]
        const supportedNormalizedSku =
          productCandidates.length === 1
            ? productCandidates[0]?.sku ?? null
            : catalogNormalizedSkus.length === 1
              ? catalogNormalizedSkus[0] ?? null
              : null

        return {
          rowIndex: item.rowIndex,
          sku: item.sku,
          normalizedSku: supportedNormalizedSku,
          name:
            item.name ??
            productCandidates[0]?.name ??
            catalogCandidates[0]?.name ??
            null,
          ean: item.ean,
          index: item.index,
          medianIndex: item.medianIndex,
          averageIndex: item.averageIndex,
          priceIndexBps: item.priceIndexBps,
          medianIndexBps: item.medianIndexBps,
          averageIndexBps: item.averageIndexBps,
          marketStatus: item.marketStatus,
          hubMatch: false,
          cmsMatch,
          eanMatch: hasEanMatch,
          classification,
          group,
          rootCause: classification,
          recommendedAction,
          productCandidates:
            productCandidates.map((candidate) => ({
              sku: candidate.sku,
              name: candidate.name,
              active: candidate.active,
              matchMethods: candidate.matchMethods,
            })),
          identifierCandidates:
            identifierCandidates.map((candidate) => ({
              productSku: candidate.productSku,
              productName: candidate.productName,
              type: candidate.type,
            })),
          catalogCandidates:
            catalogCandidates.map((candidate) => ({
              normalizedSku:
                candidate.productSku ??
                candidate.normalizedSku,
              name: candidate.name,
              linkedToHub:
                candidate.productId !== null,
              matchStatus: candidate.matchStatus,
              matchMethods: candidate.matchMethods,
            })),
          resolved: false,
        }
      },
    )
    const allValidItems = [
      ...normalized.validItems.map((item) => ({
        marketStatus: item.marketStatus,
      })),
      ...normalized.unmatchedItems,
    ]
    const statusCounts = {
      hasCompetitor: allValidItems.filter(
        (item) =>
          item.marketStatus === 'HAS_COMPETITOR',
      ).length,
      noCompetitor: allValidItems.filter(
        (item) =>
          item.marketStatus === 'NO_COMPETITOR',
      ).length,
      partialMarketData: allValidItems.filter(
        (item) =>
          item.marketStatus ===
          'PARTIAL_MARKET_DATA',
        ).length,
    }
    for (const row of normalized.invalidRows) {
      const classification = row.errors.includes(
        'INVALID_SKU',
      )
        ? 'G_INVALID_COCKPIT_SKU'
        : 'H_PAYLOAD_ROW_REJECTED'
      classificationCounts[classification] =
        (classificationCounts[classification] ?? 0) + 1
    }

    if (normalized.duplicateRows.length > 0) {
      classificationCounts[
        'F_DUPLICATE_COCKPIT_SKU'
      ] = normalized.duplicateRows.length
    }

    const missingStoredPricingRows =
      [...normalized.validItems, ...normalized.unmatchedItems]
        .filter((item) => !storedPricingBySku.has(item.sku))
        .length

    return context.json({
      status: 'ok',
      readOnly: true,
      summary: {
        payloadRows: normalized.summary.rows,
        validRows:
          normalized.validItems.length +
          normalized.unmatchedItems.length,
        duplicateRows:
          normalized.duplicateRows.length,
        invalidRows:
          normalized.invalidRows.length,
        matchedRows: normalized.summary.matchedRows,
        unmatchedRows:
          normalized.summary.unmatchedRows,
        alreadyStoredPricingRows,
        missingStoredPricingRows,
        valueMismatchRows: valueMismatches.length,
        ...statusCounts,
      },
      classificationCounts,
      groupCounts,
      unmatched,
      invalidRows: normalized.invalidRows.map(
        (row) => ({
          ...row,
          classification:
            row.errors.includes('INVALID_SKU')
              ? 'G_INVALID_COCKPIT_SKU'
              : 'H_PAYLOAD_ROW_REJECTED',
        }),
      ),
      duplicateRows: normalized.duplicateRows.map(
        (row) => ({
          ...row,
          classification:
            'F_DUPLICATE_COCKPIT_SKU',
        }),
      ),
      missingStoredMatched,
      storedRowsPendingRemoval,
      valueMismatches,
    })
  },
)

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
        if (isSnapshotSafetyError(error)) {
          return context.json(
            snapshotSafetyErrorBody(error),
            error instanceof SnapshotSizeRejectedError
              ? 409
              : 503,
          )
        }

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
      if (isSnapshotSafetyError(error)) {
        return context.json(
          snapshotSafetyErrorBody(error),
          error instanceof SnapshotSizeRejectedError
            ? 409
            : 503,
        )
      }

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

    console.log(
      'Pricing sync completed:',
      resolvedConnection.connectionId,
      `${snapshot.importedRows} rows,`,
      `${snapshot.inserted} inserted,`,
      `${snapshot.updated} updated,`,
      `${snapshot.staleRemoved} removed.`,
    )

    // Automatic feed regeneration runs only after the
    // pricing snapshot is fully committed, uses the
    // exact same generation path as manual runs, and
    // never replaces the previous public feed on
    // failure. Disabled unless explicitly enabled.
    let feedGeneration:
      | {
          status: 'ok'
          runId: string
          sourceRows: number
          outputRows: number
          activeRows: number
          disabledRows: number
        }
      | {
          status: 'skipped'
          code: 'CHANNEL_INACTIVE'
          message: string
        }
      | { status: 'error'; message: string }
      | undefined

    if (
      process.env
        .ARUKERESO_AUTO_GENERATE_ENABLED === 'true'
    ) {
      console.log(
        'Automatic feed generation started after pricing sync.',
      )

      try {
        const generationResponse =
          await arukeresoApi.request(
            '/feed/generate',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                confirm: true,
                triggerType: 'PRICING_SYNC',
              }),
            },
          )
        const generated =
          (await generationResponse.json()) as {
            status?: string
            code?: string
            runId?: string
            summary?: {
              sourceRows: number
              outputRows: number
              activeRows: number
              disabledRows: number
            }
            message?: string
          }

        if (
          generationResponse.ok &&
          generated.status === 'skipped' &&
          generated.code === 'CHANNEL_INACTIVE'
        ) {
          feedGeneration = {
            status: 'skipped',
            code: 'CHANNEL_INACTIVE',
            message:
              generated.message ??
              'Automatic feed generation skipped because the channel is inactive.',
          }
          console.log(
            'Automatic feed generation skipped: channel is inactive.',
          )
        } else if (
          !generationResponse.ok ||
          !generated.runId ||
          !generated.summary
        ) {
          throw new Error(
            generated.message ??
              'Automatic feed generation failed.',
          )
        } else {
          feedGeneration = {
            status: 'ok',
            runId: generated.runId,
            sourceRows:
              generated.summary.sourceRows,
            outputRows:
              generated.summary.outputRows,
            activeRows:
              generated.summary.activeRows,
            disabledRows:
              generated.summary.disabledRows,
          }

          console.log(
            'Automatic feed generation completed:',
            generated.runId,
            `${generated.summary.activeRows} active,`,
            `${generated.summary.disabledRows} disabled.`,
          )
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Automatic feed generation failed.'

        console.error(
          'Automatic feed generation failed after pricing sync:',
          message,
        )

        feedGeneration = {
          status: 'error',
          message,
        }
      }
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

      unmatchedSample:
        normalized.unmatchedSample,

      ...(feedGeneration
        ? { feedGeneration }
        : {}),
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

function createFeedFingerprint(value: string) {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
}

function toCatalogFeedOutputRow(
  item: CatalogFeedOutputItem,
  forceDisabled = false,
): CatalogFeedOutputRow {
  return {
    ...item.source,
    DeliveryTime:
      forceDisabled || !item.result.included
        ? 'NO'
        : item.source.DeliveryTime,
    ProductNumber: item.sku,
  }
}

function createCatalogFeedCsv(
  items: CatalogFeedOutputItem[],
  forceDisabled = false,
) {
  return serializeCatalogFeedCsv(
    items.map((item) =>
      toCatalogFeedOutputRow(item, forceDisabled),
    ),
  )
}

function assertCatalogFeedOutputUniqueness(
  items: CatalogFeedOutputItem[],
) {
  const identifiers = new Set<string>()
  const productNumbers = new Set<string>()

  for (const item of items) {
    if (identifiers.has(item.source.Identifier)) {
      throw new FeedOutputError(
        `Duplikált feed Identifier: ${item.source.Identifier}.`,
        'DUPLICATE_FEED_IDENTIFIER',
      )
    }

    if (productNumbers.has(item.sku)) {
      throw new FeedOutputError(
        `Duplikált feed ProductNumber: ${item.sku}.`,
        'DUPLICATE_FEED_PRODUCT_NUMBER',
      )
    }

    identifiers.add(item.source.Identifier)
    productNumbers.add(item.sku)
  }
}

function isCatalogFeedItemInV4(
  item: CatalogFeedOutputItem,
) {
  return (
    item.pricingRow !== null ||
    item.inclusionMode === 'FORCE_INCLUDE'
  )
}

function toFeedOutputSample(
  item: CatalogFeedOutputItem,
) {
  return {
    productId: item.productId,
    sku: item.sku,
    identifier: item.source.Identifier,
    name: item.source.Name,
    inFeed: isCatalogFeedItemInV4(item),
    included: item.result.included,
    inclusionMode: item.inclusionMode,
    reasonCode: item.result.reasonCode,
    reasonDetails: item.result.reasonDetails,
    priceKitStatus:
      item.result.reasonDetails.priceKitStatus,
    priceIndexBps:
      item.result.reasonDetails.priceIndexBps,
    medianIndexBps:
      item.result.reasonDetails.medianIndexBps,
    averageIndexBps:
      item.result.reasonDetails.averageIndexBps,
    stockQuantity: item.stockQuantity,
    stockStatus: item.stockStatus,
    productNumber: item.sku,
    outputDeliveryTime: isCatalogFeedItemInV4(item)
      ? item.result.included
        ? item.source.DeliveryTime
        : 'NO'
      : null,
  }
}

function matchesFeedReasonCategory(
  reasonCode: FeedEligibilityReasonCode,
  category: string | null,
) {
  const categories: Record<string, string[]> = {
    INDEX: [
      'FEED_BLOCKED_MIN_INDEX',
      'FEED_BLOCKED_MEDIAN_INDEX',
      'FEED_BLOCKED_AVERAGE_INDEX',
      'FEED_BLOCKED_MISSING_MIN_INDEX',
      'FEED_BLOCKED_MISSING_MEDIAN_INDEX',
      'FEED_BLOCKED_MISSING_AVERAGE_INDEX',
    ],
    STOCK: [
      'FEED_BLOCKED_OUT_OF_STOCK',
      'FEED_BLOCKED_MISSING_STOCK',
    ],
    NO_PRICEKIT: [
      'FEED_ELIGIBLE_NO_CURRENT_PRICEKIT',
      'FEED_BLOCKED_NO_CURRENT_PRICEKIT',
    ],
    NO_COMPETITOR: [
      'FEED_ELIGIBLE_NO_COMPETITOR',
      'FEED_BLOCKED_NO_COMPETITOR',
    ],
    MANUAL: [
      'FEED_ELIGIBLE_MANUAL_OVERRIDE',
      'FEED_BLOCKED_MANUAL_OVERRIDE',
    ],
  }

  return (
    category === null ||
    (categories[category]?.includes(reasonCode) ??
      true)
  )
}

arukeresoApi.get(
  '/feed/output-preview',
  async (context) => {
    try {
      const requestedLimit = Number(
        context.req.query('limit') ??
          FEED_OUTPUT_SAMPLE_DEFAULT,
      )
      const limit = Number.isFinite(
        requestedLimit,
      )
        ? Math.min(
            Math.max(
              Math.trunc(requestedLimit),
              0,
            ),
            FEED_OUTPUT_SAMPLE_MAX,
          )
        : FEED_OUTPUT_SAMPLE_DEFAULT
      const requestedOffset = Number(
        context.req.query('offset') ?? 0,
      )
      const offset = Number.isFinite(
        requestedOffset,
      )
        ? Math.max(
            Math.trunc(requestedOffset),
            0,
          )
        : 0
      const search =
        context.req
          .query('search')
          ?.trim()
          .toLowerCase() || null
      const included =
        context.req.query('included')
      const feedState =
        context.req.query('feedState')
      const priceKitStatus =
        context.req.query('priceKitStatus')
      const stockStatus =
        context.req.query('stockStatus')
      const reasonCategory =
        context.req.query('reasonCategory') ?? null
      const output =
        await buildCatalogFeedOutput()
      const filteredItems = output.items.filter(
        (item) => {
          if (
            search !== null &&
            !item.sku
              .toLowerCase()
              .includes(search) &&
            !item.source.Name.toLowerCase().includes(
              search,
            )
          ) {
            return false
          }

          if (
            included === 'true' &&
            !item.result.included
          ) {
            return false
          }

          if (
            included === 'false' &&
            item.result.included
          ) {
            return false
          }

          const inFeed =
            isCatalogFeedItemInV4(item)

          if (
            (feedState === 'IN_FEED' && !inFeed) ||
            (feedState === 'ACTIVE' &&
              (!inFeed || !item.result.included)) ||
            (feedState === 'DISABLED' &&
              (!inFeed || item.result.included)) ||
            (feedState === 'OMITTED' && inFeed)
          ) {
            return false
          }

          if (
            priceKitStatus &&
            (priceKitStatus === 'HAS_DATA'
              ? item.pricingRow === null
              : priceKitStatus === 'HAS_COMPETITOR'
                ? item.result.reasonDetails
                    .priceKitStatus !== 'HAS_DATA'
                : item.result.reasonDetails
                    .priceKitStatus !== priceKitStatus)
          ) {
            return false
          }

          if (
            stockStatus &&
            item.stockStatus !== stockStatus
          ) {
            return false
          }

          return matchesFeedReasonCategory(
            item.result.reasonCode,
            reasonCategory,
          )
        },
      )

      return context.json({
        status: 'ok',
        channel: FEED_CHANNEL_CODE,
        isActive: output.channel.isActive,
        summary: output.summary,
        reasonCounts: output.reasonCounts,
        settings: output.settings,
        appliedDefaults:
          output.appliedDefaults,
        safety: output.safety,
        ordering:
          'Identifier ascending; sourceItemKey, SKU and catalog row ID are stable fallbacks.',
        pagination: {
          limit,
          offset,
          total: filteredItems.length,
        },
        sample: filteredItems
          .slice(offset, offset + limit)
          .map(toFeedOutputSample),
      })
    } catch (error) {
      console.error(
        'Feed output preview failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          code:
            error instanceof FeedOutputError
              ? error.code
              : 'FEED_OUTPUT_PREVIEW_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Feed output preview failed.',
        },
        error instanceof FeedOutputError
          ? 422
          : 500,
      )
    }
  },
)

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

const FEED_CHANNEL_CODE = 'ARUKERESO_HU'
const FEED_PREVIEW_LIMIT_DEFAULT = 100
const FEED_PREVIEW_LIMIT_MAX = 500

type FeedEligibilitySettings = {
  useMinIndex: boolean
  maxMinIndexBps: number
  useMedianIndex: boolean
  maxMedianIndexBps: number
  useAverageIndex: boolean
  maxAverageIndexBps: number
  useStockRule: boolean
  allowNoCompetitor: boolean
  allowMissingPricingData: boolean
  /** Legacy, ignored by eligibility. */
  maxPricingAgeHours: number
  ruleVersion: number
}

const FEED_ELIGIBILITY_DEFAULT_SETTINGS: FeedEligibilitySettings =
  {
    useMinIndex: true,
    maxMinIndexBps: 11000,
    useMedianIndex: false,
    maxMedianIndexBps: 11000,
    useAverageIndex: false,
    maxAverageIndexBps: 11000,
    useStockRule: false,
    allowNoCompetitor: false,
    allowMissingPricingData: false,
    maxPricingAgeHours: 48,
    ruleVersion: 1,
  }

function resolveFeedEligibilitySettings(
  settingsJson: string | null,
): {
  settings: FeedEligibilitySettings
  appliedDefaults: string[]
} {
  let parsed: unknown = null

  try {
    parsed =
      settingsJson !== null
        ? JSON.parse(settingsJson)
        : null
  } catch {
    parsed = null
  }

  const source =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}

  const appliedDefaults: string[] = []

  const pickPositiveInteger = (
    key: keyof FeedEligibilitySettings,
    fallback: number,
  ) => {
    const value = source[key]

    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0
    ) {
      return value
    }

    appliedDefaults.push(key)
    return fallback
  }

  const legacyMaxPriceIndexBps =
    source['maxPriceIndexBps']

  const maxMinIndexFallback =
    typeof legacyMaxPriceIndexBps ===
      'number' &&
    Number.isInteger(
      legacyMaxPriceIndexBps,
    ) &&
    legacyMaxPriceIndexBps > 0
      ? legacyMaxPriceIndexBps
      : FEED_ELIGIBILITY_DEFAULT_SETTINGS.maxMinIndexBps

  const pickBoolean = (
    key: keyof FeedEligibilitySettings,
    fallback: boolean,
  ) => {
    const value = source[key]

    if (typeof value === 'boolean') {
      return value
    }

    appliedDefaults.push(key)
    return fallback
  }

  return {
    settings: {
      useMinIndex: pickBoolean(
        'useMinIndex',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.useMinIndex,
      ),
      maxMinIndexBps: pickPositiveInteger(
        'maxMinIndexBps',
        maxMinIndexFallback,
      ),
      useMedianIndex: pickBoolean(
        'useMedianIndex',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.useMedianIndex,
      ),
      maxMedianIndexBps: pickPositiveInteger(
        'maxMedianIndexBps',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.maxMedianIndexBps,
      ),
      useAverageIndex: pickBoolean(
        'useAverageIndex',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.useAverageIndex,
      ),
      maxAverageIndexBps: pickPositiveInteger(
        'maxAverageIndexBps',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.maxAverageIndexBps,
      ),
      useStockRule: pickBoolean(
        'useStockRule',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.useStockRule,
      ),
      allowNoCompetitor: pickBoolean(
        'allowNoCompetitor',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.allowNoCompetitor,
      ),
      allowMissingPricingData:
        pickBoolean(
          'allowMissingPricingData',
          FEED_ELIGIBILITY_DEFAULT_SETTINGS.allowMissingPricingData,
        ),
      maxPricingAgeHours: pickPositiveInteger(
        'maxPricingAgeHours',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.maxPricingAgeHours,
      ),
      ruleVersion: pickPositiveInteger(
        'ruleVersion',
        FEED_ELIGIBILITY_DEFAULT_SETTINGS.ruleVersion,
      ),
    },
    appliedDefaults,
  }
}

type FeedEligibilityReasonCode =
  | 'FEED_ELIGIBLE_PRICING_RULES'
  | 'FEED_BLOCKED_MIN_INDEX'
  | 'FEED_BLOCKED_MEDIAN_INDEX'
  | 'FEED_BLOCKED_AVERAGE_INDEX'
  | 'FEED_BLOCKED_MISSING_MIN_INDEX'
  | 'FEED_BLOCKED_MISSING_MEDIAN_INDEX'
  | 'FEED_BLOCKED_MISSING_AVERAGE_INDEX'
  | 'FEED_BLOCKED_OUT_OF_STOCK'
  | 'FEED_BLOCKED_MISSING_STOCK'
  | 'FEED_ELIGIBLE_NO_COMPETITOR'
  | 'FEED_BLOCKED_NO_COMPETITOR'
  | 'FEED_ELIGIBLE_MANUAL_OVERRIDE'
  | 'FEED_BLOCKED_MANUAL_OVERRIDE'
  | 'FEED_ELIGIBLE_NO_CURRENT_PRICEKIT'
  | 'FEED_BLOCKED_NO_CURRENT_PRICEKIT'
  | 'FEED_BLOCKED_PARTIAL_MARKET_DATA'

type FeedEligibilityOverride =
  | 'INHERIT'
  | 'FORCE_INCLUDE'
  | 'FORCE_EXCLUDE'

type FeedPricingRowInput = {
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  dataStatus: string | null
  observedAt: Date | null
} | null

type PriceKitStatus =
  | 'HAS_DATA'
  | 'NO_DATA'
  | 'NO_COMPETITOR'
  | 'PARTIAL_DATA'

function resolvePriceKitStatus(input: {
  pricingRow: FeedPricingRowInput
  pricingAgeHours?: number | null
  maxPricingAgeHours?: number
}): PriceKitStatus {
  // Currency comes from daily snapshot membership:
  // applyPricingSnapshot deletes rows that are absent
  // from the latest Cockpit sync, so an existing row is
  // current PriceKit data regardless of observedAt.
  // The age arguments are accepted but ignored for
  // backward compatibility with existing callers.
  if (input.pricingRow === null) {
    return 'NO_DATA'
  }

  if (
    input.pricingRow.dataStatus ===
    'NO_COMPETITOR'
  ) {
    return 'NO_COMPETITOR'
  }

  return input.pricingRow.dataStatus ===
    'HAS_COMPETITOR'
    ? 'HAS_DATA'
    : 'PARTIAL_DATA'
}

type FeedEligibilityReasonDetails = {
  inclusionMode: FeedEligibilityOverride
  ruleVersion: number
  useMinIndex: boolean
  maxMinIndexBps: number
  priceIndexBps: number | null
  useMedianIndex: boolean
  maxMedianIndexBps: number
  medianIndexBps: number | null
  useAverageIndex: boolean
  maxAverageIndexBps: number
  averageIndexBps: number | null
  useStockRule: boolean
  stockQuantity: number | null
  stockAvailable: boolean | null
  dataStatus: string | null
  observedAt: string | null
  pricingAgeHours: number | null
  priceKitStatus: PriceKitStatus
}

function evaluateFeedEligibility(input: {
  pricingRow: FeedPricingRowInput
  stockQuantity: number | null
  override: FeedEligibilityOverride | null
  settings: FeedEligibilitySettings
  now: Date
}): {
  included: boolean
  decision: 'INCLUDED' | 'EXCLUDED'
  reasonCode: FeedEligibilityReasonCode
  reasonDetails: FeedEligibilityReasonDetails
} {
  const { settings } = input
  const inclusionMode =
    input.override ?? 'INHERIT'
  const pricingRow = input.pricingRow

  const observedAtIso =
    pricingRow?.observedAt instanceof
    Date
      ? pricingRow.observedAt.toISOString()
      : null

  const pricingAgeHours =
    pricingRow?.observedAt instanceof
    Date
      ? Math.round(
          ((input.now.getTime() -
            pricingRow.observedAt.getTime()) /
            3600000) *
            10,
        ) / 10
      : null

  const priceKitStatus = resolvePriceKitStatus({
    pricingRow,
  })

  const reasonDetails: FeedEligibilityReasonDetails =
    {
      inclusionMode,
      ruleVersion: settings.ruleVersion,
      useMinIndex: settings.useMinIndex,
      maxMinIndexBps:
        settings.maxMinIndexBps,
      priceIndexBps:
        pricingRow?.priceIndexBps ?? null,
      useMedianIndex:
        settings.useMedianIndex,
      maxMedianIndexBps:
        settings.maxMedianIndexBps,
      medianIndexBps:
        pricingRow?.medianIndexBps ?? null,
      useAverageIndex:
        settings.useAverageIndex,
      maxAverageIndexBps:
        settings.maxAverageIndexBps,
      averageIndexBps:
        pricingRow?.averageIndexBps ?? null,
      useStockRule: settings.useStockRule,
      stockQuantity: input.stockQuantity,
      stockAvailable:
        input.stockQuantity === null
          ? null
          : input.stockQuantity > 0,
      dataStatus:
        pricingRow?.dataStatus ?? null,
      observedAt: observedAtIso,
      pricingAgeHours,
      priceKitStatus,
    }

  if (
    inclusionMode === 'FORCE_EXCLUDE'
  ) {
    return {
      included: false,
      decision: 'EXCLUDED',
      reasonCode:
        'FEED_BLOCKED_MANUAL_OVERRIDE',
      reasonDetails,
    }
  }

  if (
    inclusionMode === 'FORCE_INCLUDE'
  ) {
    // Absolute manual include: bypasses the current
    // PriceKit requirement, all index rules, the
    // no-competitor rule and the stock rule.
    // "Mindig feedben" truly means always active.
    return {
      included: true,
      decision: 'INCLUDED',
      reasonCode:
        'FEED_ELIGIBLE_MANUAL_OVERRIDE',
      reasonDetails,
    }
  }

  let successReasonCode: FeedEligibilityReasonCode =
    'FEED_ELIGIBLE_PRICING_RULES'

  if (pricingRow === null) {
    // V4 feed membership is PriceKit-based. Products
    // without a current row stay outside the normal
    // feed unless FORCE_INCLUDE handled them above.
    return {
      included: false,
      decision: 'EXCLUDED',
      reasonCode:
        'FEED_BLOCKED_NO_CURRENT_PRICEKIT',
      reasonDetails,
    }
  }

  if (
    pricingRow !== null &&
    successReasonCode ===
      'FEED_ELIGIBLE_PRICING_RULES' &&
    pricingRow.dataStatus ===
      'NO_COMPETITOR'
  ) {
    if (!settings.allowNoCompetitor) {
      return {
        included: false,
        decision: 'EXCLUDED',
        reasonCode:
          'FEED_BLOCKED_NO_COMPETITOR',
        reasonDetails,
      }
    }

    successReasonCode =
      'FEED_ELIGIBLE_NO_COMPETITOR'
  }

  if (
    pricingRow !== null &&
    successReasonCode ===
      'FEED_ELIGIBLE_PRICING_RULES' &&
    pricingRow.dataStatus ===
      'HAS_COMPETITOR'
  ) {
    const enabledRules = [
      {
        enabled: settings.useMinIndex,
        value: pricingRow.priceIndexBps,
        maximum: settings.maxMinIndexBps,
        missingReason:
          'FEED_BLOCKED_MISSING_MIN_INDEX' as const,
        blockedReason:
          'FEED_BLOCKED_MIN_INDEX' as const,
      },
      {
        enabled: settings.useMedianIndex,
        value: pricingRow.medianIndexBps,
        maximum:
          settings.maxMedianIndexBps,
        missingReason:
          'FEED_BLOCKED_MISSING_MEDIAN_INDEX' as const,
        blockedReason:
          'FEED_BLOCKED_MEDIAN_INDEX' as const,
      },
      {
        enabled: settings.useAverageIndex,
        value: pricingRow.averageIndexBps,
        maximum:
          settings.maxAverageIndexBps,
        missingReason:
          'FEED_BLOCKED_MISSING_AVERAGE_INDEX' as const,
        blockedReason:
          'FEED_BLOCKED_AVERAGE_INDEX' as const,
      },
    ]

    for (const rule of enabledRules) {
      if (!rule.enabled) {
        continue
      }

      if (
        typeof rule.value !== 'number' ||
        !Number.isFinite(rule.value)
      ) {
        return {
          included: false,
          decision: 'EXCLUDED',
          reasonCode: rule.missingReason,
          reasonDetails,
        }
      }

      if (rule.value > rule.maximum) {
        return {
          included: false,
          decision: 'EXCLUDED',
          reasonCode: rule.blockedReason,
          reasonDetails,
        }
      }
    }
  } else if (
    pricingRow !== null &&
    successReasonCode ===
      'FEED_ELIGIBLE_PRICING_RULES' &&
    pricingRow.dataStatus !==
      'NO_COMPETITOR' &&
    pricingRow.dataStatus !==
      'HAS_COMPETITOR'
  ) {
    return {
      included: false,
      decision: 'EXCLUDED',
      reasonCode:
        'FEED_BLOCKED_PARTIAL_MARKET_DATA',
      reasonDetails,
    }
  }

  if (settings.useStockRule) {
    if (input.stockQuantity === null) {
      return {
        included: false,
        decision: 'EXCLUDED',
        reasonCode:
          'FEED_BLOCKED_MISSING_STOCK',
        reasonDetails,
      }
    }

    if (input.stockQuantity <= 0) {
      return {
        included: false,
        decision: 'EXCLUDED',
        reasonCode:
          'FEED_BLOCKED_OUT_OF_STOCK',
        reasonDetails,
      }
    }
  }

  return {
    included: true,
    decision: 'INCLUDED',
    reasonCode: successReasonCode,
    reasonDetails,
  }
}

const FEED_GENERATOR_VERSION_V2 =
  'ARUKERESO_FULL_CMS_CSV_V2'
const FEED_GENERATOR_VERSION_V3 =
  'ARUKERESO_FILTERED_CMS_CSV_V3'
const FEED_GENERATOR_VERSION =
  'ARUKERESO_PRICEKIT_BASE_CSV_V4'
const FEED_OUTPUT_FILE_NAME =
  'arukereso-feed.csv'
const FEED_OUTPUT_SAMPLE_DEFAULT = 20
const FEED_OUTPUT_SAMPLE_MAX = 100
const FEED_MIN_INCLUDED_ITEMS_DEFAULT = 1

type CatalogFeedSourceRow = Record<
  CatalogHeader,
  string
>

type CatalogFeedOutputItem = {
  catalogSourceItemId: string
  sourceItemKey: string
  sourceFingerprint: string | null
  productId: string
  sku: string
  identifier: string | null
  eanCode: string | null
  name: string | null
  priceMinor: number | null
  netPriceMinor: number | null
  deliveryCostMinor: number | null
  deliveryTimeDays: number | null
  source: CatalogFeedSourceRow
  pricingRow: FeedPricingRowInput
  stockQuantity: number | null
  inclusionMode: FeedEligibilityOverride
  result: ReturnType<
    typeof evaluateFeedEligibility
  >
  stockStatus:
    | 'IN_STOCK'
    | 'OUT_OF_STOCK'
    | 'MISSING_STOCK'
}

class FeedOutputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'FeedOutputError'
  }
}

function parseCatalogFeedSourceRow(
  rawDataJson: string | null,
  catalogSourceItemId: string,
): CatalogFeedSourceRow {
  let parsed: unknown

  try {
    parsed =
      rawDataJson === null
        ? null
        : JSON.parse(rawDataJson)
  } catch {
    throw new FeedOutputError(
      `A katalógussor raw_data_json mezője nem értelmezhető: ${catalogSourceItemId}.`,
      'INVALID_RAW_DATA_JSON',
    )
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new FeedOutputError(
      `A katalógussor raw_data_json mezője nem objektum: ${catalogSourceItemId}.`,
      'INVALID_RAW_DATA_JSON',
    )
  }

  const source = parsed as Record<
    string,
    unknown
  >
  const result = {} as CatalogFeedSourceRow

  for (const header of EXPECTED_CATALOG_HEADERS) {
    if (typeof source[header] !== 'string') {
      throw new FeedOutputError(
        `A katalógussorból hiányzik a(z) ${header} forrásmező: ${catalogSourceItemId}.`,
        'MISSING_RAW_SOURCE_FIELD',
      )
    }

    result[header] = source[header]
  }

  return result
}

function escapeFeedCsvCell(value: string) {
  return /[;"\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

/**
 * Final Árukereső output field order. The official
 * field documentation does not mandate a strict
 * column order, so the confirmed ProductNumber is
 * appended after the 13 original CMS source fields
 * to minimize disruption. Identifier keeps the
 * original CMS value; ProductNumber carries the Hub
 * SKU, which is the official Kärcher manufacturer
 * product number (e.g. Identifier 10040620 ->
 * ProductNumber 1.004-062.0).
 */
const FEED_OUTPUT_HEADERS = [
  ...EXPECTED_CATALOG_HEADERS,
  'ProductNumber',
] as const

type FeedOutputHeader =
  (typeof FEED_OUTPUT_HEADERS)[number]

type CatalogFeedOutputRow = Record<
  FeedOutputHeader,
  string
>

function serializeCatalogFeedCsv(
  rows: CatalogFeedOutputRow[],
) {
  const lines = [FEED_OUTPUT_HEADERS.join(';')]

  for (const row of rows) {
    lines.push(
      FEED_OUTPUT_HEADERS.map(
        (header) =>
          escapeFeedCsvCell(row[header]),
      ).join(';'),
    )
  }

  return `${lines.join('\r\n')}\r\n`
}

function parseCatalogFeedOutputRow(
  value: unknown,
  rowLabel: string,
): CatalogFeedOutputRow {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new FeedOutputError(
      `A feed-sor nem értelmezhető: ${rowLabel}.`,
      'INVALID_RESOLVED_FEED_ITEM',
    )
  }

  const source = value as Record<string, unknown>
  const result = {} as CatalogFeedOutputRow

  for (const header of FEED_OUTPUT_HEADERS) {
    if (typeof source[header] !== 'string') {
      throw new FeedOutputError(
        `A feed-sorból hiányzik a(z) ${header} mező: ${rowLabel}.`,
        'MISSING_FEED_OUTPUT_FIELD',
      )
    }

    result[header] = source[header]
  }

  return result
}

function resolveFeedGenerationSafety(
  settingsJson: string | null,
) {
  const stored =
    readStoredFeedSettings(settingsJson)
  // V4 safety protects the normal output population.
  // Rule failures only change DeliveryTime and are not
  // source-snapshot truncation.
  const configured =
    stored['minActiveItems'] ??
    stored['minIncludedItems']

  const minimum =
    typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured >= 1
      ? configured
      : FEED_MIN_INCLUDED_ITEMS_DEFAULT

  return {
    minActiveItems: minimum,
    minIncludedItems: minimum,
  }
}

function assertFeedOutputSafety(
  outputRows: number,
  minOutputRows: number,
) {
  if (outputRows < minOutputRows) {
    throw new FeedOutputError(
      `A generálás leállt: ${outputRows} feed-sor nem éri el a minimális ${minOutputRows} értéket.`,
      'MIN_INCLUDED_ITEMS_NOT_MET',
    )
  }
}

type FeedOutputContext = {
  database: ReturnType<typeof requireDatabase>
  channel: NonNullable<
    Awaited<
      ReturnType<typeof resolveFeedChannel>
    >['channel']
  >
}

async function buildCatalogFeedOutput(
  context?: FeedOutputContext,
) {
  const resolved =
    context ?? (await resolveFeedChannel())

  if (!resolved.channel) {
    throw new FeedOutputError(
      'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
      'FEED_CHANNEL_NOT_FOUND',
    )
  }

  const { database, channel } = resolved
  const { settings, appliedDefaults } =
    resolveFeedEligibilitySettings(
      channel.settingsJson,
    )

  const [
    catalogConnections,
    pricingConnections,
    inventoryConnections,
    overrides,
  ] = await Promise.all([
    database
      .select({
        id: dataConnections.id,
        updatedAt: dataConnections.updatedAt,
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
        ),
      ),
    database
      .select({
        id: dataConnections.id,
        updatedAt: dataConnections.updatedAt,
      })
      .from(dataConnections)
      .where(
        and(
          eq(
            dataConnections.purpose,
            'PRICING',
          ),
          eq(dataConnections.isActive, true),
        ),
      ),
    database
      .select({
        id: dataConnections.id,
        updatedAt: dataConnections.updatedAt,
      })
      .from(dataConnections)
      .where(
        and(
          eq(
            dataConnections.purpose,
            'INVENTORY',
          ),
          eq(dataConnections.isActive, true),
        ),
      )
      .limit(1),
    database
      .select({
        productId:
          feedProductOverrides.productId,
        inclusionMode:
          feedProductOverrides.inclusionMode,
        updatedAt:
          feedProductOverrides.updatedAt,
      })
      .from(feedProductOverrides)
      .where(
        eq(
          feedProductOverrides.channelId,
          channel.id,
        ),
      ),
  ])

  if (catalogConnections.length !== 1) {
    throw new FeedOutputError(
      catalogConnections.length === 0
        ? 'Nincs aktív CSV katalóguskapcsolat.'
        : 'Több aktív CSV katalóguskapcsolat található; a forrás nem egyértelmű.',
      'CATALOG_CONNECTION_NOT_UNIQUE',
    )
  }

  const catalogConnection =
    catalogConnections[0]

  if (!catalogConnection) {
    throw new FeedOutputError(
      'Nincs aktív CSV katalóguskapcsolat.',
      'CATALOG_CONNECTION_NOT_FOUND',
    )
  }

  const pricingConnectionIds =
    pricingConnections.map(
      (connection) => connection.id,
    )
  const activeInventoryConnection =
    inventoryConnections[0] ?? null

  const [
    catalogRows,
    pricingRows,
    inventoryRows,
  ] = await Promise.all([
    database
      .select({
        id: catalogSourceItems.id,
        productId: catalogSourceItems.productId,
        sourceItemKey:
          catalogSourceItems.sourceItemKey,
        identifier:
          catalogSourceItems.identifier,
        eanCode: catalogSourceItems.eanCode,
        name: catalogSourceItems.name,
        priceMinor:
          catalogSourceItems.priceMinor,
        netPriceMinor:
          catalogSourceItems.netPriceMinor,
        deliveryCostMinor:
          catalogSourceItems.deliveryCostMinor,
        deliveryTimeDays:
          catalogSourceItems.deliveryTimeDays,
        sourceFingerprint:
          catalogSourceItems.sourceFingerprint,
        rawDataJson:
          catalogSourceItems.rawDataJson,
        lastImportRunId:
          catalogSourceItems.lastImportRunId,
        matchStatus:
          catalogSourceItems.matchStatus,
        sku: products.sku,
      })
      .from(catalogSourceItems)
      .leftJoin(
        products,
        eq(
          products.id,
          catalogSourceItems.productId,
        ),
      )
      .where(
        eq(
          catalogSourceItems.connectionId,
          catalogConnection.id,
        ),
      ),
    pricingConnectionIds.length > 0
      ? database
          .select({
            productId:
              pricingSourceItems.productId,
            priceIndexBps:
              pricingSourceItems.priceIndexBps,
            medianIndexBps:
              pricingSourceItems.medianIndexBps,
            averageIndexBps:
              pricingSourceItems.averageIndexBps,
            dataStatus:
              pricingSourceItems.dataStatus,
            observedAt:
              pricingSourceItems.observedAt,
          })
          .from(pricingSourceItems)
          .where(
            and(
              inArray(
                pricingSourceItems.connectionId,
                pricingConnectionIds,
              ),
              eq(
                pricingSourceItems.marketCode,
                'HU',
              ),
              eq(
                pricingSourceItems.currency,
                'HUF',
              ),
            ),
          )
      : [],
    activeInventoryConnection
      ? database
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
      : [],
  ])

  if (catalogRows.length === 0) {
    throw new FeedOutputError(
      'Az aktív katalógusforrás nem tartalmaz feed-sorokat.',
      'EMPTY_CATALOG_SOURCE',
    )
  }

  const pricingByProduct = new Map<
    string,
    NonNullable<FeedPricingRowInput>
  >()

  for (const row of pricingRows) {
    if (row.productId === null) {
      continue
    }

    const current = pricingByProduct.get(
      row.productId,
    )

    if (
      !current ||
      (row.observedAt instanceof Date &&
        (!(current.observedAt instanceof Date) ||
          row.observedAt.getTime() >
            current.observedAt.getTime()))
    ) {
      pricingByProduct.set(row.productId, {
        priceIndexBps: row.priceIndexBps,
        medianIndexBps: row.medianIndexBps,
        averageIndexBps: row.averageIndexBps,
        dataStatus: row.dataStatus,
        observedAt: row.observedAt,
      })
    }
  }

  const inventoryStockBySku = new Map(
    inventoryRows.map((row) => [
      row.sku,
      row.stock,
    ]),
  )
  const overrideByProduct = new Map(
    overrides.map((row) => [
      row.productId,
      row.inclusionMode,
    ]),
  )
  const seenProductIds = new Set<string>()
  const now = new Date()
  const items: CatalogFeedOutputItem[] = []

  for (const row of catalogRows) {
    if (
      row.matchStatus !== 'MATCHED' ||
      row.productId === null ||
      row.sku === null
    ) {
      continue
    }

    if (seenProductIds.has(row.productId)) {
      throw new FeedOutputError(
        `Több katalógussor kapcsolódik ugyanahhoz a termékhez: ${row.productId}.`,
        'DUPLICATE_CATALOG_PRODUCT',
      )
    }

    seenProductIds.add(row.productId)

    const source = parseCatalogFeedSourceRow(
      row.rawDataJson,
      row.id,
    )
    const pricingRow =
      pricingByProduct.get(row.productId) ?? null
    const stockQuantity =
      inventoryStockBySku.get(row.sku) ?? null
    const inclusionMode =
      overrideByProduct.get(row.productId) ??
      'INHERIT'
    const result = evaluateFeedEligibility({
      pricingRow,
      stockQuantity,
      override: inclusionMode,
      settings,
      now,
    })

    items.push({
      catalogSourceItemId: row.id,
      sourceItemKey: row.sourceItemKey,
      sourceFingerprint: row.sourceFingerprint,
      productId: row.productId,
      sku: row.sku,
      identifier: row.identifier,
      eanCode: row.eanCode,
      name: row.name,
      priceMinor: row.priceMinor,
      netPriceMinor: row.netPriceMinor,
      deliveryCostMinor:
        row.deliveryCostMinor,
      deliveryTimeDays:
        row.deliveryTimeDays,
      source,
      pricingRow,
      stockQuantity,
      inclusionMode,
      result,
      stockStatus:
        stockQuantity === null
          ? 'MISSING_STOCK'
          : stockQuantity > 0
            ? 'IN_STOCK'
            : 'OUT_OF_STOCK',
    })
  }

  if (items.length === 0) {
    throw new FeedOutputError(
      'Az aktív katalógusforrás nem tartalmaz termékhez kapcsolt sorokat.',
      'NO_MATCHED_CATALOG_ROWS',
    )
  }

  items.sort((left, right) => {
    const leftKey =
      left.source.Identifier ||
      left.sourceItemKey ||
      left.sku
    const rightKey =
      right.source.Identifier ||
      right.sourceItemKey ||
      right.sku

    if (leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1
    }

    return left.catalogSourceItemId <
      right.catalogSourceItemId
      ? -1
      : 1
  })

  const summary = {
    sourceRows: catalogRows.length,
    matchedRows: items.length,
    unmatchedRows:
      catalogRows.length - items.length,
    // Preview evaluates every matched CMS row. V4
    // membership and offer availability are separate.
    priceKitBaseRows: 0,
    manuallyAddedRows: 0,
    outputRows: 0,
    activeRows: 0,
    disabledRows: 0,
    omittedRows: 0,
    includedRows: 0,
    excludedRows: 0,
    forceIncluded: 0,
    forceExcluded: 0,
    ruleBasedIncluded: 0,
    ruleBasedExcluded: 0,
    priceKitWithData: 0,
    priceKitWithoutData: 0,
    blockedByStock: 0,
    blockedByIndex: 0,
    missingEnabledMetric: 0,
  }
  const reasonCounts: Record<string, number> = {}

  for (const item of items) {
    const inFeed = isCatalogFeedItemInV4(item)

    if (item.pricingRow !== null) {
      summary.priceKitBaseRows += 1
    }

    if (
      item.pricingRow === null &&
      item.inclusionMode === 'FORCE_INCLUDE'
    ) {
      summary.manuallyAddedRows += 1
    }

    if (inFeed) {
      summary.outputRows += 1

      if (item.result.included) {
        summary.activeRows += 1
        summary.includedRows += 1
      } else {
        summary.disabledRows += 1
        summary.excludedRows += 1
      }
    } else {
      summary.omittedRows += 1
    }

    if (item.pricingRow === null) {
      summary.priceKitWithoutData += 1
    } else {
      summary.priceKitWithData += 1
    }

    if (item.inclusionMode === 'FORCE_INCLUDE') {
      summary.forceIncluded += 1
    } else if (
      item.inclusionMode === 'FORCE_EXCLUDE'
    ) {
      summary.forceExcluded += 1
    } else if (item.result.included) {
      summary.ruleBasedIncluded += 1
    } else {
      summary.ruleBasedExcluded += 1
    }

    reasonCounts[item.result.reasonCode] =
      (reasonCounts[item.result.reasonCode] ?? 0) +
      1

    if (
      item.result.reasonCode ===
        'FEED_BLOCKED_OUT_OF_STOCK' ||
      item.result.reasonCode ===
        'FEED_BLOCKED_MISSING_STOCK'
    ) {
      summary.blockedByStock += 1
    }

    if (
      item.result.reasonCode ===
        'FEED_BLOCKED_MIN_INDEX' ||
      item.result.reasonCode ===
        'FEED_BLOCKED_MEDIAN_INDEX' ||
      item.result.reasonCode ===
        'FEED_BLOCKED_AVERAGE_INDEX'
    ) {
      summary.blockedByIndex += 1
    }

    if (
      item.result.reasonCode ===
        'FEED_BLOCKED_MISSING_MIN_INDEX' ||
      item.result.reasonCode ===
        'FEED_BLOCKED_MISSING_MEDIAN_INDEX' ||
      item.result.reasonCode ===
        'FEED_BLOCKED_MISSING_AVERAGE_INDEX'
    ) {
      summary.missingEnabledMetric += 1
    }
  }

  const outputItems = items.filter(
    isCatalogFeedItemInV4,
  )

  return {
    database,
    channel,
    settings,
    appliedDefaults,
    safety: resolveFeedGenerationSafety(
      channel.settingsJson,
    ),
    sourceSnapshot: {
      catalogConnectionId: catalogConnection.id,
      catalogImportRunIds: Array.from(
        new Set(
          catalogRows
            .map((row) => row.lastImportRunId)
            .filter(
              (value): value is string =>
                value !== null,
            ),
        ),
      ).sort(),
      pricingConnectionIds:
        pricingConnectionIds.slice().sort(),
      inventoryConnectionId:
        activeInventoryConnection?.id ?? null,
      connectionRevisions: [
        catalogConnection,
        ...pricingConnections,
        ...(activeInventoryConnection
          ? [activeInventoryConnection]
          : []),
      ].map((connection) => ({
        id: connection.id,
        updatedAt: connection.updatedAt,
      })),
      overrideRevisions: overrides.map(
        (override) => ({
          productId: override.productId,
          updatedAt: override.updatedAt,
        }),
      ),
      sourceRows: catalogRows.length,
      matchedRows: items.length,
    },
    items,
    outputItems,
    summary,
    reasonCounts,
  }
}

type FeedGenerationTrigger =
  | 'MANUAL'
  | 'PRICING_SYNC'
  | 'CHANNEL_ACTIVATION'

async function generateCatalogFeedRun(input: {
  database: ReturnType<typeof requireDatabase>
  channel: FeedOutputContext['channel']
  triggerType: FeedGenerationTrigger
  activateChannel?: boolean
}) {
  const { database, channel } = input
  const resolvedSettings =
    resolveFeedEligibilitySettings(
      channel.settingsJson,
    )
  const safety = resolveFeedGenerationSafety(
    channel.settingsJson,
  )
  const channelSnapshot = {
    id: channel.id,
    code: channel.code,
    targetCountry: channel.targetCountry,
    contentLanguage: channel.contentLanguage,
    currency: channel.currency,
    format: channel.format,
  }
  const [run] = await database
    .insert(feedRuns)
    .values({
      channelId: channel.id,
      triggerType: input.triggerType,
      status: 'RUNNING',
      generatorVersion: FEED_GENERATOR_VERSION,
      ruleVersion: String(
        resolvedSettings.settings.ruleVersion,
      ),
      channelSnapshotJson:
        JSON.stringify(channelSnapshot),
      sourceSnapshotJson: JSON.stringify({
        status: 'RESOLVING',
      }),
      ruleSnapshotJson: JSON.stringify({
        feedModel: FEED_GENERATOR_VERSION,
        settings: resolvedSettings.settings,
        appliedDefaults:
          resolvedSettings.appliedDefaults,
        safety,
      }),
      startedAt: new Date(),
    })
    .returning({ id: feedRuns.id })

  if (!run) {
    throw new FeedOutputError(
      'A feed generálási futás nem hozható létre.',
      'FEED_RUN_CREATE_FAILED',
    )
  }

  let output: Awaited<
    ReturnType<typeof buildCatalogFeedOutput>
  > | null = null

  try {
    output = await buildCatalogFeedOutput({
      database,
      channel,
    })

    assertFeedOutputSafety(
      output.summary.outputRows,
      output.safety.minIncludedItems,
    )
    assertCatalogFeedOutputUniqueness(
      output.outputItems,
    )

    const csv = createCatalogFeedCsv(
      output.outputItems,
    )
    const artifactFingerprint =
      createFeedFingerprint(csv)
    const inputFingerprint =
      createFeedFingerprint(
        JSON.stringify(
          output.items.map((item) => ({
            catalogSourceItemId:
              item.catalogSourceItemId,
            sourceFingerprint:
              item.sourceFingerprint,
            productId: item.productId,
            pricingRow: item.pricingRow,
            stockQuantity: item.stockQuantity,
            inclusionMode: item.inclusionMode,
            inFeed:
              isCatalogFeedItemInV4(item),
            decision: item.result.decision,
            reasonCode: item.result.reasonCode,
          })),
        ),
      )
    const insertItemQueries = []

    for (
      let offset = 0;
      offset < output.outputItems.length;
      offset += 200
    ) {
      const chunk = output.outputItems
        .slice(offset, offset + 200)
        .map((item, chunkIndex) => {
          const resolvedItem = {
            catalogSourceItemId:
              item.catalogSourceItemId,
            output: toCatalogFeedOutputRow(item),
          }

          return {
            runId: run.id,
            productId: item.productId,
            itemIndex: offset + chunkIndex,
            externalItemId:
              `catalog:${item.catalogSourceItemId}`,
            sku: item.sku,
            identifier: item.identifier,
            eanCode: item.eanCode,
            name: item.name,
            decision: item.result.decision,
            reasonCodesJson: JSON.stringify([
              item.result.reasonCode,
            ]),
            stock: item.stockQuantity,
            priceMinor: item.priceMinor,
            netPriceMinor: item.netPriceMinor,
            deliveryCostMinor:
              item.deliveryCostMinor,
            deliveryTimeDays:
              item.deliveryTimeDays,
            currency: channel.currency,
            manualOverrideApplied:
              item.inclusionMode !== 'INHERIT',
            inputSnapshotJson: JSON.stringify({
              catalogSourceItemId:
                item.catalogSourceItemId,
              sourceFingerprint:
                item.sourceFingerprint,
              pricingRow: item.pricingRow,
              stockQuantity: item.stockQuantity,
            }),
            overrideSnapshotJson:
              item.inclusionMode === 'INHERIT'
                ? null
                : JSON.stringify({
                    inclusionMode:
                      item.inclusionMode,
                  }),
            decisionDetailsJson:
              JSON.stringify(
                item.result.reasonDetails,
              ),
            resolvedItemJson:
              JSON.stringify(resolvedItem),
            payloadFingerprint:
              createFeedFingerprint(
                JSON.stringify(resolvedItem),
              ),
          }
        })

      insertItemQueries.push(
        database
          .insert(feedRunItems)
          .values(chunk),
      )
    }

    const completeRun = database
      .update(feedRuns)
      .set({
        status: 'COMPLETED',
        itemsEvaluated:
          output.summary.matchedRows,
        itemsIncluded:
          output.summary.activeRows,
        itemsExcluded:
          output.summary.disabledRows,
        inputFingerprint,
        outputFingerprint: artifactFingerprint,
        sourceSnapshotJson: JSON.stringify({
          ...output.sourceSnapshot,
          priceKitBaseRows:
            output.summary.priceKitBaseRows,
          manuallyAddedRows:
            output.summary.manuallyAddedRows,
          outputRows: output.summary.outputRows,
          omittedRows: output.summary.omittedRows,
        }),
        ruleSnapshotJson: JSON.stringify({
          feedModel: FEED_GENERATOR_VERSION,
          settings: output.settings,
          appliedDefaults:
            output.appliedDefaults,
          safety: output.safety,
        }),
        artifactFileName: FEED_OUTPUT_FILE_NAME,
        artifactContentType:
          'text/csv; charset=utf-8',
        artifactFingerprint,
        finishedAt: new Date(),
      })
      .where(eq(feedRuns.id, run.id))
    const channelUpdateConditions = [
      eq(feedChannels.id, channel.id),
    ]

    if (input.activateChannel) {
      channelUpdateConditions.push(
        eq(feedChannels.isActive, false),
        eq(
          feedChannels.updatedAt,
          channel.updatedAt,
        ),
        sql<boolean>`(
          select count(*)
          from ${dataConnections}
          where ${dataConnections.sourceType} = 'CSV_UPLOAD'
            and ${dataConnections.purpose} = 'CATALOG'
            and ${dataConnections.isActive} = true
        ) = 1`,
        sql<boolean>`(
          select count(*)
          from ${dataConnections}
          where ${dataConnections.purpose} = 'PRICING'
            and ${dataConnections.isActive} = true
        ) = ${output.sourceSnapshot.pricingConnectionIds.length}`,
        sql<boolean>`(
          select count(*)
          from ${dataConnections}
          where ${dataConnections.purpose} = 'INVENTORY'
            and ${dataConnections.isActive} = true
        ) = ${
          output.sourceSnapshot.inventoryConnectionId
            ? 1
            : 0
        }`,
        sql<boolean>`(
          select count(*)
          from ${feedProductOverrides}
          where ${feedProductOverrides.channelId} = ${channel.id}
        ) = ${output.sourceSnapshot.overrideRevisions.length}`,
      )

      for (const revision of output.sourceSnapshot
        .connectionRevisions) {
        channelUpdateConditions.push(
          sql<boolean>`exists (
            select 1
            from ${dataConnections}
            where ${dataConnections.id} = ${revision.id}
              and ${dataConnections.updatedAt} = ${revision.updatedAt}
          )`,
        )
      }

      for (const revision of output.sourceSnapshot
        .overrideRevisions) {
        channelUpdateConditions.push(
          sql<boolean>`exists (
            select 1
            from ${feedProductOverrides}
            where ${feedProductOverrides.channelId} = ${channel.id}
              and ${feedProductOverrides.productId} = ${revision.productId}
              and ${feedProductOverrides.updatedAt} = ${revision.updatedAt}
          )`,
        )
      }
    }

    const markChannelSuccessful = database
      .update(feedChannels)
      .set({
        lastSuccessfulAt: new Date(),
        lastError: null,
        ...(input.activateChannel
          ? {
              isActive: true,
              settingsJson: channel.settingsJson,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(...channelUpdateConditions))
      .returning({ id: feedChannels.id })
    const batchQueries = [
      ...insertItemQueries,
      completeRun,
      markChannelSuccessful,
    ]

    const batchResults = await database.batch(
      batchQueries as [
        (typeof batchQueries)[number],
        ...(typeof batchQueries)[number][],
      ],
    )

    if (input.activateChannel) {
      const channelUpdateResult = batchResults[
        batchResults.length - 1
      ] as Array<{ id: string }>

      if (channelUpdateResult.length === 0) {
        throw new FeedOutputError(
          'Az aktiválás közben a forrás vagy a beállítás megváltozott. A csatorna kikapcsolva maradt; próbáld újra.',
          'CHANNEL_ACTIVATION_SOURCE_CHANGED',
        )
      }
    }

    return {
      runId: run.id,
      summary: output.summary,
      reasonCounts: output.reasonCounts,
      artifact: {
        fileName: FEED_OUTPUT_FILE_NAME,
        contentType: 'text/csv; charset=utf-8',
        fingerprint: artifactFingerprint,
        downloadPath:
          `/arukereso/feed/runs/${run.id}/csv`,
      },
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Feed generation failed.'

    await database
      .update(feedRuns)
      .set({
        status: 'FAILED',
        itemsEvaluated:
          output?.summary.matchedRows ?? 0,
        itemsIncluded:
          output?.summary.activeRows ?? 0,
        itemsExcluded:
          output?.summary.disabledRows ?? 0,
        sourceSnapshotJson: JSON.stringify(
          output?.sourceSnapshot ?? {
            status: 'LOAD_FAILED',
          },
        ),
        error:
          error instanceof FeedOutputError
            ? `[${error.code}] ${message}`
            : message,
        finishedAt: new Date(),
      })
      .where(eq(feedRuns.id, run.id))

    console.error('Feed generation failed:', error)
    const generationError =
      error instanceof Error
        ? error
        : new Error(message)

    Object.assign(generationError, {
      feedRunId: run.id,
    })
    throw generationError
  }
}

arukeresoApi.post(
  '/feed/generate',
  async (context) => {
    let body: unknown

    try {
      body = await context.req.json()
    } catch {
      body = null
    }

    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body as Record<string, unknown>)['confirm'] !== true
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'A feed generálásához confirm=true szükséges.',
        },
        400,
      )
    }

    const { database, channel } =
      await resolveFeedChannel()

    if (!channel) {
      return context.json(
        {
          status: 'error',
          code: 'FEED_CHANNEL_NOT_FOUND',
          message:
            'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
        },
        409,
      )
    }

    if (!channel.isActive) {
      return context.json({
        status: 'skipped',
        code: 'CHANNEL_INACTIVE',
        message:
          'Az Árukereső feed csatorna ki van kapcsolva. Generálás nem történt.',
      })
    }

    const requestedTriggerType = (
      body as Record<string, unknown>
    )['triggerType']
    const triggerType =
      requestedTriggerType === 'PRICING_SYNC'
        ? 'PRICING_SYNC'
        : 'MANUAL'

    try {
      const generated =
        await generateCatalogFeedRun({
          database,
          channel,
          triggerType,
        })

      return context.json({
        status: 'ok',
        channel: FEED_CHANNEL_CODE,
        ...generated,
      })
    } catch (error) {
      const feedRunId =
        error instanceof Error &&
        'feedRunId' in error &&
        typeof error.feedRunId === 'string'
          ? error.feedRunId
          : null

      return context.json(
        {
          status: 'error',
          ...(feedRunId
            ? { runId: feedRunId }
            : {}),
          code:
            error instanceof FeedOutputError
              ? error.code
              : 'FEED_GENERATION_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Feed generation failed.',
        },
        error instanceof FeedOutputError
          ? 422
          : 500,
      )
    }
  },
)

async function buildFeedRunCsv(runId: string) {
  const { database, channel } =
    await resolveFeedChannel()

  if (!channel) {
    throw new FeedOutputError(
      'Az Árukereső feed csatorna nincs konfigurálva.',
      'FEED_CHANNEL_NOT_FOUND',
    )
  }

  const [run] = await database
    .select({
      id: feedRuns.id,
      status: feedRuns.status,
      itemsEvaluated: feedRuns.itemsEvaluated,
      itemsIncluded: feedRuns.itemsIncluded,
      itemsExcluded: feedRuns.itemsExcluded,
      artifactFileName:
        feedRuns.artifactFileName,
      artifactFingerprint:
        feedRuns.artifactFingerprint,
      generatorVersion:
        feedRuns.generatorVersion,
    })
    .from(feedRuns)
    .where(
      and(
        eq(feedRuns.id, runId),
        eq(feedRuns.channelId, channel.id),
      ),
    )
    .limit(1)

  if (!run) {
    throw new FeedOutputError(
      'A feed futás nem található.',
      'FEED_RUN_NOT_FOUND',
    )
  }

  if (run.status !== 'COMPLETED') {
    throw new FeedOutputError(
      'Csak sikeresen befejezett feed tölthető le.',
      'FEED_RUN_NOT_COMPLETED',
    )
  }

  if (
    run.generatorVersion !==
      FEED_GENERATOR_VERSION_V2 &&
    run.generatorVersion !==
      FEED_GENERATOR_VERSION_V3 &&
    run.generatorVersion !== FEED_GENERATOR_VERSION
  ) {
    throw new FeedOutputError(
      'A feed futás nem ezzel a generátorverzióval készült.',
      'UNSUPPORTED_FEED_GENERATOR_VERSION',
    )
  }

  const runItems = await database
    .select({
      decision: feedRunItems.decision,
      resolvedItemJson:
        feedRunItems.resolvedItemJson,
    })
    .from(feedRunItems)
    .where(eq(feedRunItems.runId, run.id))
    .orderBy(asc(feedRunItems.itemIndex))

  const expectedRunItemCount =
    run.generatorVersion ===
    FEED_GENERATOR_VERSION_V2
      ? run.itemsEvaluated
      : run.generatorVersion ===
          FEED_GENERATOR_VERSION_V3
        ? run.itemsIncluded
        : run.itemsIncluded + run.itemsExcluded

  if (runItems.length !== expectedRunItemCount) {
    throw new FeedOutputError(
      'A feed futás elemszáma nem egyezik a naplózott értékkel.',
      'FEED_RUN_ITEM_COUNT_MISMATCH',
    )
  }

  if (
    run.generatorVersion ===
      FEED_GENERATOR_VERSION_V3 &&
    runItems.some(
      (item) => item.decision !== 'INCLUDED',
    )
  ) {
    throw new FeedOutputError(
      'A V3 feed futás kizárt elemet tartalmaz.',
      'INVALID_V3_RUN_ITEM_DECISION',
    )
  }

  const rows = runItems.map((item, index) => {
    let resolved: unknown

    try {
      resolved =
        item.resolvedItemJson === null
          ? null
          : JSON.parse(item.resolvedItemJson)
    } catch {
      resolved = null
    }

    if (
      resolved === null ||
      typeof resolved !== 'object' ||
      Array.isArray(resolved)
    ) {
      throw new FeedOutputError(
        `A feed futás ${index + 1}. elemének tartalma sérült.`,
        'INVALID_RESOLVED_FEED_ITEM',
      )
    }

    if (run.generatorVersion === FEED_GENERATOR_VERSION) {
      const entry = resolved as { output?: unknown }

      return parseCatalogFeedOutputRow(
        entry.output,
        `${run.id}:${index}`,
      )
    }

    if (!('source' in resolved)) {
      throw new FeedOutputError(
        `A feed futás ${index + 1}. elemének tartalma sérült.`,
        'INVALID_RESOLVED_FEED_ITEM',
      )
    }

    const entry = resolved as {
      source: unknown
      outputDeliveryTime?: unknown
      productNumber?: unknown
    }

    const sourceRow = parseCatalogFeedSourceRow(
      JSON.stringify(entry.source),
      `${run.id}:${index}`,
    )

    if (
      typeof entry.outputDeliveryTime !==
        'string' ||
      typeof entry.productNumber !== 'string'
    ) {
      throw new FeedOutputError(
        `A feed futás ${index + 1}. elemének tartalma sérült.`,
        'INVALID_RESOLVED_FEED_ITEM',
      )
    }

    return {
      ...sourceRow,
      DeliveryTime: entry.outputDeliveryTime,
      ProductNumber: entry.productNumber,
    }
  })
  const csv = serializeCatalogFeedCsv(rows)
  const fingerprint =
    createFeedFingerprint(csv)

  if (
    run.artifactFingerprint === null ||
    run.artifactFingerprint !== fingerprint
  ) {
    throw new FeedOutputError(
      'A regenerált feed ujjlenyomata nem egyezik a futás rekordjával.',
      'FEED_ARTIFACT_FINGERPRINT_MISMATCH',
    )
  }

  return {
    csv,
    fileName:
      run.artifactFileName ??
      FEED_OUTPUT_FILE_NAME,
  }
}

function feedCsvResponse(input: {
  csv: string
  fileName: string
}) {
  return new Response(input.csv, {
    headers: {
      'Content-Type':
        'text/csv; charset=utf-8',
      'Content-Disposition':
        `attachment; filename="${input.fileName}"`,
      'Cache-Control': 'no-store',
    },
  })
}

async function feedDownloadErrorResponse(
  context: Context,
  action: () => Promise<{
    csv: string
    fileName: string
  }>,
) {
  try {
    return feedCsvResponse(await action())
  } catch (error) {
    return context.json(
      {
        status: 'error',
        code:
          error instanceof FeedOutputError
            ? error.code
            : 'FEED_DOWNLOAD_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'Feed download failed.',
      },
      error instanceof FeedOutputError
        ? 422
        : 500,
    )
  }
}

arukeresoApi.get(
  '/feed/runs/:runId/csv',
  async (context) => {
    const runId = context.req.param('runId')

    if (!isUuid(runId)) {
      return context.json(
        {
          status: 'error',
          message: 'Érvénytelen runId.',
        },
        400,
      )
    }

    return feedDownloadErrorResponse(
      context,
      () => buildFeedRunCsv(runId),
    )
  },
)

arukeresoApi.get(
  '/feed/latest',
  async (context) => {
    try {
      const { database, channel } =
        await resolveFeedChannel()

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva.',
          },
          409,
        )
      }

      const latestRun =
        await findLatestCompletedNormalFeedRun(
          database,
          channel.id,
        )

      return context.json({
        status: 'ok',
        latestRun,
      })
    } catch (error) {
      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'A legutóbbi feed betöltése sikertelen.',
        },
        500,
      )
    }
  },
)

async function findLatestCompletedNormalFeedRun(
  database: ReturnType<typeof requireDatabase>,
  channelId: string,
) {
  const findVersion = async (generatorVersion: string) => {
    const [run] = await database
      .select({
        runId: feedRuns.id,
        status: feedRuns.status,
        includedRows: feedRuns.itemsIncluded,
        excludedRows: feedRuns.itemsExcluded,
        finishedAt: feedRuns.finishedAt,
        artifactFingerprint:
          feedRuns.artifactFingerprint,
        generatorVersion:
          feedRuns.generatorVersion,
      })
      .from(feedRuns)
      .where(
        and(
          eq(feedRuns.channelId, channelId),
          eq(feedRuns.status, 'COMPLETED'),
          eq(
            feedRuns.generatorVersion,
            generatorVersion,
          ),
        ),
      )
      .orderBy(desc(feedRuns.startedAt))
      .limit(1)

    return run ?? null
  }

  const v4 = await findVersion(
    FEED_GENERATOR_VERSION,
  )

  if (v4) {
    return {
      ...v4,
      outputRows:
        v4.includedRows + v4.excludedRows,
    }
  }

  const v3 = await findVersion(
    FEED_GENERATOR_VERSION_V3,
  )

  return v3
    ? {
        ...v3,
        outputRows: v3.includedRows,
      }
    : null
}

async function findLatestCompletedFeedRunId(
  database: ReturnType<typeof requireDatabase>,
  channelId: string,
): Promise<string | null> {
  const latestRun =
    await findLatestCompletedNormalFeedRun(
      database,
      channelId,
    )

  return latestRun?.runId ?? null
}

async function findLatestCompletedFeedRunIdByVersion(
  database: ReturnType<typeof requireDatabase>,
  channelId: string,
  generatorVersion: string,
) {
  const [run] = await database
    .select({ id: feedRuns.id })
    .from(feedRuns)
    .where(
      and(
        eq(feedRuns.channelId, channelId),
        eq(feedRuns.status, 'COMPLETED'),
        eq(
          feedRuns.generatorVersion,
          generatorVersion,
        ),
      ),
    )
    .orderBy(desc(feedRuns.startedAt))
    .limit(1)

  return run?.id ?? null
}

function parseDisabledCatalogFeedRows(csv: string) {
  const parsed = parseSemicolonCsv(csv)
  const headers = parsed[0]

  if (
    !headers ||
    headers.length !== FEED_OUTPUT_HEADERS.length ||
    headers.some(
      (header, index) =>
        header !== FEED_OUTPUT_HEADERS[index],
    )
  ) {
    throw new FeedOutputError(
      'A leállító feed tartalék forrásának sémája nem kompatibilis.',
      'SHUTDOWN_FALLBACK_SCHEMA_MISMATCH',
    )
  }

  const rows = parsed.slice(1).map((values, rowIndex) => {
    if (values.length !== FEED_OUTPUT_HEADERS.length) {
      throw new FeedOutputError(
        `A leállító feed tartalék forrásának ${rowIndex + 1}. sora sérült.`,
        'SHUTDOWN_FALLBACK_ROW_INVALID',
      )
    }

    const row = {} as CatalogFeedOutputRow

    for (
      let index = 0;
      index < FEED_OUTPUT_HEADERS.length;
      index += 1
    ) {
      const header = FEED_OUTPUT_HEADERS[index]
      const value = values[index]

      if (!header || value === undefined) {
        throw new FeedOutputError(
          `A leállító feed tartalék forrásának ${rowIndex + 1}. sora sérült.`,
          'SHUTDOWN_FALLBACK_ROW_INVALID',
        )
      }

      row[header] = value
    }

    row.DeliveryTime = 'NO'
    return row
  })

  return rows
}

async function buildShutdownFeedCsv(input: {
  database: ReturnType<typeof requireDatabase>
  channel: FeedOutputContext['channel']
}) {
  const currentRows: CatalogFeedOutputRow[] = []
  let sourceError: unknown = null

  try {
    const output = await buildCatalogFeedOutput(input)
    assertCatalogFeedOutputUniqueness(output.items)
    currentRows.push(
      ...output.items.map((item) =>
        toCatalogFeedOutputRow(item, true),
      ),
    )
  } catch (currentSourceError) {
    sourceError = currentSourceError
    console.error(
      'Current CMS shutdown projection failed; using immutable run fallback:',
      currentSourceError,
    )
  }

  // Include the last normal populations even when CMS
  // succeeds: an offer removed from CMS still needs NO.
  {
    const fallbackRunIds = await Promise.all(
      [
        FEED_GENERATOR_VERSION,
        FEED_GENERATOR_VERSION_V3,
        FEED_GENERATOR_VERSION_V2,
      ].map((version) =>
        findLatestCompletedFeedRunIdByVersion(
          input.database,
          input.channel.id,
          version,
        ),
      ),
    )
    const rows = currentRows
    const identifiers = new Set(rows.map((row) => row.Identifier))
    const productNumbers = new Set(rows.map((row) => row.ProductNumber))

    for (const runId of fallbackRunIds) {
      if (!runId) continue

      try {
        const fallback = await buildFeedRunCsv(runId)

        for (const row of parseDisabledCatalogFeedRows(
          fallback.csv,
        )) {
          if (
            identifiers.has(row.Identifier) ||
            productNumbers.has(row.ProductNumber)
          ) {
            continue
          }

          identifiers.add(row.Identifier)
          productNumbers.add(row.ProductNumber)
          rows.push(row)
        }
      } catch (error) {
        console.error(
          `Shutdown fallback run failed: ${runId}.`,
          error,
        )
      }
    }

    if (rows.length === 0) {
      throw sourceError ?? new FeedOutputError(
        'Nincs elérhető leállító feed-forrás.',
        'SHUTDOWN_SOURCE_UNAVAILABLE',
      )
    }

    rows.sort((left, right) =>
      left.Identifier.localeCompare(
        right.Identifier,
      ),
    )

    return serializeCatalogFeedCsv(rows)
  }
}

function isPublicFeedTokenValid(
  provided: string | undefined,
): boolean {
  const expected =
    process.env.ARUKERESO_PUBLIC_FEED_TOKEN?.trim() ??
    ''

  if (
    expected.length < 16 ||
    typeof provided !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(provided)
  ) {
    return false
  }

  return isPricingSyncTokenValid(
    provided,
    expected,
  )
}

arukeresoApi.get(
  '/feed/latest.csv',
  async (context) =>
    feedDownloadErrorResponse(
      context,
      async () => {
        const { database, channel } =
          await resolveFeedChannel()

        if (!channel) {
          throw new FeedOutputError(
            'Az Árukereső feed csatorna nincs konfigurálva.',
            'FEED_CHANNEL_NOT_FOUND',
          )
        }

        const latestRunId =
          await findLatestCompletedFeedRunId(
            database,
            channel.id,
          )

        if (!latestRunId) {
          throw new FeedOutputError(
            'Még nincs sikeresen generált feed.',
            'SUCCESSFUL_FEED_RUN_NOT_FOUND',
          )
        }

        return buildFeedRunCsv(latestRunId)
      },
    ),
)

// Dedicated public Árukereső feed. Served directly by
// the API deployment (same pattern as the Cockpit
// pricing sync); it does not pass through the
// Cloudflare Pages proxy auth. The opaque URL token is
// the only credential. Read-only: never triggers
// generation and never mutates data.
arukeresoApi.get(
  '/feed/public/:filename',
  async (context) => {
    const notFound = () => {
      context.header('Cache-Control', 'no-store')

      return context.json(
        {
          status: 'error',
          message: 'Not found.',
        },
        404,
      )
    }

    // The .csv suffix is part of the stable public
    // URL. It is validated here because this Hono
    // version cannot reliably capture a
    // ':token.csv' suffix pattern in the route.
    const filename =
      context.req.param('filename') ?? ''
    const token = /^([A-Za-z0-9_-]{16,128})\.csv$/.exec(
      filename,
    )?.[1]

    if (!token || !isPublicFeedTokenValid(token)) {
      return notFound()
    }

    try {
      const { database, channel } =
        await resolveFeedChannel()

      if (!channel) {
        return notFound()
      }

      if (!channel.isActive) {
        const csv = await buildShutdownFeedCsv({
          database,
          channel,
        })

        return new Response(csv, {
          headers: {
            'Content-Type':
              'text/csv; charset=utf-8',
            'Content-Disposition':
              `inline; filename="${FEED_OUTPUT_FILE_NAME}"`,
            'Cache-Control': 'no-store',
          },
        })
      }

      const latestRunId =
        await findLatestCompletedFeedRunId(
          database,
          channel.id,
        )

      if (!latestRunId) {
        return notFound()
      }

      const { csv, fileName } =
        await buildFeedRunCsv(latestRunId)

      return new Response(csv, {
        headers: {
          'Content-Type':
            'text/csv; charset=utf-8',
          'Content-Disposition':
            `inline; filename="${fileName}"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return notFound()
    }
  },
)

arukeresoApi.get(
  '/feed/preview',
  async (context) => {
    try {
      const limitParam = Number(
        context.req.query('limit') ??
          FEED_PREVIEW_LIMIT_DEFAULT,
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
              FEED_PREVIEW_LIMIT_MAX,
            )
          : FEED_PREVIEW_LIMIT_DEFAULT

      const offset =
        Number.isFinite(offsetParam)
          ? Math.max(
              Math.trunc(offsetParam),
              0,
            )
          : 0

      const searchFilter =
        context.req
          .query('search')
          ?.trim()
          .toLowerCase() || null

      const inclusionModeFilter =
        context.req.query('inclusionMode')

      const includedFilter =
        context.req.query('included')
      const feedStateFilter =
        context.req.query('feedState')

      const reasonCodeFilter =
        context.req.query('reasonCode')

      const priceKitStatusFilter =
        context.req.query('priceKitStatus')

      const stockStatusFilter =
        context.req.query('stockStatus')

      const database =
        requireDatabase()

      const [channel] = await database
        .select()
        .from(feedChannels)
        .where(
          eq(
            feedChannels.code,
            FEED_CHANNEL_CODE,
          ),
        )
        .limit(1)

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
          },
          409,
        )
      }

      const { settings, appliedDefaults } =
        resolveFeedEligibilitySettings(
          channel.settingsJson,
        )

      const [
        hubProducts,
        catalogConnections,
        pricingConnections,
        inventoryConnections,
        overrides,
      ] =
        await Promise.all([
          database
            .select({
              id: products.id,
              sku: products.sku,
              name: products.name,
            })
            .from(products)
            .where(
              eq(products.active, true),
            ),

          database
            .select({ id: dataConnections.id })
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
              ),
            )
            .limit(2),

          database
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
              ),
            ),

          database
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
            .limit(1),

          database
            .select({
              productId:
                feedProductOverrides.productId,
              inclusionMode:
                feedProductOverrides.inclusionMode,
            })
            .from(feedProductOverrides)
            .where(
              eq(
                feedProductOverrides.channelId,
                channel.id,
              ),
            ),
        ])

      const pricingConnectionIds =
        pricingConnections.map(
          (connection) =>
            connection.id,
        )

      const activeInventoryConnection =
        inventoryConnections[0] ?? null
      const activeCatalogConnection =
        catalogConnections.length === 1
          ? catalogConnections[0]
          : null

      const [
        pricingRows,
        inventoryRows,
        catalogProductRows,
      ] =
        await Promise.all([
          pricingConnectionIds.length > 0
            ? database
                .select({
                  productId:
                    pricingSourceItems.productId,
                  priceIndexBps:
                    pricingSourceItems.priceIndexBps,
                  medianIndexBps:
                    pricingSourceItems.medianIndexBps,
                  averageIndexBps:
                    pricingSourceItems.averageIndexBps,
                  dataStatus:
                    pricingSourceItems.dataStatus,
                  observedAt:
                    pricingSourceItems.observedAt,
                })
                .from(pricingSourceItems)
                .where(
                  and(
                    inArray(
                      pricingSourceItems.connectionId,
                      pricingConnectionIds,
                    ),
                    eq(
                      pricingSourceItems.marketCode,
                      'HU',
                    ),
                    eq(
                      pricingSourceItems.currency,
                      'HUF',
                    ),
                  ),
                )
            : [],
          activeInventoryConnection
            ? database
                .select({
                  sku: inventorySourceItems.sku,
                  stock:
                    inventorySourceItems.stock,
                })
                .from(inventorySourceItems)
                .where(
                  eq(
                    inventorySourceItems.connectionId,
                    activeInventoryConnection.id,
                  ),
                )
            : [],
          activeCatalogConnection
            ? database
                .select({
                  productId:
                    catalogSourceItems.productId,
                })
                .from(catalogSourceItems)
                .where(
                  eq(
                    catalogSourceItems.connectionId,
                    activeCatalogConnection.id,
                  ),
                )
            : [],
        ])

      const pricingByProduct = new Map<
        string,
        {
          priceIndexBps: number | null
          medianIndexBps: number | null
          averageIndexBps: number | null
          dataStatus: string | null
          observedAt: Date | null
        }
      >()

      for (const row of pricingRows) {
        if (row.productId === null) {
          continue
        }

        const current =
          pricingByProduct.get(
            row.productId,
          )

        if (
          !current ||
          (row.observedAt instanceof
            Date &&
            (!(
              current.observedAt instanceof
              Date
            ) ||
              row.observedAt.getTime() >
                current.observedAt.getTime()))
        ) {
          pricingByProduct.set(
            row.productId,
            {
              priceIndexBps:
                row.priceIndexBps,
              medianIndexBps:
                row.medianIndexBps,
              averageIndexBps:
                row.averageIndexBps,
              dataStatus: row.dataStatus,
              observedAt:
                row.observedAt,
            },
          )
        }
      }

      const overrideByProduct = new Map(
        overrides.map((override) => [
          override.productId,
          override.inclusionMode,
        ]),
      )

      const inventoryStockBySku = new Map(
        inventoryRows.map((item) => [
          item.sku,
          item.stock,
        ]),
      )
      const currentCmsProductIds = new Set(
        catalogProductRows.flatMap((item) =>
          item.productId ? [item.productId] : [],
        ),
      )

      const now = new Date()

      const summary = {
        products: 0,
        included: 0,
        excluded: 0,
        feedRows: 0,
        activeOffers: 0,
        disabledOffers: 0,
        omittedFromFeed: 0,
        priceKitFeedBase: 0,
        manuallyAdded: 0,
        ruleBased: 0,
        forceIncluded: 0,
        forceExcluded: 0,
        hasCompetitor: 0,
        noCompetitor: 0,
        missingPricing: 0,
        partialMarketData: 0,
        blockedByMinIndex: 0,
        blockedByMedianIndex: 0,
        blockedByAverageIndex: 0,
        blockedByStock: 0,
        missingEnabledMetric: 0,
        priceKitWithData: 0,
        priceKitWithoutData: 0,
        inStock: 0,
        manualOverride: 0,
        currentCmsProducts: 0,
        outsideCurrentCms: 0,
      }

      const reasonCounts: Record<
        string,
        number
      > = {}

      const items = hubProducts.map(
        (product) => {
          const pricingRow =
            pricingByProduct.get(
              product.id,
            ) ?? null

          const inclusionMode =
            overrideByProduct.get(
              product.id,
            ) ?? 'INHERIT'

          const result =
            evaluateFeedEligibility({
              pricingRow,
              stockQuantity:
                inventoryStockBySku.get(
                  product.sku,
                ) ?? null,
              override: inclusionMode,
              settings,
              now,
            })

          const priceKitStatus =
            result.reasonDetails.priceKitStatus

          const stockStatus =
            result.reasonDetails.stockAvailable ===
            null
              ? 'MISSING_STOCK'
              : result.reasonDetails.stockAvailable
                ? 'IN_STOCK'
                : 'OUT_OF_STOCK'
          const inCurrentCmsCatalog =
            currentCmsProductIds.has(product.id)
          const inFeed =
            inCurrentCmsCatalog &&
            (pricingRow !== null ||
              inclusionMode === 'FORCE_INCLUDE')

          summary.products += 1

          if (inCurrentCmsCatalog) {
            summary.currentCmsProducts += 1

            if (pricingRow !== null) {
              summary.priceKitFeedBase += 1
            }

            if (
              pricingRow === null &&
              inclusionMode === 'FORCE_INCLUDE'
            ) {
              summary.manuallyAdded += 1
            }

            if (inFeed) {
              summary.feedRows += 1

              if (result.included) {
                summary.activeOffers += 1
              } else {
                summary.disabledOffers += 1
              }
            } else {
              summary.omittedFromFeed += 1
            }
          } else {
            summary.outsideCurrentCms += 1
          }

          if (result.included) {
            summary.included += 1
          } else {
            summary.excluded += 1
          }

          if (
            inclusionMode ===
            'FORCE_INCLUDE'
          ) {
            summary.forceIncluded += 1
            summary.manualOverride += 1
          } else if (
            inclusionMode ===
            'FORCE_EXCLUDE'
          ) {
            summary.forceExcluded += 1
            summary.manualOverride += 1
          } else {
            summary.ruleBased += 1
          }

          if (pricingRow === null) {
            summary.priceKitWithoutData += 1
          } else {
            summary.priceKitWithData += 1
          }

          if (stockStatus === 'IN_STOCK') {
            summary.inStock += 1
          }

          if (pricingRow === null) {
            summary.missingPricing += 1
          } else if (
            pricingRow.dataStatus ===
            'HAS_COMPETITOR'
          ) {
            summary.hasCompetitor += 1
          } else if (
            pricingRow.dataStatus ===
            'NO_COMPETITOR'
          ) {
            summary.noCompetitor += 1
          } else {
            summary.partialMarketData += 1
          }

          reasonCounts[
            result.reasonCode
          ] =
            (reasonCounts[
              result.reasonCode
            ] ?? 0) + 1

          if (
            result.reasonCode ===
            'FEED_BLOCKED_MIN_INDEX'
          ) {
            summary.blockedByMinIndex += 1
          } else if (
            result.reasonCode ===
            'FEED_BLOCKED_MEDIAN_INDEX'
          ) {
            summary.blockedByMedianIndex += 1
          } else if (
            result.reasonCode ===
            'FEED_BLOCKED_AVERAGE_INDEX'
          ) {
            summary.blockedByAverageIndex += 1
          } else if (
            result.reasonCode ===
              'FEED_BLOCKED_OUT_OF_STOCK' ||
            result.reasonCode ===
              'FEED_BLOCKED_MISSING_STOCK'
          ) {
            summary.blockedByStock += 1
          }

          if (
            result.reasonCode ===
              'FEED_BLOCKED_MISSING_MIN_INDEX' ||
            result.reasonCode ===
              'FEED_BLOCKED_MISSING_MEDIAN_INDEX' ||
            result.reasonCode ===
              'FEED_BLOCKED_MISSING_AVERAGE_INDEX'
          ) {
            summary.missingEnabledMetric += 1
          }

          return {
            productId: product.id,
            sku: product.sku,
            name: product.name,
            inCurrentCmsCatalog,
            inFeed,
            activeInFeed:
              inFeed && result.included,
            included: result.included,
            inclusionMode,
            hasPriceKitData:
              pricingRow !== null,
            priceKitStatus,
            priceIndexBps:
              result.reasonDetails
                .priceIndexBps,
            priceIndexPercent:
              result.reasonDetails
                .priceIndexBps === null
                ? null
                : result.reasonDetails
                    .priceIndexBps / 100,
            medianIndexBps:
              result.reasonDetails
                .medianIndexBps,
            averageIndexBps:
              result.reasonDetails
                .averageIndexBps,
            stockQuantity:
              result.reasonDetails
                .stockQuantity,
            stockAvailable:
              result.reasonDetails
                .stockAvailable,
            stockStatus,
            dataStatus:
              result.reasonDetails
                .dataStatus,
            observedAt:
              result.reasonDetails
                .observedAt,
            reasonCode:
              result.reasonCode,
            reasonDetails:
              result.reasonDetails,
          }
        },
      )

      const filteredItems = items.filter(
        (item) => {
          if (
            searchFilter &&
            !item.sku
              .toLowerCase()
              .includes(searchFilter) &&
            !(item.name ?? '')
              .toLowerCase()
              .includes(searchFilter)
          ) {
            return false
          }

          if (
            inclusionModeFilter &&
            item.inclusionMode !==
              inclusionModeFilter
          ) {
            return false
          }

          if (
            includedFilter === 'true' &&
            !item.included
          ) {
            return false
          }

          if (
            includedFilter === 'false' &&
            item.included
          ) {
            return false
          }

          if (
            (feedStateFilter === 'IN_FEED' &&
              !item.inFeed) ||
            (feedStateFilter === 'ACTIVE' &&
              (!item.inFeed ||
                !item.activeInFeed)) ||
            (feedStateFilter === 'DISABLED' &&
              (!item.inFeed ||
                item.activeInFeed)) ||
            (feedStateFilter === 'OMITTED' &&
              item.inFeed)
          ) {
            return false
          }

          if (
            reasonCodeFilter &&
            item.reasonCode !==
              reasonCodeFilter
          ) {
            return false
          }

          if (
            priceKitStatusFilter &&
            (!item.inCurrentCmsCatalog ||
              (priceKitStatusFilter === 'HAS_DATA'
                ? item.priceKitStatus === 'NO_DATA'
                : priceKitStatusFilter ===
                    'HAS_COMPETITOR'
                  ? item.priceKitStatus !== 'HAS_DATA'
                  : item.priceKitStatus !==
                    priceKitStatusFilter))
          ) {
            return false
          }

          if (
            stockStatusFilter &&
            item.stockStatus !==
              stockStatusFilter
          ) {
            return false
          }

          return true
        },
      )

      filteredItems.sort((left, right) =>
        left.sku.localeCompare(
          right.sku,
        ),
      )

      return context.json({
        status: 'ok',
        channel: {
          id: channel.id,
          code: channel.code,
          isActive: channel.isActive,
          status: channel.status,
        },
        pricingConnectionIds,
        settings,
        appliedDefaults,
        summary,
        reasonCounts,
        pagination: {
          limit,
          offset,
          total: filteredItems.length,
        },
        items: filteredItems.slice(
          offset,
          offset + limit,
        ),
      })
    } catch (error) {
      console.error(
        'Feed preview failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Feed preview failed.',
        },
        500,
      )
    }
  },
)

const FEED_INCLUSION_MODES = [
  'INHERIT',
  'FORCE_INCLUDE',
  'FORCE_EXCLUDE',
] as const

type FeedInclusionMode =
  (typeof FEED_INCLUSION_MODES)[number]

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
}

async function resolveFeedChannel() {
  const database = requireDatabase()

  const [channel] = await database
    .select()
    .from(feedChannels)
    .where(
      eq(
        feedChannels.code,
        FEED_CHANNEL_CODE,
      ),
    )
    .limit(1)

  return { database, channel: channel ?? null }
}

function readStoredFeedSettings(
  settingsJson: string | null,
): Record<string, unknown> {
  if (settingsJson === null) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(
      settingsJson,
    )

    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

arukeresoApi.get(
  '/feed/settings',
  async (context) => {
    try {
      const { channel } =
        await resolveFeedChannel()

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
          },
          409,
        )
      }

      const { settings, appliedDefaults } =
        resolveFeedEligibilitySettings(
          channel.settingsJson,
        )

      return context.json({
        status: 'ok',
        channel: FEED_CHANNEL_CODE,
        isActive: channel.isActive,
        settings,
        appliedDefaults,
      })
    } catch (error) {
      console.error(
        'Feed settings loading failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Feed settings failed.',
        },
        500,
      )
    }
  },
)

arukeresoApi.patch(
  '/feed/settings',
  async (context) => {
    try {
      let body: unknown

      try {
        body = await context.req.json()
      } catch {
        body = null
      }

      if (
        body === null ||
        typeof body !== 'object' ||
        Array.isArray(body)
      ) {
        return context.json(
          {
            status: 'error',
            message: 'Érvénytelen kérés test.',
          },
          400,
        )
      }

      const {
        isActive,
        useMinIndex,
        maxMinIndexBps,
        useMedianIndex,
        maxMedianIndexBps,
        useAverageIndex,
        maxAverageIndexBps,
        useStockRule,
        allowNoCompetitor,
        allowMissingPricingData,
        maxPricingAgeHours,
        ruleVersion,
      } = body as Record<string, unknown>

      if (ruleVersion !== undefined) {
        return context.json(
          {
            status: 'error',
            message:
              'A ruleVersion nem állítható közvetlenül.',
          },
          400,
        )
      }

      if (
        isActive !== undefined &&
        typeof isActive !== 'boolean'
      ) {
        return context.json(
          {
            status: 'error',
            message: 'isActive csak true/false lehet.',
          },
          400,
        )
      }

      for (const [key, value] of [
        ['maxMinIndexBps', maxMinIndexBps],
        [
          'maxMedianIndexBps',
          maxMedianIndexBps,
        ],
        [
          'maxAverageIndexBps',
          maxAverageIndexBps,
        ],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value <= 0)
        ) {
          return context.json(
            {
              status: 'error',
              message: `${key} pozitív egész kell legyen (Bps).`,
            },
            400,
          )
        }
      }

      for (const [key, value] of [
        ['useMinIndex', useMinIndex],
        ['useMedianIndex', useMedianIndex],
        ['useAverageIndex', useAverageIndex],
        ['useStockRule', useStockRule],
        ['allowNoCompetitor', allowNoCompetitor],
        [
          'allowMissingPricingData',
          allowMissingPricingData,
        ],
      ] as const) {
        if (
          value !== undefined &&
          typeof value !== 'boolean'
        ) {
          return context.json(
            {
              status: 'error',
              message: `${key} csak true/false lehet.`,
            },
            400,
          )
        }
      }

      if (
        maxPricingAgeHours !== undefined &&
        (typeof maxPricingAgeHours !==
          'number' ||
          !Number.isInteger(
            maxPricingAgeHours,
          ) ||
          maxPricingAgeHours <= 0 ||
          maxPricingAgeHours > 8760)
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'maxPricingAgeHours 0 és 8760 közötti szám kell legyen.',
          },
          400,
        )
      }

      const { database, channel } =
        await resolveFeedChannel()

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
          },
          409,
        )
      }

      const stored =
        readStoredFeedSettings(
          channel.settingsJson,
        )

      const current =
        resolveFeedEligibilitySettings(
          channel.settingsJson,
        ).settings

      const next: Record<string, unknown> = {
        ...stored,
        useMinIndex: current.useMinIndex,
        maxMinIndexBps:
          current.maxMinIndexBps,
        useMedianIndex:
          current.useMedianIndex,
        maxMedianIndexBps:
          current.maxMedianIndexBps,
        useAverageIndex:
          current.useAverageIndex,
        maxAverageIndexBps:
          current.maxAverageIndexBps,
        useStockRule: current.useStockRule,
        allowNoCompetitor:
          current.allowNoCompetitor,
        allowMissingPricingData:
          current.allowMissingPricingData,
        maxPricingAgeHours:
          current.maxPricingAgeHours,
      }

      const updates = {
        useMinIndex,
        maxMinIndexBps,
        useMedianIndex,
        maxMedianIndexBps,
        useAverageIndex,
        maxAverageIndexBps,
        useStockRule,
        allowNoCompetitor,
        allowMissingPricingData,
        maxPricingAgeHours,
      }

      for (const [key, value] of Object.entries(
        updates,
      )) {
        if (value !== undefined) {
          next[key] = value
        }
      }

      // Only active rules affect eligibility and the
      // rule version. maxPricingAgeHours remains a
      // preserved legacy key.
      const activeKeys = [
        'useMinIndex',
        'maxMinIndexBps',
        'useMedianIndex',
        'maxMedianIndexBps',
        'useAverageIndex',
        'maxAverageIndexBps',
        'useStockRule',
        'allowNoCompetitor',
      ] as Array<
        keyof FeedEligibilitySettings
      >

      const materialChanged =
        activeKeys.some(
          (key) => next[key] !== current[key],
        )

      // Legacy keys are accepted and preserved for API
      // compatibility, but V4 ignores them and they do
      // not affect the rule version.
      const inactiveChanged = (
        [
          'allowMissingPricingData',
          'maxPricingAgeHours',
        ] as const
      ).some(
        (key) =>
          updates[key] !== undefined &&
          stored[key] !== updates[key],
      )

      const activationChanged =
        isActive !== undefined &&
        isActive !== channel.isActive

      if (
        !materialChanged &&
        !inactiveChanged &&
        !activationChanged
      ) {
        const resolved =
          resolveFeedEligibilitySettings(
            channel.settingsJson,
          )

        return context.json({
          status: 'ok',
          channel: FEED_CHANNEL_CODE,
          isActive: channel.isActive,
          settings: resolved.settings,
          appliedDefaults:
            resolved.appliedDefaults,
          updated: false,
        })
      }

      const storedRuleVersion =
        stored['ruleVersion']

      if (materialChanged) {
        next['ruleVersion'] =
          typeof storedRuleVersion ===
            'number' &&
          Number.isInteger(
            storedRuleVersion,
          ) &&
          storedRuleVersion > 0
            ? storedRuleVersion + 1
            : current.ruleVersion + 1
      }

      const settingsChanged =
        materialChanged || inactiveChanged
      const nextSettingsJson = settingsChanged
        ? JSON.stringify(next)
        : channel.settingsJson

      if (
        activationChanged &&
        isActive === true &&
        !channel.isActive
      ) {
        const generated =
          await generateCatalogFeedRun({
            database,
            channel: {
              ...channel,
              settingsJson: nextSettingsJson,
            },
            triggerType: 'CHANNEL_ACTIVATION',
            activateChannel: true,
          })
        const resolved =
          resolveFeedEligibilitySettings(
            nextSettingsJson,
          )

        return context.json({
          status: 'ok',
          channel: FEED_CHANNEL_CODE,
          isActive: true,
          settings: resolved.settings,
          appliedDefaults:
            resolved.appliedDefaults,
          updated: true,
          activationRunId: generated.runId,
          artifact: generated.artifact,
        })
      }

      await database
        .update(feedChannels)
        .set({
          ...(settingsChanged
            ? {
                settingsJson: nextSettingsJson,
              }
            : {}),
          ...(activationChanged
            ? { isActive }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          eq(feedChannels.id, channel.id),
        )

      const resolved =
        resolveFeedEligibilitySettings(
          nextSettingsJson,
        )

      return context.json({
        status: 'ok',
        channel: FEED_CHANNEL_CODE,
        isActive:
          isActive ?? channel.isActive,
        settings: resolved.settings,
        appliedDefaults:
          resolved.appliedDefaults,
        updated: true,
      })
    } catch (error) {
      console.error(
        'Feed settings update failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          code:
            error instanceof FeedOutputError
              ? error.code
              : 'FEED_SETTINGS_UPDATE_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Feed settings failed.',
        },
        error instanceof FeedOutputError
          ? 422
          : 500,
      )
    }
  },
)

arukeresoApi.patch(
  '/feed/products/:productId/override',
  async (context) => {
    try {
      const productId = context.req.param(
        'productId',
      )

      if (!isUuid(productId)) {
        return context.json(
          {
            status: 'error',
            message: 'Érvénytelen productId.',
          },
          400,
        )
      }

      let body: unknown

      try {
        body = await context.req.json()
      } catch {
        body = null
      }

      const { inclusionMode, reason } =
        (body ?? {}) as {
          inclusionMode?: unknown
          reason?: unknown
        }

      if (
        inclusionMode !== 'INHERIT' &&
        inclusionMode !== 'FORCE_INCLUDE' &&
        inclusionMode !== 'FORCE_EXCLUDE'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'inclusionMode csak INHERIT, FORCE_INCLUDE vagy FORCE_EXCLUDE lehet.',
          },
          400,
        )
      }

      if (
        reason !== undefined &&
        reason !== null &&
        typeof reason !== 'string'
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'reason csak szöveg lehet.',
          },
          400,
        )
      }

      const { database, channel } =
        await resolveFeedChannel()

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
          },
          409,
        )
      }

      const [product] = await database
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1)

      if (!product) {
        return context.json(
          {
            status: 'error',
            message: 'Termék nem található.',
          },
          404,
        )
      }

      const updatedBy =
        getCommerceHubUser(context)?.email ??
        'COMMERCE_HUB_UI'

      if (
        (inclusionMode as string) ===
        'INHERIT'
      ) {
        const removed = await database
          .delete(feedProductOverrides)
          .where(
            and(
              eq(
                feedProductOverrides.channelId,
                channel.id,
              ),
              eq(
                feedProductOverrides.productId,
                productId,
              ),
            ),
          )
          .returning({
            id: feedProductOverrides.id,
          })

        return context.json({
          status: 'ok',
          reset: true,
          existed: removed.length > 0,
        })
      }

      const normalizedReason =
        typeof reason === 'string' &&
        reason.trim()
          ? reason.trim()
          : null

      const [row] = await database
        .insert(feedProductOverrides)
        .values({
          channelId: channel.id,
          productId,
          inclusionMode:
            inclusionMode as FeedInclusionMode,
          reason: normalizedReason,
          updatedBy,
        })
        .onConflictDoUpdate({
          target: [
            feedProductOverrides.channelId,
            feedProductOverrides.productId,
          ],
          set: {
            inclusionMode:
              inclusionMode as FeedInclusionMode,
            reason: normalizedReason,
            updatedBy,
            updatedAt: new Date(),
          },
        })
        .returning()

      return context.json({
        status: 'ok',
        data: row ?? null,
      })
    } catch (error) {
      console.error(
        'Feed override update failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Feed override failed.',
        },
        500,
      )
    }
  },
)

arukeresoApi.delete(
  '/feed/products/:productId/override',
  async (context) => {
    try {
      const productId = context.req.param(
        'productId',
      )

      if (!isUuid(productId)) {
        return context.json(
          {
            status: 'error',
            message: 'Érvénytelen productId.',
          },
          400,
        )
      }

      const { database, channel } =
        await resolveFeedChannel()

      if (!channel) {
        return context.json(
          {
            status: 'error',
            message:
              'Az Árukereső feed csatorna nincs konfigurálva (ARUKERESO_HU).',
          },
          409,
        )
      }

      const [product] = await database
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1)

      if (!product) {
        return context.json(
          {
            status: 'error',
            message: 'Termék nem található.',
          },
          404,
        )
      }

      const removed = await database
        .delete(feedProductOverrides)
        .where(
          and(
            eq(
              feedProductOverrides.channelId,
              channel.id,
            ),
            eq(
              feedProductOverrides.productId,
              productId,
            ),
          ),
        )
        .returning({
          id: feedProductOverrides.id,
        })

      return context.json({
        status: 'ok',
        reset: true,
        existed: removed.length > 0,
      })
    } catch (error) {
      console.error(
        'Feed override reset failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Feed override failed.',
        },
        500,
      )
    }
  },
)

export {
  arukeresoApi,
  assertArukeresoConfiguration,
  assertSnapshotSizeSafety,
  assertFeedOutputSafety,
  buildCatalogFeedOutput,
  createFeedFingerprint,
  createCatalogFeedCsv,
  evaluateFeedEligibility,
  isCatalogFeedItemInV4,
  parseSemicolonCsv,
  parseCatalogFeedSourceRow,
  parseCatalogFeedOutputRow,
  toCatalogFeedOutputRow,
  FEED_OUTPUT_HEADERS,
  resolvePriceKitStatus,
  resolveFeedEligibilitySettings,
  serializeCatalogFeedCsv,
  FEED_ELIGIBILITY_DEFAULT_SETTINGS,
  FEED_CHANNEL_CODE,
  FEED_GENERATOR_VERSION,
}
