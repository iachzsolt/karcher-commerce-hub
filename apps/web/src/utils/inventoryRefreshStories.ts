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
    confirmedRemoteStock?: number | null
    confirmedPublicationStatus?: string | null
    reconciled?: boolean | null
    taskMessage?: string | null
    taskStatus?: string | null
    commandId?: string | null
    httpStatus?: number | null
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
  /*
   * Only the newest event decides PENDING. Automation
   * events are insert-only, so an old 202/PENDING row
   * would otherwise pin the story to "processing"
   * forever even after the remote state was confirmed
   * (reconciliation confirmation or a newer terminal
   * event supersedes it).
   */
  const latest = ordered[ordered.length - 1]
  const pending =
    !failed &&
    latest !== undefined &&
    isPendingStatus(latest.status)
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
  let resultLabel: string
  let status: ListingStoryStatus = 'none'
  let statusLabel: string
  let skipReason: string | null = null

  if (failed) {
    businessResult = 'FAILED'
    resultLabel = 'Sikertelen'
    status = 'failed'
    statusLabel = 'HIBA'
  } else if (pending) {
    businessResult = 'PENDING'
    resultLabel = 'Allegro feldolgozás alatt'
    status = 'pending'
    statusLabel = 'FELDOLGOZÁS ALATT'
  } else if (manualSkip) {
    businessResult = 'MANUAL_SKIPPED'
    resultLabel = 'Manuálisan inaktív — kihagyva'
    status = 'skipped'
    statusLabel = 'Kihagyva'
    skipReason = 'Manuálisan inaktív'
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
    resultLabel = 'Ajánlat automatikusan lekapcsolva'
    status = 'success'
    statusLabel = 'LEKAPCSOLVA'
  } else if (activated) {
    businessResult = 'ACTIVATED'
    resultLabel =
      'Ajánlat automatikusan visszakapcsolva'
    status = 'success'
    statusLabel = 'VISSZAKAPCSOLVA'
  } else if (stockChanged) {
    businessResult = 'STOCK_UPDATED'
    resultLabel = 'Készlet frissítve'
    status = 'success'
    statusLabel = 'KÉSZLET FRISSÍTVE'
  } else if (!noChange) {
    businessResult = 'STOCK_UPDATED'
    resultLabel = 'Készlet frissítve'
    status = 'success'
    statusLabel = 'KÉSZLET FRISSÍTVE'
  } else {
    resultLabel = 'Nincs teendő'
    statusLabel = 'NINCS TEENDŐ'
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

/*
 * Human-readable business detail lines for one story.
 * PENDING stories use target/intended wording (the values
 * are requested, not confirmed); SUCCESS stories use
 * final wording only where the architecture confirms it
 * (synchronous Allegro task success plus remote readback,
 * or a reconciliation confirmation).
 */
export function describeStoryDetail(
  story: ListingStory,
): string[] {
  const lines: string[] = []
  const formatCount = (value: number | null) =>
    value === null ? '–' : `${value} db`

  if (story.businessResult === 'PENDING') {
    if (
      story.stockFrom !== null ||
      story.stockTo !== null
    ) {
      if (
        story.stockFrom !== null &&
        story.stockTo !== null &&
        story.stockFrom !== story.stockTo
      ) {
        lines.push(
          `Készletmódosítás: ${story.stockFrom} → ${story.stockTo} db`,
        )
      } else if (story.stockTo !== null) {
        lines.push(
          `Célkészlet: ${formatCount(story.stockTo)}`,
        )
      }
    }

    let latestPublication: string | null =
      null

    for (
      let index = story.events.length - 1;
      index >= 0;
      index -= 1
    ) {
      const candidate =
        story.events[index]?.metadata
          ?.publicationStatus ?? null

      if (candidate !== null) {
        latestPublication = candidate
        break
      }
    }

    if (latestPublication === 'ACTIVE') {
      lines.push(
        'Ajánlat jelenlegi státusza: Aktív',
      )
    } else if (latestPublication !== null) {
      lines.push(
        `Ajánlat jelenlegi státusza: ${latestPublication}`,
      )
    }

    return lines
  }

  if (
    story.businessResult === 'STOCK_UPDATED' ||
    story.businessResult === 'AUTO_PAUSED' ||
    story.businessResult === 'ACTIVATED'
  ) {
    if (
      story.stockFrom !== null &&
      story.stockTo !== null
    ) {
      lines.push(
        `Készlet: ${story.stockFrom} → ${story.stockTo} db`,
      )
    }

    const firstPublication = story.events
      .map(
        (event) =>
          event.metadata?.publicationStatus ??
          null,
      )
      .find((value) => value !== null)

    if (story.businessResult === 'STOCK_UPDATED') {
      if (firstPublication === 'ACTIVE') {
        lines.push('Ajánlat: aktív maradt')
      }
    } else if (
      story.businessResult === 'AUTO_PAUSED'
    ) {
      lines.push(
        firstPublication !== null
          ? `Ajánlat: ${firstPublication} → INACTIVE`
          : 'Ajánlat: INACTIVE',
      )
    } else if (
      story.businessResult === 'ACTIVATED'
    ) {
      lines.push(
        firstPublication !== null &&
          firstPublication !== 'ACTIVE'
          ? `Ajánlat: ${firstPublication} → ACTIVE`
          : 'Ajánlat: ACTIVE',
      )
    }

    return lines
  }

  if (story.businessResult === 'NO_ACTION') {
    if (
      story.stockFrom !== null &&
      story.stockTo !== null &&
      story.stockFrom === story.stockTo
    ) {
      lines.push('Készlet már megfelelő')
      lines.push(
        `Aktuális készlet: ${formatCount(story.stockFrom)}`,
      )
    } else {
      lines.push('Nem szükséges ajánlatmódosítás')
    }

    return lines
  }

  return lines
}

export type StorySummary = {
  total: number
  affected: number
  stockChanged: number
  stockUpdated: number
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
    stockUpdated: 0,
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
        summary.stockUpdated += 1
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
  | 'interrupted'

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

  if (run.status === 'INTERRUPTED') {
    return {
      overall: 'interrupted',
      helper:
        'A futást a runtime leállása szakította meg. A forrásimport hiteles adatait az alábbi kapcsolt import futás mutatja.',
    }
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
