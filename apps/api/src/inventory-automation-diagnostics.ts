export const FAILED_LISTING_DIAGNOSTICS_LIMIT = 50
export const FAILURE_MESSAGE_SKU_LIMIT = 3

const SAFE_TEXT_LIMIT = 500
const SAFE_IDENTIFIER_LIMIT = 160

type UnknownRecord = Record<string, unknown>

export type FailedInventoryListingDiagnostic = {
  listingId: string | null
  sku: string | null
  offerId: string | null
  action: string
  remoteStock: number | null
  targetStock: number | null
  remotePublicationStatus: string | null
  desiredPublicationStatus: string | null
  historyGroupId: string | null
  batchIndex: number | null
  httpStatus: number | null
  taskStatus: string | null
  commandId: string | null
  taskMessage: string | null
  taskField: string | null
}

export type InventoryAutomationPlatformDiagnostics = {
  platform: string
  historyGroupId: string | null
  transportStatus: number | null
  totalListings: number
  batchCount: number
  successfulBatches: number
  failedBatches: number
  attempted: number
  stockUpdated: number
  reactivated: number
  autoPaused: number
  unchanged: number
  skipped: number
  pending: number
  failed: number
  skipBreakdown: {
    stockLocked: number
    duplicateSkuSkipped: number
    manuallyInactive: number
    other: number
  }
  failedListings: {
    total: number
    returned: number
    truncated: boolean
    items: FailedInventoryListingDiagnostic[]
  }
}

export type InventoryAutomationDiagnostics = {
  version: 1
  platforms: InventoryAutomationPlatformDiagnostics[]
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function safeText(
  value: unknown,
  limit = SAFE_TEXT_LIMIT,
) {
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  if (!normalized) return null

  return normalized.slice(0, limit)
}

function safeNumber(value: unknown) {
  return typeof value === 'number' &&
    Number.isFinite(value)
    ? value
    : null
}

function nonNegativeInteger(value: unknown) {
  const number = safeNumber(value)
  return number === null
    ? 0
    : Math.max(0, Math.trunc(number))
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function extractFailedInventoryListingDiagnostic(
  resultValue: unknown,
  context: {
    historyGroupId?: unknown
    batchIndex?: unknown
  } = {},
): FailedInventoryListingDiagnostic | null {
  const result = asRecord(resultValue)

  if (result?.status !== 'FAILED') return null

  const details = asRecord(result.details)
  const task = asRecord(details?.task)

  return {
    listingId: safeText(
      result.listingId,
      SAFE_IDENTIFIER_LIMIT,
    ),
    sku: safeText(result.sku, SAFE_IDENTIFIER_LIMIT),
    offerId: safeText(
      result.offerId,
      SAFE_IDENTIFIER_LIMIT,
    ),
    action:
      safeText(result.action, SAFE_IDENTIFIER_LIMIT) ??
      'UNKNOWN',
    remoteStock: safeNumber(result.remoteStock),
    targetStock: safeNumber(result.targetStock),
    remotePublicationStatus: safeText(
      result.publicationStatus,
      SAFE_IDENTIFIER_LIMIT,
    ),
    desiredPublicationStatus: safeText(
      result.desiredPublicationStatus,
      SAFE_IDENTIFIER_LIMIT,
    ),
    historyGroupId: safeText(
      context.historyGroupId,
      SAFE_IDENTIFIER_LIMIT,
    ),
    batchIndex: safeNumber(context.batchIndex),
    httpStatus:
      safeNumber(details?.httpStatus) ??
      safeNumber(result.httpStatus),
    taskStatus: safeText(
      task?.status,
      SAFE_IDENTIFIER_LIMIT,
    ),
    commandId: safeText(
      details?.commandId,
      SAFE_IDENTIFIER_LIMIT,
    ),
    taskMessage:
      safeText(task?.message) ??
      safeText(details?.message),
    taskField: safeText(
      task?.field,
      SAFE_IDENTIFIER_LIMIT,
    ),
  }
}

export function buildInventoryAutomationDiagnostics(
  automationResultValue: unknown,
): InventoryAutomationDiagnostics {
  const automationResult = asRecord(
    automationResultValue,
  )
  const platforms: InventoryAutomationPlatformDiagnostics[] = []

  for (const platformValue of arrayValue(
    automationResult?.results,
  )) {
    const platformResult = asRecord(platformValue)
    if (!platformResult) continue

    const details = asRecord(platformResult.details)
    const batches = arrayValue(details?.batches)
    const historyGroupId = safeText(
      details?.historyGroupId,
      SAFE_IDENTIFIER_LIMIT,
    )
    const summary = {
      attempted: 0,
      stockUpdated: 0,
      reactivated: 0,
      autoPaused: 0,
      unchanged: 0,
      skipped: 0,
      pending: 0,
      failed: 0,
    }
    const skipBreakdown = {
      stockLocked: 0,
      duplicateSkuSkipped: 0,
      manuallyInactive: 0,
      other: 0,
    }
    const failedListings: FailedInventoryListingDiagnostic[] = []
    let failedListingTotal = 0

    for (const batchValue of batches) {
      const batch = asRecord(batchValue)
      if (!batch) continue

      const batchDetails = asRecord(batch.details)
      const batchSummary = asRecord(batchDetails?.summary)

      for (const key of Object.keys(summary) as Array<
        keyof typeof summary
      >) {
        summary[key] += nonNegativeInteger(
          batchSummary?.[key],
        )
      }

      for (const resultValue of arrayValue(
        batchDetails?.results,
      )) {
        const result = asRecord(resultValue)
        if (!result) continue

        if (result.action === 'SKIP') {
          if (result.status === 'STOCK_LOCKED') {
            skipBreakdown.stockLocked += 1
          } else if (result.status === 'DUPLICATE_SKU') {
            skipBreakdown.duplicateSkuSkipped += 1
          } else if (result.status === 'MANUAL_INACTIVE') {
            skipBreakdown.manuallyInactive += 1
          } else {
            skipBreakdown.other += 1
          }
        }

        const failedListing =
          extractFailedInventoryListingDiagnostic(
            result,
            {
              historyGroupId,
              batchIndex:
                safeNumber(batch.batchNumber),
            },
          )

        if (!failedListing) continue

        failedListingTotal += 1
        if (
          failedListings.length <
          FAILED_LISTING_DIAGNOSTICS_LIMIT
        ) {
          failedListings.push(failedListing)
        }
      }
    }

    const failedBatches =
      nonNegativeInteger(details?.failedBatches) ||
      batches.filter(
        (batch) => asRecord(batch)?.ok === false,
      ).length
    const batchCount =
      nonNegativeInteger(details?.batchCount) ||
      batches.length

    platforms.push({
      platform:
        safeText(
          platformResult.platform,
          SAFE_IDENTIFIER_LIMIT,
        ) ?? 'UNKNOWN',
      historyGroupId,
      transportStatus: safeNumber(platformResult.status),
      totalListings:
        nonNegativeInteger(details?.totalListings),
      batchCount,
      successfulBatches:
        nonNegativeInteger(details?.successfulBatches) ||
        Math.max(0, batchCount - failedBatches),
      failedBatches,
      ...summary,
      skipBreakdown,
      failedListings: {
        total: failedListingTotal,
        returned: failedListings.length,
        truncated:
          failedListingTotal > failedListings.length,
        items: failedListings,
      },
    })
  }

  return {
    version: 1,
    platforms,
  }
}

export function formatInventoryAutomationFailure(
  diagnostics: InventoryAutomationDiagnostics,
) {
  const failedPlatform = diagnostics.platforms.find(
    (platform) =>
      platform.failed > 0 || platform.failedBatches > 0,
  )

  if (!failedPlatform) {
    return 'A készletszinkron sikertelen.'
  }

  const platformName =
    failedPlatform.platform === 'ALLEGRO'
      ? 'Allegro'
      : failedPlatform.platform
  const failedCount = failedPlatform.failed
  const totalListings = failedPlatform.totalListings
  let message =
    failedCount > 0 && totalListings > 0
      ? `Az ${platformName} készletszinkron részben sikertelen: ${totalListings} ajánlatból ${failedCount} hibás.`
      : `Az ${platformName} készletszinkron sikertelen: ${failedPlatform.failedBatches} batch hibás.`

  const skus = [
    ...new Set(
      failedPlatform.failedListings.items
        .map((item) => item.sku)
        .filter((sku): sku is string => Boolean(sku)),
    ),
  ]
  const displayedSkus = skus.slice(
    0,
    FAILURE_MESSAGE_SKU_LIMIT,
  )

  if (displayedSkus.length === 1) {
    message = `${message.slice(0, -1)} (SKU: ${displayedSkus[0]}).`
  } else if (displayedSkus.length > 1) {
    const remaining = Math.max(
      0,
      failedPlatform.failedListings.total -
        displayedSkus.length,
    )
    const suffix = remaining > 0
      ? ` és további ${remaining}`
      : ''

    message = `${message.slice(0, -1)} (SKU-k: ${displayedSkus.join(', ')}${suffix}).`
  }

  return message
}

export function parseInventoryAutomationDiagnostics(
  value: unknown,
): InventoryAutomationDiagnostics | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    const record = asRecord(parsed)

    return record?.version === 1 &&
      Array.isArray(record.platforms)
      ? (parsed as InventoryAutomationDiagnostics)
      : null
  } catch {
    return null
  }
}
