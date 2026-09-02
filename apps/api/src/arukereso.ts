import {
  createDatabase,
  productIdentifiers,
  products,
} from '@karcher-commerce-hub/database'
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

      const csvRows =
        parseSemicolonCsv(csvText)

      if (csvRows.length === 0) {
        return context.json(
          {
            status: 'error',
            message:
              'A CSV fajl ures.',
          },
          400,
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
        return context.json(
          {
            status: 'error',
            message:
              'A CMS CSV fejlece nem megfelelo.',
            headers,
            missingHeaders,
          },
          400,
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

      const items: CatalogPreviewItem[] =
        []

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
        const row =
          csvRows[index]

        const identifier =
          normalizeCell(
            getValue(
              row,
              'Identifier',
            ),
          )

        const eanCode =
          normalizeCell(
            getValue(
              row,
              'EanCode',
            ),
          )

        const normalizedSku =
          identifier
            ? cmsIdentifierToSku(
                identifier,
              )
            : null

        if (
          identifier &&
          !normalizedSku
        ) {
          invalidIdentifierFormat += 1
        }

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
          matchConflicts += 1
        } else if (
          skuMatchedProduct
        ) {
          matchStatus = 'MATCHED'
          matchMethod = 'SKU'
          matchedProductId =
            skuMatchedProduct.id
          matchedSku =
            skuMatchedProduct.sku
          matchedBySku += 1
        } else if (
          eanMatchedProduct
        ) {
          matchStatus = 'MATCHED'
          matchMethod = 'EAN'
          matchedProductId =
            eanMatchedProduct.id
          matchedSku =
            eanMatchedProduct.sku
          matchedByEan += 1
        } else {
          matchStatus = 'UNMATCHED'
          unmatched += 1
        }

        const name =
          normalizeCell(
            getValue(
              row,
              'Name',
            ),
          )

        const productUrl =
          normalizeCell(
            getValue(
              row,
              'ProductUrl',
            ),
          )

        const imageUrl =
          normalizeCell(
            getValue(
              row,
              'ImageUrl',
            ),
          )

        const priceRaw =
          normalizeCell(
            getValue(
              row,
              'Price',
            ),
          )

        const priceMinor =
          priceRaw
            ? parseMoneyMinor(
                priceRaw,
              )
            : null

        const netPriceRaw =
          normalizeCell(
            getValue(
              row,
              'NetPrice',
            ),
          )

        const deliveryCostRaw =
          normalizeCell(
            getValue(
              row,
              'DeliveryCost',
            ),
          )

        const deliveryTimeRaw =
          normalizeCell(
            getValue(
              row,
              'DeliveryTime',
            ),
          )

        const deliveryTimeDays =
          deliveryTimeRaw
            ? parseDeliveryTimeDays(
                deliveryTimeRaw,
              )
            : null

        const errors: string[] =
          []

        if (!identifier) {
          errors.push(
            'MISSING_IDENTIFIER',
          )
        }

        if (!eanCode) {
          errors.push('MISSING_EAN')
          missingEanRows += 1
        }

        if (!name) {
          errors.push('MISSING_NAME')
        }

        if (!productUrl) {
          errors.push(
            'MISSING_PRODUCT_URL',
          )
        }

        if (!imageUrl) {
          errors.push(
            'MISSING_IMAGE',
          )
        }

        if (
          priceMinor === null ||
          priceMinor <= 0
        ) {
          errors.push(
            'INVALID_PRICE',
          )
          invalidPriceRows += 1

          if (priceMinor === 0) {
            zeroPriceRows += 1
          }
        }

        if (
          deliveryTimeDays === null
        ) {
          errors.push(
            'INVALID_DELIVERY_TIME',
          )
          invalidDeliveryTimeRows += 1
        }

        if (errors.length === 0) {
          validRows += 1
        } else {
          invalidRows += 1
        }

        identifiers.push(identifier)
        eanCodes.push(eanCode)

        if (
          items.length <
          PREVIEW_LIMIT
        ) {
          items.push({
            rowNumber:
              index + 1,
            identifier,
            eanCode,
            manufacturer:
              normalizeCell(
                getValue(
                  row,
                  'Manufacturer',
                ),
              ),
            name,
            category:
              normalizeCell(
                getValue(
                  row,
                  'Category',
                ),
              ),
            productUrl,
            imageUrl,
            imageUrl2:
              normalizeCell(
                getValue(
                  row,
                  'ImageUrl2',
                ),
              ),
            priceRaw,
            priceMinor,
            netPriceRaw,
            netPriceMinor:
              netPriceRaw
                ? parseMoneyMinor(
                    netPriceRaw,
                  )
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
          })
        }
      }

      return context.json({
        status: 'ok',
        fileName:
          uploadedFile.name,
        headers,
        summary: {
          rows:
            csvRows.length - 1,
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
            countDuplicates(
              identifiers,
            ),
          duplicateEanCount:
            countDuplicates(
              eanCodes,
            ),
          previewRows:
            items.length,
        },
        data: items,
      })
    } catch (error) {
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

export {
  arukeresoApi,
}