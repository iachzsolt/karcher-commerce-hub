import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_URL } from '../config/api'
const DAY_MS = 24 * 60 * 60 * 1000

type AllegroHistoryEvent = {
  id: string
  eventType: 'PRICE' | 'STOCK' | 'STATUS' | 'CAMPAIGN' | string
  source: string
  oldValue: string | null
  newValue: string | null
  currency: string | null
  externalCampaignId: string | null
  metadataJson: string | null
  occurredAt: string
  listingId: string
  offerId: string
  sku: string
  listingName: string
}

type AllegroHistoryResponse = {
  status: 'ok'
  period: {
    from: string
    to: string
    timeZone: string
  }
  count: number
  truncated: boolean
  data: AllegroHistoryEvent[]
}

type CatalogSyncRun = {
  id: string
  trigger: 'AUTOMATIC' | 'MANUAL'
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'
  totalOffers: number
  newOffers: number
  renamedOffers: number
  offersWithoutSku: number
  syncedOffers: number
  initializedBaselines: number
  error: string | null
  startedAt: string
  finishedAt: string | null
}

type CatalogSyncRunsResponse = {
  status: 'ok'
  runs: CatalogSyncRun[]
}

type InventoryRefreshRun = {
  id: string
  connectionName: string
  triggerType: string
  status:
    | 'RUNNING'
    | 'COMPLETED'
    | 'IMPORT_ONLY'
    | 'SUCCESS'
    | 'FAILED'
  importStatus: string | null
  rowsImported: number
  changedItemCount: number
  error: string | null
  startedAt: string
  finishedAt: string | null
}

type InventoryRefreshRunsResponse = {
  status: 'ok'
  runs: InventoryRefreshRun[]
}

type SyncMetadata = {
  historyGroupId?: string | null
  publicationStatus?: string | null
  targetStock?: number | null
  remoteStock?: number | null
  fromStock?: number | null
  toStock?: number | null
}

function summarizeSyncEvents(events: AllegroHistoryEvent[]) {
  let stockIncreased = 0
  let stockDecreased = 0
  let unchanged = 0
  let activated = 0
  let inactivated = 0
  let skipped = 0
  let pending = 0
  let failed = 0

  for (const event of events) {
    const metadata = getSyncMetadata(event)
    const action = event.oldValue ?? ''
    const status = event.newValue ?? ''

    if (
      status === 'SUCCESS' &&
      metadata?.fromStock !== null &&
      metadata?.fromStock !== undefined &&
      metadata?.toStock !== null &&
      metadata?.toStock !== undefined
    ) {
      if (metadata.toStock > metadata.fromStock) stockIncreased++
      if (metadata.toStock < metadata.fromStock) stockDecreased++
    }

    if (status === 'NO_CHANGE' || status === 'ALREADY_AUTO_PAUSED') unchanged++
    if (
      status === 'SUCCESS' &&
      (action.includes('ACTIVATE') || action.includes('REACTIVATION'))
    ) activated++
    if (
      status === 'SUCCESS' &&
      (action === 'END' || action === 'ADOPT_AUTO_PAUSE')
    ) inactivated++
    if (action === 'SKIP') skipped++
    if (status === 'PENDING' || status === 'REACTIVATION_IN_PROGRESS') pending++
    if (status === 'FAILED') failed++
  }

  return {
    total: events.length,
    stockIncreased,
    stockDecreased,
    unchanged,
    activated,
    inactivated,
    skipped,
    pending,
    failed,
  }
}

type HistoryDayItem =
  | {
      kind: 'event-group'
      occurredAt: string
      events: AllegroHistoryEvent[]
    }
  | {
      kind: 'sync-group'
      occurredAt: string
      groupId: string
      events: AllegroHistoryEvent[]
    }
  | {
      kind: 'catalog-sync'
      occurredAt: string
      run: CatalogSyncRun
    }
  | {
      kind: 'inventory-refresh'
      occurredAt: string
      run: InventoryRefreshRun
    }

function groupDayEvents(
  items: AllegroHistoryEvent[],
  catalogSyncRuns: CatalogSyncRun[],
  inventoryRefreshRuns: InventoryRefreshRun[],
): HistoryDayItem[] {
  const regularEvents: AllegroHistoryEvent[] = []
  const syncGroups = new Map<string, AllegroHistoryEvent[]>()

  for (const event of items) {
    const historyGroupId = getSyncMetadata(event)?.historyGroupId

    if (event.eventType !== 'SYNC' || !historyGroupId) {
      regularEvents.push(event)
      continue
    }

    const group = syncGroups.get(historyGroupId) ?? []
    group.push(event)
    syncGroups.set(historyGroupId, group)
  }

  regularEvents.sort(
    (left, right) =>
      new Date(right.occurredAt).getTime() -
      new Date(left.occurredAt).getTime(),
  )

  return [
    ...(regularEvents.length > 0
      ? [{
          kind: 'event-group' as const,
          occurredAt: regularEvents[0].occurredAt,
          events: regularEvents,
        }]
      : []),
    ...[...syncGroups.entries()].map(
      ([groupId, events]): HistoryDayItem => ({
        kind: 'sync-group',
        occurredAt: events[0].occurredAt,
        groupId,
        events,
      }),
    ),
    ...catalogSyncRuns.map((run): HistoryDayItem => ({
      kind: 'catalog-sync',
      occurredAt: run.startedAt,
      run,
    })),
    ...inventoryRefreshRuns.map((run): HistoryDayItem => ({
      kind: 'inventory-refresh',
      occurredAt: run.startedAt,
      run,
    })),
  ].sort(
    (left, right) =>
      new Date(right.occurredAt).getTime() -
      new Date(left.occurredAt).getTime(),
  )
}

function getSyncMetadata(event: AllegroHistoryEvent): SyncMetadata | null {
  if (event.eventType !== 'SYNC' || !event.metadataJson) return null

  try {
    return JSON.parse(event.metadataJson) as SyncMetadata
  } catch {
    return null
  }
}

function getBudapestDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value

  return `${value('year')}-${value('month')}-${value('day')}`
}

function shiftDateInput(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function getInitialDates() {
  const today = getBudapestDateInputValue()

  return {
    from: shiftDateInput(today, -14),
    to: today,
    minimum: shiftDateInput(today, -29),
    today,
  }
}

function getDayDifference(from: string, to: string) {
  const fromDate = new Date(`${from}T00:00:00Z`)
  const toDate = new Date(`${to}T00:00:00Z`)

  return Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS)
}

function getEventDay(value: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(`${value}T12:00:00Z`))
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatMoneyMinor(value: string | null, currency: string | null) {
  if (value === null) return '—'

  const amount = Number(value) / 100

  if (!Number.isFinite(amount)) return value

  return new Intl.NumberFormat('hu-HU', {
    style: 'currency',
    currency: currency ?? 'HUF',
    maximumFractionDigits: 0,
  }).format(amount)
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Aktív',
  ACTIVATING: 'Aktiválás alatt',
  INACTIVE: 'Inaktív',
  ENDED: 'Lezárt',
  UNKNOWN: 'Ismeretlen',
  FINISHED: 'Lezárva',
  DECLINED: 'Elutasítva',
  IN_VERIFICATION: 'Ellenőrzés alatt',
  WAITING_FOR_PUBLICATION: 'Publikálásra vár',
  AWAITING_BADGE: 'Kampányjelvényre vár',
  FINISHING: 'Lezárás alatt',
}

const SYNC_ACTION_LABELS: Record<string, string> = {
  NONE: 'Ellenőrzés',
  SKIP: 'Kihagyás',
  STOCK_UPDATE: 'Készletfrissítés',
  END: 'Inaktiválás',
  ACTIVATE: 'Aktiválás',
  ADOPT_AUTO_PAUSE: 'Automatikus szüneteltetés',
  STOCK_UPDATE_AND_ACTIVATE: 'Készletfrissítés és aktiválás',
  STOCK_UPDATE_AND_REACTIVATION_CONFIRMED: 'Készletfrissítés és aktiválás',
  REACTIVATION_CONFIRMED: 'Aktiválás megerősítve',
}

const SYNC_STATUS_LABELS: Record<string, string> = {
  SUCCESS: 'Sikeres',
  NO_CHANGE: 'Nem változott',
  PENDING: 'Feldolgozás alatt',
  FAILED: 'Sikertelen',
  REACTIVATION_IN_PROGRESS: 'Aktiválás alatt',
  ALREADY_AUTO_PAUSED: 'Már inaktív',
  MANUAL_INACTIVE: 'Kézzel inaktiválva',
  STOCK_LOCKED: 'Készlet zárolva',
  DUPLICATE_SKU: 'Duplikált SKU',
  TARGET_STOCK_UNKNOWN: 'Nincs célkészlet',
  REMOTE_STOCK_UNKNOWN: 'Az Allegro-készlet ismeretlen',
  UNSUPPORTED_PUBLICATION_STATE: 'Nem támogatott állapot',
}

function formatEventValue(event: AllegroHistoryEvent, value: string | null) {
  if (event.eventType === 'PRICE') {
    return formatMoneyMinor(value, event.currency)
  }

  if (event.eventType === 'STATUS' || event.eventType === 'CAMPAIGN') {
    return value ? STATUS_LABELS[value] ?? value : '—'
  }

  if (event.eventType === 'SYNC') {
    if (!value) return '—'

    return (
      SYNC_ACTION_LABELS[value] ??
      SYNC_STATUS_LABELS[value] ??
      value
    )
  }

  return value ?? '—'
}

function getEventPresentation(event: AllegroHistoryEvent) {
  switch (event.eventType) {
    case 'PRICE':
      return { label: 'Ár', title: 'Az ajánlat ára megváltozott', tone: 'price' }
    case 'STOCK':
      return { label: 'Készlet', title: 'A készlet megváltozott', tone: 'stock' }
    case 'STATUS':
      return { label: 'Állapot', title: 'Az ajánlat állapota megváltozott', tone: 'status' }
    case 'CAMPAIGN':
      return { label: 'Kampány', title: 'A kampánystátusz megváltozott', tone: 'campaign' }
    case 'SYNC': {
      const action = event.oldValue ?? ''
      const status = event.newValue ?? ''
      const metadata = getSyncMetadata(event)
      const hasStockChange =
        metadata?.fromStock !== null &&
        metadata?.fromStock !== undefined &&
        metadata?.toStock !== null &&
        metadata?.toStock !== undefined &&
        metadata.fromStock !== metadata.toStock
      const title =
        status === 'NO_CHANGE'
          ? 'Nem igényelt frissítést'
          : status === 'FAILED'
            ? 'A frissítés sikertelen'
            : status === 'PENDING' ||
                status === 'REACTIVATION_IN_PROGRESS'
              ? 'A frissítés feldolgozás alatt van'
              : status === 'SUCCESS' &&
                  (action === 'END' || action === 'ADOPT_AUTO_PAUSE')
                ? 'Sikeresen inaktiválva'
                : status === 'SUCCESS' &&
                    (action.includes('ACTIVATE') ||
                      action.includes('REACTIVATION'))
                  ? 'Sikeresen aktiválva'
                  : action === 'SKIP'
                    ? 'Kimaradt a frissítésből'
                    : 'Sikeresen frissült'

      return {
        label: hasStockChange ? 'Készlet' : 'Szinkron',
        title,
        tone: hasStockChange ? 'stock' : 'sync',
      }
    }
    default:
      return { label: 'Változás', title: 'Az ajánlat adata megváltozott', tone: 'default' }
  }
}

function formatSource(source: string) {
  if (source === 'ALLEGRO_CAMPAIGN_SYNC') return 'Kampányszinkron'
  if (source === 'ALLEGRO_CAMPAIGN') return 'Allegro-kampány'
  if (source === 'ALLEGRO_SYNC') return 'Allegro-szinkron'
  if (source === 'AUTOMATION') return 'Automatika'
  if (source === 'INVENTORY_AUTOMATION') return 'Készletautomatika'
  if (source === 'MANUAL') return 'Kézi művelet'

  return source
}

function HistoryEventRow({ event }: { event: AllegroHistoryEvent }) {
  const presentation = getEventPresentation(event)
  const syncMetadata = getSyncMetadata(event)
  const hasStockChange =
    syncMetadata?.fromStock !== null &&
    syncMetadata?.fromStock !== undefined &&
    syncMetadata?.toStock !== null &&
    syncMetadata?.toStock !== undefined &&
    syncMetadata.fromStock !== syncMetadata.toStock
  const oldValue = hasStockChange
    ? String(syncMetadata.fromStock)
    : formatEventValue(event, event.oldValue)
  const newValue = hasStockChange
    ? String(syncMetadata.toStock)
    : formatEventValue(event, event.newValue)

  return (
    <article className="allegro-history-event">
      <time>{formatTime(event.occurredAt)}</time>
      <span
        className={`allegro-history-event-type is-${presentation.tone}`}
      >
        {presentation.label}
      </span>
      <div className="allegro-history-event-main">
        <strong>{presentation.title}</strong>
        <span>{event.listingName}</span>
        <small>SKU: {event.sku} · Ajánlat: {event.offerId}</small>
      </div>
      <div className="allegro-history-event-change">
        <span>{oldValue}</span>
        <b>→</b>
        <strong>{newValue}</strong>
      </div>
      <span className="allegro-history-event-source">
        {formatSource(event.source)}
      </span>
    </article>
  )
}

type HistoryRunTone = 'success' | 'failed' | 'pending' | 'neutral'

function HistoryRunSummary({
  title,
  subtitle,
  status,
  tone,
  changeLabel,
}: {
  title: string
  subtitle: string
  status: string
  tone: HistoryRunTone
  changeLabel: string
}) {
  return (
    <summary className="allegro-history-run-summary">
      <div className="allegro-history-run-title">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="allegro-history-run-overview">
        <span className={`allegro-history-run-status is-${tone}`}>
          {status}
        </span>
        <strong>{changeLabel}</strong>
        <span className="allegro-history-run-toggle">Részletek</span>
      </div>
    </summary>
  )
}

function SyncHistoryGroup({ events }: { events: AllegroHistoryEvent[] }) {
  const summary = summarizeSyncEvents(events)
  const changeCount = events.filter((event) => {
    const action = event.oldValue ?? ''

    return (
      event.newValue === 'SUCCESS' &&
      action !== 'NONE' &&
      action !== 'SKIP'
    )
  }).length
  const tone: HistoryRunTone =
    summary.failed > 0
      ? 'failed'
      : summary.pending > 0
        ? 'pending'
        : 'neutral'
  const status =
    summary.failed > 0
      ? 'Hibás tétel'
      : summary.pending > 0
        ? 'Függő tétel'
        : 'Rögzítve'
  const metrics = [
    ['Vizsgált ajánlat', summary.total, 'total'],
    ['Készlet nőtt', summary.stockIncreased, 'positive'],
    ['Készlet csökkent', summary.stockDecreased, 'negative'],
    ['Nem változott', summary.unchanged, 'neutral'],
    ['Aktiválva', summary.activated, 'positive'],
    ['Inaktiválva', summary.inactivated, 'negative'],
    ['Kihagyva', summary.skipped, 'warning'],
    ['Függőben', summary.pending, 'warning'],
    ['Sikertelen', summary.failed, 'negative'],
  ] as const

  return (
    <details className="allegro-history-run allegro-history-sync-group">
      <HistoryRunSummary
        title="Készletautomatika eseményei"
        subtitle={formatTime(events[0].occurredAt)}
        status={status}
        tone={tone}
        changeLabel={`${changeCount} változás`}
      />
      <div className="allegro-history-run-details">
        <div className="allegro-history-sync-metrics">
          {metrics.map(([label, value, tone]) =>
            value > 0 || tone === 'total' ? (
              <span
                className={`allegro-history-sync-metric is-${tone}`}
                key={label}
              >
                {label}: <strong>{value}</strong>
              </span>
            ) : null,
          )}
        </div>
        <div className="allegro-history-events">
          {events.map((event) => (
            <HistoryEventRow event={event} key={event.id} />
          ))}
        </div>
      </div>
    </details>
  )
}

function EventHistoryGroup({ events }: { events: AllegroHistoryEvent[] }) {
  return (
    <details className="allegro-history-run">
      <HistoryRunSummary
        title="Részletes ajánlatváltozások"
        subtitle={formatTime(events[0].occurredAt)}
        status="Rögzítve"
        tone="neutral"
        changeLabel={`${events.length} változás`}
      />
      <div className="allegro-history-run-details allegro-history-events">
        {events.map((event) => (
          <HistoryEventRow event={event} key={event.id} />
        ))}
      </div>
    </details>
  )
}

function CatalogSyncHistoryGroup({ run }: { run: CatalogSyncRun }) {
  const tone: HistoryRunTone =
    run.status === 'SUCCESS'
      ? 'success'
      : run.status === 'FAILED'
        ? 'failed'
        : run.status === 'RUNNING'
          ? 'pending'
          : 'neutral'
  const status =
    run.status === 'SUCCESS'
      ? 'Sikeres'
      : run.status === 'FAILED'
        ? 'Sikertelen'
        : run.status === 'RUNNING'
          ? 'Folyamatban'
          : 'Kihagyva'
  const metrics = [
    ['Allegro-ajánlat', run.totalOffers],
    ['Új ajánlat', run.newOffers],
    ['Átnevezve', run.renamedOffers],
    ['Szinkronizálva', run.syncedOffers],
    ['Cikkszám nélkül', run.offersWithoutSku],
    ['Alapállapot rögzítve', run.initializedBaselines],
  ] as const

  return (
    <details className="allegro-history-run">
      <HistoryRunSummary
        title="Katalógusszinkron"
        subtitle={`${formatTime(run.startedAt)} · ${run.trigger === 'MANUAL' ? 'kézi' : 'automatikus'}`}
        status={status}
        tone={tone}
        changeLabel={
          run.status === 'SUCCESS'
            ? `${run.newOffers + run.renamedOffers} változás`
            : 'változás nem ismert'
        }
      />
      <div className="allegro-history-run-details">
        {run.status === 'SUCCESS' ? (
          <div className="allegro-history-sync-metrics">
            {metrics.map(([label, value]) => (
              <span className="allegro-history-sync-metric" key={label}>
                {label}: <strong>{value}</strong>
              </span>
            ))}
          </div>
        ) : !run.error ? (
          <p className="allegro-history-run-note">
            Ehhez a futáshoz nincs végleges változásösszesítés.
          </p>
        ) : null}
        {run.error && (
          <p className="allegro-history-run-error">{run.error}</p>
        )}
      </div>
    </details>
  )
}

function InventoryRefreshHistoryGroup({
  run,
  now,
}: {
  run: InventoryRefreshRun
  now: number
}) {
  const isStale =
    run.status === 'RUNNING' &&
    now - new Date(run.startedAt).getTime() > 2 * 60 * 60 * 1000
  const tone: HistoryRunTone =
    run.status === 'COMPLETED'
      ? 'success'
      : run.status === 'FAILED' || isStale
        ? 'failed'
        : run.status === 'SUCCESS' || run.status === 'IMPORT_ONLY'
          ? 'neutral'
          : 'pending'
  const status =
    run.status === 'COMPLETED'
      ? 'Sikeres'
      : run.status === 'FAILED'
        ? 'Sikertelen'
        : run.status === 'IMPORT_ONLY'
          ? 'Csak beolvasás'
          : run.status === 'SUCCESS'
            ? 'Nem ellenőrizhető'
            : isStale
              ? 'Megszakadt'
              : 'Folyamatban'
  const metrics = [
    ['Importált sor', run.rowsImported],
    ['Forrásváltozás', run.changedItemCount],
  ] as const

  return (
    <details className="allegro-history-run">
      <HistoryRunSummary
        title={
          run.triggerType === 'SCHEDULED'
            ? 'Ütemezett készletfutás'
            : 'Készletforrás-frissítés'
        }
        subtitle={`${formatTime(run.startedAt)} · ${run.triggerType === 'SCHEDULED' ? 'automatikus' : 'kézi'}`}
        status={status}
        tone={tone}
        changeLabel={`${run.changedItemCount} változás`}
      />
      <div className="allegro-history-run-details">
        <div className="allegro-history-sync-metrics">
          {metrics.map(([label, value]) => (
            <span className="allegro-history-sync-metric" key={label}>
              {label}: <strong>{value}</strong>
            </span>
          ))}
          {run.importStatus && (
            <span className="allegro-history-sync-metric">
              Import: <strong>{run.importStatus}</strong>
            </span>
          )}
          <span className="allegro-history-sync-metric">
            Befejezés:{' '}
            <strong>{run.finishedAt ? formatTime(run.finishedAt) : 'nincs rögzítve'}</strong>
          </span>
        </div>
        {run.error && (
          <p className="allegro-history-run-error">{run.error}</p>
        )}
      </div>
    </details>
  )
}

function AllegroHistoryPage() {
  const initialDates = useMemo(() => getInitialDates(), [])
  const [from, setFrom] = useState(initialDates.from)
  const [to, setTo] = useState(initialDates.to)
  const [events, setEvents] = useState<AllegroHistoryEvent[]>([])
  const [catalogSyncRuns, setCatalogSyncRuns] = useState<CatalogSyncRun[]>([])
  const [inventoryRefreshRuns, setInventoryRefreshRuns] =
    useState<InventoryRefreshRun[]>([])
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const latestRequestId = useRef(0)

  const validationError = useMemo(() => {
    if (!from || !to) return 'Add meg a kezdő és záró dátumot.'

    const difference = getDayDifference(from, to)

    if (difference < 0) return 'A kezdő dátum nem lehet későbbi a záró dátumnál.'
    if (difference > 29) return 'Legfeljebb 30 napos időszak választható.'
    if (from < initialDates.minimum) return 'Csak az elmúlt 30 nap előzményei érhetők el.'
    if (to > initialDates.today) return 'A záró dátum nem lehet későbbi a mai napnál.'

    return null
  }, [from, initialDates, to])

  const loadHistory = useCallback(async () => {
    const requestId = latestRequestId.current + 1
    latestRequestId.current = requestId

    if (validationError) {
      setEvents([])
      setCatalogSyncRuns([])
      setInventoryRefreshRuns([])
      setTruncated(false)
      setError(null)
      setWarning(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    setWarning(null)
    setEvents([])
    setCatalogSyncRuns([])
    setInventoryRefreshRuns([])
    setTruncated(false)

    try {
      const params = new URLSearchParams({ from, to })
      const supplementalRequests = Promise.allSettled([
        fetch(
          `${API_BASE_URL}/allegro/catalog-sync-runs?${params.toString()}`,
        ),
        fetch(
          `${API_BASE_URL}/allegro/inventory-refresh-runs?${params.toString()}`,
        ),
      ])

      const response = await fetch(
        `${API_BASE_URL}/allegro/history?${params.toString()}`,
      )
      const body = (await response.json()) as
        | AllegroHistoryResponse
        | { message?: string }

      if (!response.ok || !('status' in body) || body.status !== 'ok') {
        throw new Error(
          'message' in body && body.message
            ? body.message
            : 'Nem sikerült betölteni az Allegro-előzményeket.',
        )
      }

      let nextCatalogRuns: CatalogSyncRun[] = []
      let nextInventoryRuns: InventoryRefreshRun[] = []
      let hasSupplementalError = false

      if (requestId !== latestRequestId.current) return

      setEvents(body.data)
      setTruncated(body.truncated)
      setLoadedAt(Date.now())
      setLoading(false)

      const [catalogRequest, inventoryRequest] = await supplementalRequests

      if (
        catalogRequest.status === 'fulfilled' &&
        catalogRequest.value.ok
      ) {
        try {
          const catalogBody =
            (await catalogRequest.value.json()) as CatalogSyncRunsResponse

          if (catalogBody.status === 'ok' && Array.isArray(catalogBody.runs)) {
            nextCatalogRuns = catalogBody.runs
          } else {
            hasSupplementalError = true
          }
        } catch {
          hasSupplementalError = true
        }
      } else {
        hasSupplementalError = true
      }

      if (
        inventoryRequest.status === 'fulfilled' &&
        inventoryRequest.value.ok
      ) {
        try {
          const inventoryBody =
            (await inventoryRequest.value
              .json()) as InventoryRefreshRunsResponse

          if (
            inventoryBody.status === 'ok' &&
            Array.isArray(inventoryBody.runs)
          ) {
            nextInventoryRuns = inventoryBody.runs
          } else {
            hasSupplementalError = true
          }
        } catch {
          hasSupplementalError = true
        }
      } else {
        hasSupplementalError = true
      }

      if (requestId !== latestRequestId.current) return

      setCatalogSyncRuns(nextCatalogRuns)
      setInventoryRefreshRuns(nextInventoryRuns)
      setWarning(
        hasSupplementalError
          ? 'Az események betöltődtek, de egyes futásösszesítések nem érhetők el.'
          : null,
      )
    } catch (loadError) {
      if (requestId !== latestRequestId.current) return

      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Nem sikerült betölteni az Allegro-előzményeket.',
      )
    } finally {
      if (requestId === latestRequestId.current) {
        setLoading(false)
      }
    }
  }, [from, to, validationError])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadHistory()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
      latestRequestId.current += 1
    }
  }, [loadHistory])

  const dayGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        events: AllegroHistoryEvent[]
        catalogSyncRuns: CatalogSyncRun[]
        inventoryRefreshRuns: InventoryRefreshRun[]
      }
    >()

    const getGroup = (day: string) => {
      const existing = groups.get(day)

      if (existing) return existing

      const created = {
        events: [],
        catalogSyncRuns: [],
        inventoryRefreshRuns: [],
      }
      groups.set(day, created)
      return created
    }

    for (const event of events) {
      const day = getEventDay(event.occurredAt)
      getGroup(day).events.push(event)
    }

    for (const run of catalogSyncRuns) {
      const day = getEventDay(run.startedAt)

      if (day >= from && day <= to) {
        getGroup(day).catalogSyncRuns.push(run)
      }
    }

    for (const run of inventoryRefreshRuns) {
      const day = getEventDay(run.startedAt)

      if (day >= from && day <= to) {
        getGroup(day).inventoryRefreshRuns.push(run)
      }
    }

    return [...groups.entries()].sort(([left], [right]) =>
      right.localeCompare(left),
    )
  }, [catalogSyncRuns, events, from, inventoryRefreshRuns, to])

  const historyEntryCount = useMemo(
    () =>
      dayGroups.reduce(
        (total, [, group]) =>
          total +
          groupDayEvents(
            group.events,
            group.catalogSyncRuns,
            group.inventoryRefreshRuns,
          ).length,
        0,
      ),
    [dayGroups],
  )

  return (
    <div className="allegro-history-page">
      <section className="allegro-history-heading">
        <div>
          <p className="section-label">ALLEGRO</p>
          <h2>Előzmények</h2>
          <p>Frissítési összesítések; a tételes változások kattintásra nyithatók meg.</p>
        </div>

        <div className="allegro-history-filter">
          <label>
            <span>Kezdő dátum</span>
            <input
              type="date"
              min={initialDates.minimum}
              max={to || initialDates.today}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <span className="allegro-history-filter-separator">–</span>
          <label>
            <span>Záró dátum</span>
            <input
              type="date"
              min={from || initialDates.minimum}
              max={initialDates.today}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
      </section>

      {validationError && (
        <div className="allegro-overview-message allegro-overview-message-error">
          {validationError}
        </div>
      )}

      {error && (
        <div className="allegro-overview-message allegro-overview-message-error">
          <span>{error}</span>
          <button type="button" onClick={() => void loadHistory()}>
            Újrapróbálás
          </button>
        </div>
      )}

      {warning && (
        <div className="allegro-overview-message allegro-overview-message-warning">
          {warning}
        </div>
      )}

      <section className="allegro-history-content">
        <div className="allegro-history-summary">
          <strong>{loading ? 'Betöltés…' : `${historyEntryCount} bejegyzés`}</strong>
          <span>{from} – {to}</span>
        </div>

        {!loading && !error && dayGroups.length === 0 && (
          <div className="allegro-history-empty">
            Ebben az időszakban még nincs rögzített változás.
          </div>
        )}

        {dayGroups.map(([day, group]) => {
          const grouped = groupDayEvents(
            group.events,
            group.catalogSyncRuns,
            group.inventoryRefreshRuns,
          )

          return (
            <div className="allegro-history-day" key={day}>
              <div className="allegro-history-day-heading">
                <h3>{formatDay(day)}</h3>
                <span>{grouped.length} bejegyzés</span>
              </div>

              {grouped.map((item) => {
                if (item.kind === 'event-group') {
                  return (
                    <EventHistoryGroup
                      events={item.events}
                      key={`events-${item.occurredAt}`}
                    />
                  )
                }

                if (item.kind === 'sync-group') {
                  return (
                    <SyncHistoryGroup
                      events={item.events}
                      key={item.groupId}
                    />
                  )
                }

                if (item.kind === 'catalog-sync') {
                  return (
                    <CatalogSyncHistoryGroup
                      run={item.run}
                      key={`catalog-${item.run.id}`}
                    />
                  )
                }

                return (
                  <InventoryRefreshHistoryGroup
                    run={item.run}
                    now={loadedAt}
                    key={`inventory-${item.run.id}`}
                  />
                )
              })}
            </div>
          )
        })}

        {truncated && (
          <div className="allegro-history-limit-note">
            Az időszak első 20 000, legfrissebb változása látható.
          </div>
        )}
      </section>
    </div>
  )
}

export default AllegroHistoryPage
