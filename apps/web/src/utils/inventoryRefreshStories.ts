/*
 * Presentation-only aggregation for inventory refresh results.
 *
 * Groups low-level SYNC automation events by listingId so one
 * listing renders as one business story. Never changes sync,
 * eligibility, or persistence semantics.
 */

export type StoryEventInput = {
  id: string
  listingId: string
  offerId: string
  sku: string
  listingName: string
  /** Automation action, e.g. STOCK_UPDATE, ACTIVATE, END, SKIP, NONE. */
  action: string
  /** Automation outcome, e.g. SUCCESS, FAILED, PENDING, MANUAL_INACTIVE. */
  status: string
  occurredAt: string
  metadata: {
    historyGroupId?: string | null
    publicationStatus?: string | null
    targetStock?: number | null
    remoteStock?: number | null
    fromStock?: number | null
    toStock?: number | null
  } | null
}

export type ListingBusinessResult =
  | 'FAILED'
  | 'PENDING'
  | 'AUTO_PAUSED'
  | 'ACTIVATED'
  | 'STOCK_UPDATED'
  | 'MANUAL_SKIPPED'
  | 'SKIPPED'
  | 'NO_ACTION'

export type ListingStoryStatus =
  | 'success'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'none'

export type ListingStory = {
  listingId: string
  offerId: string
  sku: string
  listingName: string
  stockFrom: number | null
  stockTo: number | null
  businessResult: ListingBusinessResult
  resultLabel: string
  status: ListingStoryStatus
  statusLabel: string
  skipReason: string | null
  stockChanged: boolean
  eventCount: number
  events: StoryEventInput[]
}

const SKIP_REASONS: Record<string, string> = {
  STOCK_LOCKED: 'Készlet zárolva',
  DUPLICATE_SKU: 'Duplikált SKU',
  TARGET_STOCK_UNKNOWN: 'Nincs célkészlet',
  REMOTE_STOCK_UNKNOWN:
    'Ismeretlen Allegro-készlet',
  UNSUPPORTED_PUBLICATION_STATE:
    'Nem támogatott állapot',
}

function firstNumber(
  values: Array<number | null | undefined>,
): number | null {
  for (const value of values) {
    if (
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      return value
    }
  }

  return null
}

function lastNumber(
  values: Array<number | null | undefined>,
): number | null {
  return firstNumber([...values].reverse())
}

function isActivateAction(action: string) {
  return (
    action.includes('ACTIVATE') ||
    action.includes('REACTIVATION')
  )
}

function isEndAction(action: string) {
  return (
    action === 'END' ||
    action === 'ADOPT_AUTO_PAUSE'
  )
}

function isPendingStatus(status: string) {
  return (
    status === 'PENDING' ||
    status === 'REACTIVATION_IN_PROGRESS'
  )
}

export function aggregateListingStory(
  listingId: string,
  events: StoryEventInput[],
): ListingStory {
  const ordered = [...events].sort(
    (left, right) =>
      left.occurredAt.localeCompare(
        right.occurredAt,
      ),
  )
  const first = ordered[0]

  const stockFrom =
    firstNumber(
      ordered.map(
        (event) => event.metadata?.fromStock,
      ),
    ) ??
    firstNumber(
      ordered.map(
        (event) => event.metadata?.remoteStock,
      ),
    )
  const stockTo =
    lastNumber(
      ordered.map(
        (event) => event.metadata?.toStock,
      ),
    ) ??
    lastNumber(
      ordered.map(
        (event) => event.metadata?.targetStock,
      ),
    )
  const stockChanged =
    stockFrom !== null &&
    stockTo !== null &&
    stockFrom !== stockTo

  const failed = ordered.some(
    (event) => event.status === 'FAILED',
  )
  const pending =
    !failed &&
    ordered.some((event) =>
      isPendingStatus(event.status),
    )
  const endSuccess = ordered.some(
    (event) =>
      isEndAction(event.action) &&
      event.status === 'SUCCESS',
  )
  const activated = ordered.some(
    (event) =>
      isActivateAction(event.action) &&
      event.status === 'SUCCESS',
  )
  const manualSkip = ordered.find(
    (event) =>
      event.action === 'SKIP' &&
      event.status === 'MANUAL_INACTIVE',
  )
  const otherSkip = ordered.find(
    (event) =>
      event.action === 'SKIP' &&
      event.status !== 'MANUAL_INACTIVE',
  )
  const noChange = ordered.every(
    (event) =>
      event.action === 'NONE' ||
      event.status === 'NO_CHANGE' ||
      event.status === 'ALREADY_AUTO_PAUSED',
  )

  let businessResult: ListingBusinessResult =
    'NO_ACTION'
  let resultLabel = 'Nincs teendő'
  let status: ListingStoryStatus = 'none'
  let statusLabel = 'Nincs teendő'
  let skipReason: string | null = null

  if (failed) {
    businessResult = 'FAILED'
    resultLabel = 'Sikertelen'
    status = 'failed'
    statusLabel = 'Sikertelen'
  } else if (pending) {
    businessResult = 'PENDING'
    resultLabel = 'Feldolgozás alatt'
    status = 'pending'
    statusLabel = 'Függőben'
  } else if (manualSkip) {
    businessResult = 'MANUAL_SKIPPED'
    resultLabel = 'Manuálisan inaktív — kihagyva'
    status = 'skipped'
    statusLabel = 'Kihagyva'
  } else if (otherSkip) {
    const reason =
      SKIP_REASONS[otherSkip.status] ??
      otherSkip.status
    businessResult = 'SKIPPED'
    resultLabel = `Kihagyva — ${reason}`
    status = 'skipped'
    statusLabel = 'Kihagyva'
    skipReason = reason
  } else if (endSuccess) {
    businessResult = 'AUTO_PAUSED'
    resultLabel = 'Automatikusan lekapcsolva'
    status = 'success'
    statusLabel = 'Sikeres'
  } else if (activated) {
    businessResult = 'ACTIVATED'
    resultLabel = 'Automatikusan aktiválva'
    status = 'success'
    statusLabel = 'Sikeres'
  } else if (stockChanged) {
    businessResult = 'STOCK_UPDATED'
    resultLabel = 'Készlet frissítve'
    status = 'success'
    statusLabel = 'Sikeres'
  } else if (!noChange) {
    businessResult = 'STOCK_UPDATED'
    resultLabel = 'Készlet frissítve'
    status = 'success'
    statusLabel = 'Sikeres'
  }

  return {
    listingId,
    offerId: first?.offerId ?? '',
    sku: first?.sku ?? '',
    listingName: first?.listingName ?? '',
    stockFrom,
    stockTo,
    businessResult,
    resultLabel,
    status,
    statusLabel,
    skipReason,
    stockChanged,
    eventCount: ordered.length,
    events: ordered,
  }
}

export function aggregateListingStories(
  events: StoryEventInput[],
): ListingStory[] {
  const byListing = new Map<
    string,
    StoryEventInput[]
  >()

  for (const event of events) {
    const group =
      byListing.get(event.listingId) ?? []
    group.push(event)
    byListing.set(event.listingId, group)
  }

  return [...byListing.entries()].map(
    ([listingId, groupEvents]) =>
      aggregateListingStory(
        listingId,
        groupEvents,
      ),
  )
}

export type StorySummary = {
  total: number
  affected: number
  stockChanged: number
  activated: number
  autoPaused: number
  skipped: number
  failed: number
  pending: number
  noAction: number
}

export function summarizeStories(
  stories: ListingStory[],
): StorySummary {
  const summary: StorySummary = {
    total: stories.length,
    affected: 0,
    stockChanged: 0,
    activated: 0,
    autoPaused: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    noAction: 0,
  }

  for (const story of stories) {
    switch (story.businessResult) {
      case 'FAILED':
        summary.failed += 1
        summary.affected += 1
        break
      case 'PENDING':
        summary.pending += 1
        summary.affected += 1
        break
      case 'AUTO_PAUSED':
        summary.autoPaused += 1
        summary.affected += 1
        if (story.stockChanged) {
          summary.stockChanged += 1
        }
        break
      case 'ACTIVATED':
        summary.activated += 1
        summary.affected += 1
        if (story.stockChanged) {
          summary.stockChanged += 1
        }
        break
      case 'STOCK_UPDATED':
        summary.affected += 1
        summary.stockChanged += 1
        break
      case 'MANUAL_SKIPPED':
      case 'SKIPPED':
        summary.skipped += 1
        summary.affected += 1
        break
      case 'NO_ACTION':
        summary.noAction += 1
        break
    }
  }

  return summary
}

export type DayEventInput = {
  id: string
  listingId: string
  occurredAt: string
  eventType: string
  source: string
}

/*
 * Only remote-state/reconciliation events belong to the
 * inventory automation story. Verified writers:
 * - SYNC: allegro-inventory-sync (INVENTORY_AUTOMATION)
 * - STOCK/STATUS: remote reconciliation (ALLEGRO_SYNC)
 * PRICE, CAMPAIGN, MANUAL and anything else always stay
 * in the general history row, even on listing overlap.
 */
const ATTACHABLE_EVENT_TYPES = new Set([
  'SYNC',
  'STOCK',
  'STATUS',
])

const AUTOMATION_EVENT_SOURCES = new Set([
  'INVENTORY_AUTOMATION',
  'ALLEGRO_SYNC',
])

function isAttachableEvent(
  event: DayEventInput,
): boolean {
  return (
    ATTACHABLE_EVENT_TYPES.has(event.eventType) &&
    AUTOMATION_EVENT_SOURCES.has(event.source)
  )
}

export type DaySyncGroupInput = {
  groupId: string
  occurredAt: string
  listingIds: string[]
}

/*
 * Attaches day-level non-SYNC events to the sync group
 * that already covers the same listing, newest group
 * first. Every input event lands in exactly one place:
 * either one owning group or the leftover list, so the
 * UI can render related changes inside the automation
 * detail without duplicating or losing records.
 */
export function attachRelatedDayEvents<
  TGroup extends DaySyncGroupInput,
  TEvent extends DayEventInput,
>(
  groups: TGroup[],
  events: TEvent[],
): {
  attachments: Map<string, TEvent[]>
  leftover: TEvent[]
} {
  const orderedGroups = [...groups].sort(
    (left, right) =>
      right.occurredAt.localeCompare(
        left.occurredAt,
      ),
  )
  const listingOwners = new Map<string, string>()

  for (const group of orderedGroups) {
    for (const listingId of group.listingIds) {
      if (!listingOwners.has(listingId)) {
        listingOwners.set(listingId, group.groupId)
      }
    }
  }

  const attachments = new Map<string, TEvent[]>()
  const leftover: TEvent[] = []

  for (const event of events) {
    const owner = listingOwners.get(
      event.listingId,
    )

    if (!owner || !isAttachableEvent(event)) {
      leftover.push(event)
      continue
    }

    const attached =
      attachments.get(owner) ?? []
    attached.push(event)
    attachments.set(owner, attached)
  }

  for (const attached of attachments.values()) {
    attached.sort((left, right) =>
      right.occurredAt.localeCompare(
        left.occurredAt,
      ),
    )
  }

  return { attachments, leftover }
}

export type RefreshOverall =
  | 'success'
  | 'partial'
  | 'failed'
  | 'import-only'
  | 'legacy'
  | 'running'

export function summarizeRefreshRun(run: {
  status: string
  importStatus: string | null
}): {
  overall: RefreshOverall
  helper: string | null
} {
  if (run.status === 'COMPLETED') {
    return { overall: 'success', helper: null }
  }

  if (
    run.status === 'FAILED' &&
    (run.importStatus === 'SUCCESS' ||
      run.importStatus === 'NO_CHANGE')
  ) {
    return {
      overall: 'partial',
      helper:
        'A készletforrás frissítése sikerült, de az Allegro szinkron során hiba történt.',
    }
  }

  if (run.status === 'FAILED') {
    return { overall: 'failed', helper: null }
  }

  if (run.status === 'IMPORT_ONLY') {
    return { overall: 'import-only', helper: null }
  }

  if (run.status === 'SUCCESS') {
    return { overall: 'legacy', helper: null }
  }

  return { overall: 'running', helper: null }
}
