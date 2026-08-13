import { useCallback, useEffect, useMemo, useState } from 'react'

const API_BASE_URL = 'http://localhost:3000'
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

function formatDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function getInitialDates() {
  const today = new Date()
  const from = new Date(today)
  from.setDate(from.getDate() - 14)

  return {
    from: formatDateInput(from),
    to: formatDateInput(today),
    minimum: formatDateInput(
      new Date(today.getTime() - 29 * DAY_MS),
    ),
    today: formatDateInput(today),
  }
}

function getDayDifference(from: string, to: string) {
  const fromDate = new Date(`${from}T00:00:00`)
  const toDate = new Date(`${to}T00:00:00`)

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
      const title =
        status === 'NO_CHANGE'
          ? 'Nem igényelt frissítést'
          : status === 'FAILED'
            ? 'A frissítés sikertelen'
            : action === 'END'
              ? 'Az inaktiválás elindult'
              : action.includes('ACTIVATE') ||
                  action.includes('REACTIVATION')
                ? 'Az aktiválás elindult'
                : action === 'SKIP'
                  ? 'Kimaradt a frissítésből'
                  : status === 'PENDING' ||
                      status === 'REACTIVATION_IN_PROGRESS'
                    ? 'A frissítés feldolgozás alatt van'
                    : 'Sikeresen frissült'

      return { label: 'Szinkron', title, tone: 'sync' }
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

function AllegroHistoryPage() {
  const initialDates = useMemo(() => getInitialDates(), [])
  const [from, setFrom] = useState(initialDates.from)
  const [to, setTo] = useState(initialDates.to)
  const [events, setEvents] = useState<AllegroHistoryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

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
    if (validationError) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({ from, to })
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

      setEvents(body.data)
      setTruncated(body.truncated)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Nem sikerült betölteni az Allegro-előzményeket.',
      )
    } finally {
      setLoading(false)
    }
  }, [from, to, validationError])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const dayGroups = useMemo(() => {
    const groups = new Map<string, AllegroHistoryEvent[]>()

    for (const event of events) {
      const day = getEventDay(event.occurredAt)
      const items = groups.get(day) ?? []
      items.push(event)
      groups.set(day, items)
    }

    return [...groups.entries()]
  }, [events])

  return (
    <div className="allegro-history-page">
      <section className="allegro-history-heading">
        <div>
          <p className="section-label">ALLEGRO</p>
          <h2>Előzmények</h2>
          <p>Az ajánlatok napi, tételes változásai az elmúlt 30 napból.</p>
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

      <section className="allegro-history-content">
        <div className="allegro-history-summary">
          <strong>{loading ? 'Betöltés…' : `${events.length} változás`}</strong>
          <span>{from} – {to}</span>
        </div>

        {!loading && !error && dayGroups.length === 0 && (
          <div className="allegro-history-empty">
            Ebben az időszakban még nincs rögzített változás.
          </div>
        )}

        {dayGroups.map(([day, items]) => (
          <div className="allegro-history-day" key={day}>
            <div className="allegro-history-day-heading">
              <h3>{formatDay(day)}</h3>
              <span>{items.length} változás</span>
            </div>

            <div className="allegro-history-events">
              {items.map((event) => {
                const presentation = getEventPresentation(event)

                return (
                  <article className="allegro-history-event" key={event.id}>
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
                      <span>{formatEventValue(event, event.oldValue)}</span>
                      <b>→</b>
                      <strong>{formatEventValue(event, event.newValue)}</strong>
                    </div>
                    <span className="allegro-history-event-source">
                      {formatSource(event.source)}
                    </span>
                  </article>
                )
              })}
            </div>
          </div>
        ))}

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
