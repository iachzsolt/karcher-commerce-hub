import { useEffect, useState } from 'react'
import '../CommerceHub.css'
import { API_BASE_URL } from '../config/api'

type HealthResponse = {
  status: string
  service: string
  environment: string
  timestamp: string
}

type Platform = {
  id: string
  code: string
  name: string
  active: boolean
  createdAt: string
}

type ProductIdentifier = {
  id: string
  type: 'EAN' | 'MANUFACTURER_SKU' | 'SAP_ID' | 'OTHER'
  value: string
}

type Product = {
  id: string
  sku: string
  name: string
  productLine: 'HG' | 'PROFESSIONAL' | 'UNASSIGNED'
  category: string | null
  active: boolean
  createdAt: string
  updatedAt: string
  identifiers: ProductIdentifier[]
}

type AllegroListing = {
  id: string
  offerId: string
  marketplace: string
  categoryId: string | null
  sku: string
  productName: string
  accountName: string
  environment: string
  priceMinor: number | null
  currency: string
  stockAvailable: number | null
  stockSold: number | null
  publicationStatus:
    | 'ACTIVE'
    | 'ACTIVATING'
    | 'INACTIVE'
    | 'ENDED'
    | 'UNKNOWN'
  lastSyncedAt: string | null

  desiredPriceMinor: number | null
  desiredStock: number | null

  desiredPublicationStatus:
    | 'ACTIVE'
    | 'ACTIVATING'
    | 'INACTIVE'
    | 'ENDED'
    | 'UNKNOWN'
    | null

  priceLocked: boolean | null
  stockLocked: boolean | null
  stockAutoPaused: boolean | null
  inventorySourceStock: number | null
  inventorySourceMissing: boolean | null

  autoPriceSync: boolean | null
  autoStockSync: boolean | null

  acceptedPriceMinor: number | null
  acceptedStockAvailable: number | null

  acceptedPublicationStatus:
    | 'ACTIVE'
    | 'ACTIVATING'
    | 'INACTIVE'
    | 'ENDED'
    | 'UNKNOWN'
    | null

  acceptedAt: string | null
}

type PlatformResponse = {
  status: string
  count: number
  data: Platform[]
}

type ProductResponse = {
  status: string
  count: number
  data: Product[]
}

type AllegroListingResponse = {
  status: string
  count: number
  data: AllegroListing[]
}

type PriceHistorySummary = {
  listingId: string
  min30PriceMinor: number | null
  observationCount: number
  coverageDayCount: number
  missingDayCount: number
  historyStartedAt: string | null
  hasFull30DayWindow: boolean
}

type PriceHistorySummaryResponse = {
  status: string
  data: PriceHistorySummary[]
}

type ListingPriceSchedule = {
  id: string
  listingId: string
  promotionalPriceMinor: number
  validFrom: string
  validTo: string
  enabled: boolean
  startAppliedAt: string | null
  endAppliedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  scheduleStatus:
    | 'SCHEDULED'
    | 'ACTIVE'
    | 'EXPIRED'
    | 'DISABLED'
}

type ListingPriceScheduleResponse = {
  status: string
  count: number
  data: ListingPriceSchedule[]
}

type AllegroImportIssue = {
  offerId: string
  name: string
  issue:
    | 'MISSING_HU_MARKETPLACE'
    | 'MISSING_SKU'
}

type AllegroImportIssueResponse = {
  status: string
  count: number
  data: AllegroImportIssue[]
}

type ServiceStatus = {
  name: string
  description: string
  status: 'working' | 'prepared' | 'disconnected'
}

function formatProductLine(value: Product['productLine']) {
  if (value === 'HG') return 'H&G'
  if (value === 'PROFESSIONAL') return 'Professional'
  return 'Nincs besorolva'
}

function statusLabel(status: ServiceStatus['status']) {
  if (status === 'working') return 'Működik'
  if (status === 'prepared') return 'Előkészítve'
  return 'Nincs csatlakoztatva'
}

function getPrimaryEan(product: Product) {
  return (
    product.identifiers.find(
      (identifier) => identifier.type === 'EAN',
    )?.value ?? '–'
  )
}

function formatMoney(
  priceMinor: number | null,
  currency: string,
) {
  if (priceMinor === null) {
    return '–'
  }

  return new Intl.NumberFormat('hu-HU', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'HUF' ? 0 : 2,
  }).format(priceMinor / 100)
}

function formatListingStatus(
  status: AllegroListing['publicationStatus'],
) {
  if (status === 'ACTIVE') return 'Aktív'
  if (status === 'ACTIVATING') return 'Aktiválás alatt'
  if (status === 'INACTIVE') return 'Inaktív'
  if (status === 'ENDED') return 'Lejárt'
  return 'Ismeretlen'
}

function formatDate(value: string | null) {
  if (!value) {
    return '–'
  }

  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

type HomePageProps = {
  view?: 'home' | 'allegroOffers'
}

function getRelevantPriceSchedule(
  schedules: ListingPriceSchedule[],
) {
  return (
    schedules.find(
      (schedule) =>
        schedule.scheduleStatus === 'ACTIVE',
    ) ??
    schedules.find(
      (schedule) =>
        schedule.scheduleStatus === 'SCHEDULED',
    ) ??
    null
  )
}

function formatPriceScheduleDiscount(
  regularPriceMinor: number | null,
  promotionalPriceValue: string,
) {
  if (
    regularPriceMinor === null ||
    regularPriceMinor <= 0 ||
    !promotionalPriceValue
  ) {
    return '–'
  }

  const promotionalPrice = Number(
    promotionalPriceValue.replace(',', '.'),
  )

  if (
    !Number.isFinite(promotionalPrice) ||
    promotionalPrice <= 0
  ) {
    return '–'
  }

  const promotionalPriceMinor =
    Math.round(promotionalPrice * 100)

  const discount =
    ((regularPriceMinor - promotionalPriceMinor) /
      regularPriceMinor) *
    100

  return `${new Intl.NumberFormat(
    'hu-HU',
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    },
  ).format(discount)}%`
}

function getPriceScheduleControl(
  regularPriceMinor: number | null,
  min30PriceMinor: number | null | undefined,
  hasFull30DayWindow: boolean | undefined,
  promotionalPriceValue: string,
) {
  if (!promotionalPriceValue) {
    return null
  }

  const promotionalPrice = Number(
    promotionalPriceValue.replace(',', '.'),
  )

  if (
    !Number.isFinite(promotionalPrice) ||
    promotionalPrice <= 0
  ) {
    return null
  }

  const promotionalPriceMinor =
    Math.round(promotionalPrice * 100)

  if (
    regularPriceMinor !== null &&
    promotionalPriceMinor >= regularPriceMinor
  ) {
    return {
      tone: 'error' as const,
      label: '✕ Nem kedvezmény',
    }
  }

  if (
    min30PriceMinor === null ||
    min30PriceMinor === undefined
  ) {
    return {
      tone: 'neutral' as const,
      label: 'Nincs még árhistorika',
    }
  }

  if (promotionalPriceMinor < min30PriceMinor) {
    return {
      tone: 'good' as const,
      label: hasFull30DayWindow
        ? '✓ 30 napos minimum alatt'
        : '✓ Eddigi minimum alatt',
    }
  }

  if (promotionalPriceMinor === min30PriceMinor) {
    return {
      tone: 'neutral' as const,
      label: hasFull30DayWindow
        ? '= 30 napos minimummal'
        : '= Eddigi minimummal',
    }
  }

  return {
    tone: 'warning' as const,
    label: hasFull30DayWindow
      ? '⚠ Volt már olcsóbb 30 napon belül'
      : '⚠ Eddig már volt olcsóbb',
  }
}

function formatPriceScheduleStatus(
  status: ListingPriceSchedule[
    'scheduleStatus'
  ],
) {
  switch (status) {
    case 'SCHEDULED':
      return 'Ütemezett'
    case 'ACTIVE':
      return 'Aktív'
    case 'EXPIRED':
      return 'Lejárt'
    case 'DISABLED':
      return 'Kikapcsolva'
  }
}

function formatPriceScheduleDateTime(
  value: string,
) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '–'
  }

  return new Intl.DateTimeFormat(
    'hu-HU',
    {
      timeZone: 'Europe/Budapest',
      dateStyle: 'short',
      timeStyle: 'short',
    },
  ).format(date)
}

function toBudapestInputParts(value: string) {
  const date = new Date(value)

  const formatter = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    },
  )

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )

  return {
    date:
      `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

function budapestLocalToIso(
  dateValue: string,
  timeValue: string,
) {
  const [year, month, day] = dateValue
    .split('-')
    .map(Number)

  const [hour, minute] = timeValue
    .split(':')
    .map(Number)

  const targetAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
  )

  let candidate = new Date(targetAsUtc)

  const formatter = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  )

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    )

    const actualAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )

    const difference = targetAsUtc - actualAsUtc

    if (difference === 0) {
      break
    }

    candidate = new Date(
      candidate.getTime() + difference,
    )
  }

  return candidate.toISOString()
}

function HomePage({
  view = 'home',
}: HomePageProps) {
  const getListingStatusInfo = (
    listing: AllegroListing,
  ) => {
    if (listing.publicationStatus !== 'ENDED') {
      return null
    }

    if (listing.inventorySourceMissing === true) {
      return 'Ehhez az ajánlathoz nincs elérhető készletadat az aktív készletforrásban, ezért az ajánlat le van állítva.'
    }

    if (listing.inventorySourceStock === 0) {
      return 'Az aktív készletforrás szerint nincs elérhető készlet, ezért az ajánlat le van állítva.'
    }

    return 'Az ajánlat jelenleg le van állítva.'
  }

  const hasPublicationDifference = (
    listing: AllegroListing,
  ) => {
    if (
      listing.desiredPublicationStatus === 'ACTIVE'
    ) {
      return (
        listing.publicationStatus !== 'ACTIVE' &&
        listing.publicationStatus !== 'ACTIVATING'
      )
    }

    if (
      listing.desiredPublicationStatus === 'INACTIVE'
    ) {
      return (
        listing.publicationStatus !== 'INACTIVE' &&
        listing.publicationStatus !== 'ENDED'
      )
    }

    return false
  }

  const [apiHealth, setApiHealth] =
    useState<HealthResponse | null>(null)

  const [platforms, setPlatforms] =
    useState<Platform[]>([])

  const [products, setProducts] =
    useState<Product[]>([])

  const [allegroListings, setAllegroListings] =
    useState<AllegroListing[]>([])

  const [
    priceHistoryByListing,
    setPriceHistoryByListing,
  ] = useState<
    Record<string, PriceHistorySummary>
  >({})

  const [
    priceSchedulesByListing,
    setPriceSchedulesByListing,
  ] = useState<
    Record<string, ListingPriceSchedule[]>
  >({})

  const [
    priceScheduleDialogListingId,
    setPriceScheduleDialogListingId,
  ] = useState<string | null>(null)

  const [
    editingPriceScheduleId,
    setEditingPriceScheduleId,
  ] = useState<string | null>(null)

  const [
    schedulePriceDraft,
    setSchedulePriceDraft,
  ] = useState('')

  const [
    scheduleValidFromDraft,
    setScheduleValidFromDraft,
  ] = useState('')

  const [
    scheduleValidFromTimeDraft,
    setScheduleValidFromTimeDraft,
  ] = useState('00:00')

  const [
    scheduleValidToDraft,
    setScheduleValidToDraft,
  ] = useState('')

  const [
    scheduleValidToTimeDraft,
    setScheduleValidToTimeDraft,
  ] = useState('23:59')

  const [
    savingPriceSchedule,
    setSavingPriceSchedule,
  ] = useState(false)

  const [
    deletingPriceScheduleId,
    setDeletingPriceScheduleId,
  ] = useState<string | null>(null)

  const [
    priceScheduleError,
    setPriceScheduleError,
  ] = useState<string | null>(null)

  const [allegroImportIssues, setAllegroImportIssues] =
    useState<AllegroImportIssue[]>([])

  const [
    desiredPriceDrafts,
    setDesiredPriceDraftsState,
  ] = useState<Record<string, string>>(() => {
    try {
      const stored = window.sessionStorage.getItem(
        'commerce-hub:allegro:unsaved-price-drafts-v2',
      )

      return stored
        ? (JSON.parse(stored) as Record<string, string>)
        : {}
    } catch {
      return {}
    }
  })

  const setDesiredPriceDrafts = (
    update:
      | Record<string, string>
      | ((
          current: Record<string, string>,
        ) => Record<string, string>),
  ) => {
    setDesiredPriceDraftsState((current) => {
      const next =
        typeof update === 'function'
          ? update(current)
          : {
              ...update,
              ...current,
            }

      try {
        window.sessionStorage.setItem(
          'commerce-hub:allegro:unsaved-price-drafts-v2',
          JSON.stringify(next),
        )
      } catch {
        // A sessionStorage hiánya nem akadályozza a szerkesztést.
      }

      return next
    })
  }

  const [, setSavingDesiredPrice] =
    useState<string | null>(null)

  const [
    desiredStockDrafts,
    setDesiredStockDraftsState,
  ] = useState<Record<string, string>>(() => {
    try {
      const stored = window.sessionStorage.getItem(
        'commerce-hub:allegro:unsaved-stock-drafts-v2',
      )

      return stored
        ? (JSON.parse(stored) as Record<string, string>)
        : {}
    } catch {
      return {}
    }
  })

  const setDesiredStockDrafts = (
    update:
      | Record<string, string>
      | ((
          current: Record<string, string>,
        ) => Record<string, string>),
  ) => {
    setDesiredStockDraftsState((current) => {
      const next =
        typeof update === 'function'
          ? update(current)
          : {
              ...update,
              ...current,
            }

      try {
        window.sessionStorage.setItem(
          'commerce-hub:allegro:unsaved-stock-drafts-v2',
          JSON.stringify(next),
        )
      } catch {
        // A sessionStorage hiánya nem akadályozza a szerkesztést.
      }

      return next
    })
  }

  const [, setSavingDesiredStock] =
    useState<string | null>(null)

  const [savingStockLockId, setSavingStockLockId] =
    useState<string | null>(null)

  const [
    desiredStatusDrafts,
    setDesiredStatusDraftsState,
  ] = useState<
    Record<string, 'ACTIVE' | 'INACTIVE'>
  >(() => {
    try {
      const stored = window.sessionStorage.getItem(
        'commerce-hub:allegro:unsaved-status-drafts-v2',
      )

      return stored
        ? (JSON.parse(stored) as Record<
            string,
            'ACTIVE' | 'INACTIVE'
          >)
        : {}
    } catch {
      return {}
    }
  })

  const setDesiredStatusDrafts = (
    update:
      | Record<string, 'ACTIVE' | 'INACTIVE'>
      | ((
          current: Record<
            string,
            'ACTIVE' | 'INACTIVE'
          >,
        ) => Record<
          string,
          'ACTIVE' | 'INACTIVE'
        >),
  ) => {
    setDesiredStatusDraftsState((current) => {
      const next =
        typeof update === 'function'
          ? update(current)
          : {
              ...update,
              ...current,
            }

      try {
        window.sessionStorage.setItem(
          'commerce-hub:allegro:unsaved-status-drafts-v2',
          JSON.stringify(next),
        )
      } catch {
        // A sessionStorage hiánya nem akadályozza a szerkesztést.
      }

      return next
    })
  }

  const [, setSavingDesiredStatus] =
    useState<string | null>(null)

  const [listingSearch, setListingSearch] =
    useState('')

  const [listingFilter, setListingFilter] =
    useState<
      | 'ALL'
      | 'DIFFERENT'
      | 'UNSAVED'
      | 'ACTIVE'
      | 'INACTIVE'
      | 'ENDED'
    >('ALL')

  const [listingPageSize, setListingPageSize] =
    useState<25 | 50 | 100>(25)

  const [listingPage, setListingPage] =
    useState(1)

  useEffect(() => {
    setListingPage(1)
  }, [
    listingSearch,
    listingFilter,
    listingPageSize,
  ])
  const [selectedListingIds, setSelectedListingIds] =
    useState<string[]>([])

  const [bulkSyncing, setBulkSyncing] =
    useState(false)
  const [bulkSavingDesiredChanges, setBulkSavingDesiredChanges] = useState(false)
  const [discardingDesiredChanges, setDiscardingDesiredChanges] = useState(false)
  const [syncingWholeListingId, setSyncingWholeListingId] =
    useState<string | null>(null)


  const [loading, setLoading] = useState(true)

  const [refreshingAllegro, setRefreshingAllegro] =
    useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [
          healthResponse,
          platformResponse,
          productResponse,
          allegroResponse,
          priceHistoryResponse,
          priceSchedulesResponse,
        ] = await Promise.all([
          fetch(`${API_BASE_URL}/health`),
          fetch(`${API_BASE_URL}/platforms`),
          fetch(`${API_BASE_URL}/products`),
          fetch(`${API_BASE_URL}/allegro/listings`),
          fetch(
            `${API_BASE_URL}/allegro/listing-price-history-summary`,
          ),
          fetch(
            `${API_BASE_URL}/allegro/listing-price-schedules`,
          ),
        ])

        if (
          !healthResponse.ok ||
          !platformResponse.ok ||
          !productResponse.ok ||
          !allegroResponse.ok ||
          !priceHistoryResponse.ok ||
          !priceSchedulesResponse.ok
        ) {
          throw new Error('API request failed')
        }

        const healthData =
          (await healthResponse.json()) as HealthResponse

        const platformData =
          (await platformResponse.json()) as PlatformResponse

        const productData =
          (await productResponse.json()) as ProductResponse

        const allegroData =
          (await allegroResponse.json()) as AllegroListingResponse

        const priceHistoryData =
          (await priceHistoryResponse.json()) as PriceHistorySummaryResponse

        const priceSchedulesData =
          (await priceSchedulesResponse.json()) as ListingPriceScheduleResponse

        setApiHealth(healthData)
        setPlatforms(platformData.data)
        setProducts(productData.data)
        setAllegroListings(allegroData.data)

        setPriceHistoryByListing(
          Object.fromEntries(
            priceHistoryData.data.map((row) => [
              row.listingId,
              row,
            ]),
          ),
        )

        setPriceSchedulesByListing(
          priceSchedulesData.data.reduce<
            Record<string, ListingPriceSchedule[]>
          >((result, schedule) => {
            const current =
              result[schedule.listingId] ?? []

            result[schedule.listingId] = [
              ...current,
              schedule,
            ].sort(
              (left, right) =>
                new Date(left.validFrom).getTime() -
                new Date(right.validFrom).getTime(),
            )

            return result
          }, {}),
        )

        try {
          const importIssuesResponse = await fetch(
            `${API_BASE_URL}/auth/allegro/import-issues`,
          )

          if (importIssuesResponse.ok) {
            const importIssuesData =
              (await importIssuesResponse.json()) as AllegroImportIssueResponse

            setAllegroImportIssues(
              importIssuesData.data,
            )
          } else {
            setAllegroImportIssues([])
          }
        } catch {
          setAllegroImportIssues([])
        }


      } catch (error) {
        console.error(
          'Commerce Hub data loading failed:',
          error,
        )

        setApiHealth(null)
        setPlatforms([])
        setProducts([])
        setAllegroListings([])
      } finally {
        setLoading(false)
      }
    }

    void loadData()
  }, [])

  const refreshAllegroData = async () => {
    setRefreshingAllegro(true)

    try {
      const syncResponse = await fetch(
        `${API_BASE_URL}/auth/allegro/sync`,
        {
          method: 'POST',
        },
      )

      if (!syncResponse.ok) {
        const errorData = (await syncResponse
          .json()
          .catch(() => null)) as
          | {
              message?: string
            }
          | null

        throw new Error(
          errorData?.message ??
            'Nem sikerült frissíteni az Allegro-ajánlatokat.',
        )
      }

      const [
        listingsResponse,
        issuesResponse,
      ] = await Promise.all([
        fetch(
          `${API_BASE_URL}/allegro/listings`,
        ),
        fetch(
          `${API_BASE_URL}/auth/allegro/import-issues`,
        ),
      ])

      if (!listingsResponse.ok) {
        throw new Error(
          'Nem sikerült betölteni a frissített ajánlatokat.',
        )
      }

      const listingsData =
        (await listingsResponse.json()) as AllegroListingResponse

      setAllegroListings(listingsData.data)

      await loadPriceSchedules()



      if (issuesResponse.ok) {
        const issuesData =
          (await issuesResponse.json()) as AllegroImportIssueResponse

        setAllegroImportIssues(
          issuesData.data,
        )
      } else {
        setAllegroImportIssues([])
      }

      setSelectedListingIds((current) =>
        current.filter((id) =>
          listingsData.data.some(
            (listing) => listing.id === id,
          ),
        ),
      )
    } catch (error) {
      console.error(
        'Allegro refresh failed:',
        error,
      )

      window.alert(
        error instanceof Error
          ? error.message
          : 'Nem sikerült frissíteni az Allegro-ajánlatokat.',
      )
    } finally {
      setRefreshingAllegro(false)
    }
  }
  const saveDesiredPrice = async (
    listing: AllegroListing,
  ) => {
    const draft = desiredPriceDrafts[listing.id] ?? ''

    const desiredPrice = Number(
      draft.replace(',', '.'),
    )

    if (
      !Number.isFinite(desiredPrice) ||
      desiredPrice < 0
    ) {
      window.alert('Adj meg egy érvényes árat.')
      return
    }

    setSavingDesiredPrice(listing.id)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/listings/${listing.id}/desired-price`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredPrice,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt ár mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredPriceMinor: number
          priceLocked: boolean
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredPriceMinor:
                  result.data.desiredPriceMinor,
                priceLocked:
                  result.data.priceLocked,
              }
            : item,
        ),
      )

      setDesiredPriceDrafts((current) => {
        const next = { ...current }
        delete next[listing.id]
        return next
      })

      return true
    } catch (error) {
      console.error(
        'Desired price save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt árat.',
      )

      return false
    } finally {
      setSavingDesiredPrice(null)
    }
  }
  const saveDesiredStock = async (
    listing: AllegroListing,
  ) => {
    const draft =
      desiredStockDrafts[listing.id] ?? ''

    const desiredStock = Number(draft)

    if (
      !Number.isInteger(desiredStock) ||
      desiredStock < 0
    ) {
      window.alert(
        'Adj meg egy érvényes egész készletértéket.',
      )
      return
    }

    setSavingDesiredStock(listing.id)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/listings/${listing.id}/desired-stock`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredStock,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt készlet mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredStock: number
          stockLocked: boolean
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredStock:
                  result.data.desiredStock,
                stockLocked:
                  result.data.stockLocked,
              }
            : item,
        ),
      )

      setDesiredStockDrafts((current) => {
        const next = { ...current }
        delete next[listing.id]
        return next
      })

      return true
    } catch (error) {
      console.error(
        'Desired stock save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt készletet.',
      )

      return false
    } finally {
      setSavingDesiredStock(null)
    }
  }
  const updateStockLock = async (
    listing: AllegroListing,
    stockLocked: boolean,
  ) => {
    setSavingStockLockId(listing.id)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/listings/${listing.id}/stock-lock`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stockLocked,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A készletrögzítés módosítása sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          stockLocked: boolean
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                stockLocked:
                  result.data.stockLocked,
              }
            : item,
        ),
      )
    } catch (error) {
      console.error(
        'Stock lock update failed:',
        error,
      )

      window.alert(
        'A készletrögzítés módosítása sikertelen.',
      )
    } finally {
      setSavingStockLockId(null)
    }
  }

  const saveDesiredStatus = async (
    listing: AllegroListing,
  ) => {
    const desiredStatus =
      desiredStatusDrafts[listing.id] ??
      (
        listing.desiredPublicationStatus === 'ACTIVE' ||
        listing.desiredPublicationStatus === 'INACTIVE'
          ? listing.desiredPublicationStatus
          : listing.publicationStatus === 'ACTIVE' ||
              listing.publicationStatus === 'ACTIVATING'
            ? 'ACTIVE'
            : 'INACTIVE'
      )

    setSavingDesiredStatus(listing.id)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/listings/${listing.id}/desired-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredStatus,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt státusz mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredPublicationStatus:
            | 'ACTIVE'
            | 'INACTIVE'
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredPublicationStatus:
                  result.data.desiredPublicationStatus,
              }
            : item,
        ),
      )

      setDesiredStatusDrafts((current) => {
        const next = { ...current }
        delete next[listing.id]
        return next
      })

      return true
    } catch (error) {
      console.error(
        'Desired publication status save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt státuszt.',
      )

      return false
    } finally {
      setSavingDesiredStatus(null)
    }
  }
  const getStoredDesiredStatus = (
    listing: AllegroListing,
  ): 'ACTIVE' | 'INACTIVE' =>
    listing.desiredPublicationStatus === 'ACTIVE' ||
    listing.desiredPublicationStatus === 'INACTIVE'
      ? listing.desiredPublicationStatus
      : listing.publicationStatus === 'ACTIVE' ||
          listing.publicationStatus === 'ACTIVATING'
        ? 'ACTIVE'
        : 'INACTIVE'

  const hasUnsavedDesiredPrice = (
    listing: AllegroListing,
  ) => {
    const draft = desiredPriceDrafts[listing.id]

    if (draft === undefined) {
      return false
    }

    if (draft.trim() === '') {
      return true
    }

    const value = Number(draft.replace(',', '.'))

    if (!Number.isFinite(value)) {
      return true
    }

    return (
      Math.round(value * 100) !==
      listing.desiredPriceMinor
    )
  }

  const hasUnsavedDesiredStock = (
    listing: AllegroListing,
  ) => {
    const draft = desiredStockDrafts[listing.id]

    if (draft === undefined) {
      return false
    }

    if (draft.trim() === '') {
      return true
    }

    const value = Number(draft)

    if (!Number.isInteger(value)) {
      return true
    }

    return value !== listing.desiredStock
  }

  const hasUnsavedDesiredStatus = (
    listing: AllegroListing,
  ) => {
    const storedStatus = getStoredDesiredStatus(listing)

    const draft =
      desiredStatusDrafts[listing.id] ??
      storedStatus

    return draft !== storedStatus
  }

  const isAppliedPriceScheduleActive = (
    schedule: ListingPriceSchedule,
  ) =>
    schedule.enabled &&
    schedule.startAppliedAt !== null &&
    schedule.endAppliedAt === null

  const getEffectiveDesiredPriceMinor = (
    listing: AllegroListing,
  ) => {
    const activeSchedule =
      (
        priceSchedulesByListing[listing.id] ??
        []
      )
        .filter(
          isAppliedPriceScheduleActive,
        )
        .sort(
          (left, right) =>
            new Date(
              right.validFrom,
            ).getTime() -
            new Date(
              left.validFrom,
            ).getTime(),
        )[0] ?? null

    return (
      activeSchedule?.promotionalPriceMinor ??
      listing.desiredPriceMinor
    )
  }
  const hasPriceDifference = (
    listing: AllegroListing,
  ) => {
    const effectiveDesiredPriceMinor =
      getEffectiveDesiredPriceMinor(listing)

    return (
      effectiveDesiredPriceMinor !== null &&
      listing.priceMinor !==
        effectiveDesiredPriceMinor
    )
  }
  const getEffectiveStockAvailable = (
    listing: AllegroListing,
  ) => {
    const isNotSellable =
      listing.publicationStatus === 'ENDED' ||
      listing.publicationStatus === 'INACTIVE'

    if (isNotSellable || listing.stockAutoPaused) {
      return 0
    }

    return listing.stockAvailable
  }

  const hasListingDifference = (
    listing: AllegroListing,
  ) => {
    const isIntentionallyInactive =
      listing.desiredPublicationStatus === 'INACTIVE' &&
      (listing.publicationStatus === 'INACTIVE' ||
        listing.publicationStatus === 'ENDED')

    const hasStockDifference =
      !isIntentionallyInactive &&
      listing.desiredStock !== null &&
      getEffectiveStockAvailable(listing) !==
        listing.desiredStock

    return (
      hasPriceDifference(listing) ||
      hasStockDifference ||
      hasPublicationDifference(listing)
    )
  }

  const changedListingsCount =
    allegroListings.filter(
      (listing) =>
        hasListingDifference(listing),
    ).length
  const selectedChangedListingsCount =
    allegroListings.filter(
      (listing) =>
        selectedListingIds.includes(
          listing.id,
        ) &&
        hasListingDifference(listing),
    ).length
  const unsavedDesiredListings =
    allegroListings.filter(
      (listing) =>
        hasUnsavedDesiredPrice(listing) ||
        hasUnsavedDesiredStock(listing) ||
        hasUnsavedDesiredStatus(listing),
    )

  const unsavedDesiredChangesCount =
    unsavedDesiredListings.length

  const saveAllDesiredChanges = async () => {
    if (unsavedDesiredChangesCount === 0) {
      return
    }

    for (const listing of unsavedDesiredListings) {
      if (hasUnsavedDesiredPrice(listing)) {
        const draft =
          desiredPriceDrafts[listing.id] ?? ''

        const value = Number(
          draft.replace(',', '.'),
        )

        if (
          draft.trim() === '' ||
          !Number.isFinite(value) ||
          value < 0
        ) {
          window.alert(
            `Érvénytelen kívánt ár ennél az ajánlatnál: ${listing.id}`,
          )
          return
        }
      }

      if (hasUnsavedDesiredStock(listing)) {
        const draft =
          desiredStockDrafts[listing.id] ?? ''

        const value = Number(draft)

        if (
          draft.trim() === '' ||
          !Number.isInteger(value) ||
          value < 0
        ) {
          window.alert(
            `Érvénytelen kívánt készlet ennél az ajánlatnál: ${listing.id}`,
          )
          return
        }
      }
    }

    const confirmed = window.confirm(
      `${unsavedDesiredChangesCount} ajánlatnál van nem mentett módosítás.

Elmented ezeket a Commerce Hubba?`,
    )

    if (!confirmed) {
      return
    }

    setBulkSavingDesiredChanges(true)

    let succeeded = 0
    let failed = 0

    try {
      for (const listing of unsavedDesiredListings) {
        let listingSucceeded = true

        if (hasUnsavedDesiredPrice(listing)) {
          const saved =
            await saveDesiredPrice(listing)

          if (saved !== true) {
            listingSucceeded = false
          }
        }

        if (hasUnsavedDesiredStock(listing)) {
          const saved =
            await saveDesiredStock(listing)

          if (saved !== true) {
            listingSucceeded = false
          }
        }

        if (hasUnsavedDesiredStatus(listing)) {
          const saved =
            await saveDesiredStatus(listing)

          if (saved !== true) {
            listingSucceeded = false
          }
        }

        if (listingSucceeded) {
          succeeded += 1
        } else {
          failed += 1
        }
      }

      window.alert(
        `Mentés kész.

Sikeres: ${succeeded}
Hibás: ${failed}`,
      )
    } finally {
      setBulkSavingDesiredChanges(false)
    }
  }
  const loadPriceSchedules = async () => {
    const response = await fetch(
      `${API_BASE_URL}/allegro/listing-price-schedules`,
    )

    const result =
      (await response.json()) as ListingPriceScheduleResponse & {
        message?: string
      }

    if (!response.ok) {
      throw new Error(
        result.message ??
          'Nem sikerült betölteni az időszakos árakat.',
      )
    }

    setPriceSchedulesByListing(
      result.data.reduce<
        Record<string, ListingPriceSchedule[]>
      >((current, schedule) => {
        const schedules =
          current[schedule.listingId] ?? []

        current[schedule.listingId] = [
          ...schedules,
          schedule,
        ].sort(
          (left, right) =>
            new Date(left.validFrom).getTime() -
            new Date(right.validFrom).getTime(),
        )

        return current
      }, {}),
    )
  }

  const resetPriceScheduleDraft = () => {
    setEditingPriceScheduleId(null)
    setSchedulePriceDraft('')
    setScheduleValidFromDraft('')
    setScheduleValidFromTimeDraft('00:00')
    setScheduleValidToDraft('')
    setScheduleValidToTimeDraft('23:59')
    setPriceScheduleError(null)
  }

  const openPriceScheduleDialog = (
    listing: AllegroListing,
  ) => {
    resetPriceScheduleDraft()
    setPriceScheduleDialogListingId(listing.id)
  }

  const closePriceScheduleDialog = () => {
    setPriceScheduleDialogListingId(null)
    resetPriceScheduleDraft()
  }

  const editPriceSchedule = (
    schedule: ListingPriceSchedule,
  ) => {
    const from = toBudapestInputParts(
      schedule.validFrom,
    )

    const to = toBudapestInputParts(
      schedule.validTo,
    )

    setEditingPriceScheduleId(schedule.id)
    setSchedulePriceDraft(
      String(schedule.promotionalPriceMinor / 100),
    )
    setScheduleValidFromDraft(from.date)
    setScheduleValidFromTimeDraft(from.time)
    setScheduleValidToDraft(to.date)
    setScheduleValidToTimeDraft(to.time)
    setPriceScheduleError(null)
  }

  const isEditingActivePriceSchedule = (
    listingId: string,
  ) => {
    if (editingPriceScheduleId === null) {
      return false
    }

    const schedule =
      (
        priceSchedulesByListing[listingId] ??
        []
      ).find(
        (item) =>
          item.id === editingPriceScheduleId,
      )

    return (
      schedule?.startAppliedAt !== null &&
      schedule?.startAppliedAt !== undefined &&
      schedule.endAppliedAt === null
    )
  }

  const savePriceSchedule = async (
    listing: AllegroListing,
  ) => {
    setPriceScheduleError(null)

    const promotionalPrice = Number(
      schedulePriceDraft.replace(',', '.'),
    )

    if (
      !Number.isFinite(promotionalPrice) ||
      promotionalPrice <= 0
    ) {
      setPriceScheduleError(
        'Adj meg egy érvényes kedvezményes árat.',
      )
      return
    }

    if (
      listing.desiredPriceMinor !== null &&
      Math.round(promotionalPrice * 100) >=
        listing.desiredPriceMinor
    ) {
      setPriceScheduleError(
        'A kedvezményes árnak alacsonyabbnak kell lennie a normál kívánt árnál.',
      )
      return
    }

    if (
      !scheduleValidFromDraft ||
      !scheduleValidFromTimeDraft ||
      !scheduleValidToDraft ||
      !scheduleValidToTimeDraft
    ) {
      setPriceScheduleError(
        'Add meg a kedvezmény teljes időszakát.',
      )
      return
    }

    const validFrom = budapestLocalToIso(
      scheduleValidFromDraft,
      scheduleValidFromTimeDraft,
    )

    const validTo = budapestLocalToIso(
      scheduleValidToDraft,
      scheduleValidToTimeDraft,
    )

    if (
      new Date(validTo).getTime() <=
      new Date(validFrom).getTime()
    ) {
      setPriceScheduleError(
        'A befejezésnek később kell lennie a kezdésnél.',
      )
      return
    }

    setSavingPriceSchedule(true)

    try {
      const editing =
        editingPriceScheduleId !== null

      const editingActive =
        isEditingActivePriceSchedule(
          listing.id,
        )

      const response = await fetch(
        editing
          ? `${API_BASE_URL}/auth/allegro/price-schedule/${editingPriceScheduleId}`
          : `${API_BASE_URL}/allegro/listing-price-schedules`,
        {
          method: editing ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(editing
              ? {}
              : { listingId: listing.id }),
            promotionalPrice,
            ...(editingActive ? {} : { validFrom }),
            validTo,
            ...(editing ? {} : { enabled: true }),
          }),
        },
      )

      const result = (await response.json()) as {
        status: string
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Az időszakos kedvezmény mentése sikertelen.',
        )
      }

      await loadPriceSchedules()

      if (editingActive) {
        await refreshAllegroData()
      }
      resetPriceScheduleDraft()
    } catch (error) {
      console.error(
        'Price schedule save failed:',
        error,
      )

      setPriceScheduleError(
        error instanceof Error
          ? error.message
          : 'Az időszakos kedvezmény mentése sikertelen.',
      )
    } finally {
      setSavingPriceSchedule(false)
    }
  }

  const deletePriceSchedule = async (
    schedule: ListingPriceSchedule,
  ) => {
    const isActive =
      schedule.startAppliedAt !== null &&
      schedule.endAppliedAt === null

    const confirmed = window.confirm(
      isActive
        ? 'Biztosan törlöd az aktív kedvezményt? Az Allegro ár automatikusan visszaáll a kívánt árra.'
        : 'Biztosan törlöd ezt az időszakos kedvezményt?',
    )

    if (!confirmed) {
      return
    }

    setDeletingPriceScheduleId(schedule.id)
    setPriceScheduleError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/auth/allegro/price-schedule/${schedule.id}`,
        { method: 'DELETE' },
      )

      const result = (await response.json()) as {
        status: string
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Az időszakos kedvezmény törlése sikertelen.',
        )
      }

      await loadPriceSchedules()

      if (isActive) {
        await refreshAllegroData()
      }

      if (
        editingPriceScheduleId === schedule.id
      ) {
        resetPriceScheduleDraft()
      }
    } catch (error) {
      console.error(
        'Price schedule deletion failed:',
        error,
      )

      setPriceScheduleError(
        error instanceof Error
          ? error.message
          : 'Az időszakos kedvezmény törlése sikertelen.',
      )
    } finally {
      setDeletingPriceScheduleId(null)
    }
  }

  const discardDesiredDifferences = async () => {
    const confirmed = window.confirm(
      [
        'Biztosan elveted az összes nem szinkronizált módosítást?',
        '',
        'A kívánt ár-, készlet- és státuszértékek visszaállnak a jelenlegi Allegro-állapotra.',
        '',
        'Az Allegrón semmi nem változik.',
      ].join('\n'),
    )

    if (!confirmed) {
      return
    }

    setDiscardingDesiredChanges(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/listings/discard-desired-differences`,
        {
          method: 'POST',
        },
      )

      const result = (await response.json()) as {
        status: string
        updated?: number
        protectedPrices?: number
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'A módosítások elvetése sikertelen.',
        )
      }

      const listingsResponse = await fetch(
        `${API_BASE_URL}/allegro/listings`,
      )

      if (!listingsResponse.ok) {
        throw new Error(
          'Nem sikerült újratölteni az ajánlatokat.',
        )
      }

      const listingsData =
        (await listingsResponse.json()) as
          AllegroListingResponse

      setAllegroListings(
        listingsData.data,
      )

      setDesiredPriceDraftsState(
        Object.fromEntries(
          listingsData.data.map(
            (listing) => [
              listing.id,
              listing.desiredPriceMinor !== null
                ? String(
                    listing.desiredPriceMinor / 100,
                  )
                : '',
            ],
          ),
        ),
      )

      setDesiredStockDraftsState(
        Object.fromEntries(
          listingsData.data.map(
            (listing) => [
              listing.id,
              listing.desiredStock !== null
                ? String(
                    listing.desiredStock,
                  )
                : '',
            ],
          ),
        ),
      )

      setDesiredStatusDraftsState(
        Object.fromEntries(
          listingsData.data.map(
            (listing) => [
              listing.id,
              listing.desiredPublicationStatus ===
                'ACTIVE'
                ? 'ACTIVE'
                : listing.desiredPublicationStatus ===
                    'INACTIVE'
                  ? 'INACTIVE'
                  : listing.publicationStatus ===
                        'ACTIVE' ||
                      listing.publicationStatus ===
                        'ACTIVATING'
                    ? 'ACTIVE'
                    : 'INACTIVE',
            ],
          ),
        ) as Record<
          string,
          'ACTIVE' | 'INACTIVE'
        >,
      )

      try {
        window.sessionStorage.removeItem(
          'commerce-hub:allegro:unsaved-price-drafts-v2',
        )

        window.sessionStorage.removeItem(
          'commerce-hub:allegro:unsaved-stock-drafts-v2',
        )

        window.sessionStorage.removeItem(
          'commerce-hub:allegro:unsaved-status-drafts-v2',
        )
      } catch {
        // A sessionStorage hibája nem akadályozza a műveletet.
      }

      setSelectedListingIds([])

      const protectedMessage =
        (result.protectedPrices ?? 0) > 0
          ? `\n\n${result.protectedPrices} aktív kedvezményes vagy kampányár normál kívánt ára érintetlen maradt.`
          : ''

      window.alert(
        `${result.updated ?? 0} ajánlat módosítása elvetve.${protectedMessage}`,
      )
    } catch (error) {
      console.error(
        'Discard desired differences failed:',
        error,
      )

      window.alert(
        error instanceof Error
          ? error.message
          : 'A módosítások elvetése sikertelen.',
      )
    } finally {
      setDiscardingDesiredChanges(false)
    }
  }


  const normalizedListingSearch =
    listingSearch.trim().toLowerCase()

  const searchedAllegroListings =
    allegroListings.filter((listing) => {
      if (normalizedListingSearch === '') {
        return true
      }

      const searchableText = [
        listing.sku,
        listing.productName,
        listing.offerId,
      ]
        .map((value) =>
          String(value ?? '').toLowerCase(),
        )
        .join(' ')

      return searchableText.includes(
        normalizedListingSearch,
      )
    })

  const searchedDifferentListingsCount =
    searchedAllegroListings.filter(
      (listing) =>
        hasListingDifference(listing),
    ).length

  const searchedUnsavedListingsCount =
    searchedAllegroListings.filter(
      (listing) =>
        hasUnsavedDesiredPrice(listing) ||
        hasUnsavedDesiredStock(listing) ||
        hasUnsavedDesiredStatus(listing),
    ).length

  const searchedActiveListingsCount =
    searchedAllegroListings.filter(
      (listing) =>
        listing.publicationStatus === 'ACTIVE' ||
        listing.publicationStatus === 'ACTIVATING',
    ).length

  const searchedInactiveListingsCount =
    searchedAllegroListings.filter(
      (listing) =>
        listing.publicationStatus === 'INACTIVE',
    ).length

  const searchedEndedListingsCount =
    searchedAllegroListings.filter(
      (listing) =>
        listing.publicationStatus === 'ENDED',
    ).length

  const filteredAllegroListings =
    searchedAllegroListings.filter((listing) => {
      switch (listingFilter) {
        case 'DIFFERENT':
          return hasListingDifference(
            listing,
          )

        case 'UNSAVED':
          return (
            hasUnsavedDesiredPrice(listing) ||
            hasUnsavedDesiredStock(listing) ||
            hasUnsavedDesiredStatus(listing)
          )

        case 'ACTIVE':
          return (
            listing.publicationStatus === 'ACTIVE' ||
            listing.publicationStatus ===
              'ACTIVATING'
          )

        case 'INACTIVE':
          return (
            listing.publicationStatus ===
            'INACTIVE'
          )

        case 'ENDED':
          return (
            listing.publicationStatus === 'ENDED'
          )

        case 'ALL':
        default:
          return true
      }
    })
  const listingPageCount =
    Math.max(
      1,
      Math.ceil(
        filteredAllegroListings.length /
          listingPageSize,
      ),
    )

  const safeListingPage =
    Math.min(
      listingPage,
      listingPageCount,
    )

  const listingPageStart =
    (safeListingPage - 1) *
    listingPageSize

  const paginatedAllegroListings =
    filteredAllegroListings.slice(
      listingPageStart,
      listingPageStart +
        listingPageSize,
    )

  useEffect(() => {
    setListingPage((current) =>
      Math.min(
        Math.max(current, 1),
        listingPageCount,
      ),
    )
  }, [listingPageCount])
  const toggleListingSelection = (
    listingId: string,
  ) => {
    setSelectedListingIds((current) =>
      current.includes(listingId)
        ? current.filter((id) => id !== listingId)
        : [...current, listingId],
    )
  }

  const toggleAllListings = () => {
    const pageIds =
      paginatedAllegroListings.map(
        (listing) => listing.id,
      )

    const allPageSelected =
      pageIds.length > 0 &&
      pageIds.every((listingId) =>
        selectedListingIds.includes(
          listingId,
        ),
      )

    setSelectedListingIds((current) => {
      const next =
        new Set(current)

      if (allPageSelected) {
        pageIds.forEach((listingId) =>
          next.delete(listingId),
        )
      } else {
        pageIds.forEach((listingId) =>
          next.add(listingId),
        )
      }

      return Array.from(next)
    })
  }

  const allListingsSelected =
    paginatedAllegroListings.length > 0 &&
    paginatedAllegroListings.every(
      (listing) =>
        selectedListingIds.includes(
          listing.id,
        ),
    )
  const syncSelectedListingsToAllegro = async () => {
    if (selectedListingIds.length === 0) {
      return
    }

    const changedListings = allegroListings.filter(
      (listing) =>
        selectedListingIds.includes(listing.id) &&
        (
          hasPriceDifference(listing) ||
          (listing.desiredStock !== null &&
            getEffectiveStockAvailable(listing) !==
              listing.desiredStock) ||
          hasPublicationDifference(listing)
        ),
    )

    if (changedListings.length === 0) {
      window.alert(
        'A kijelölt ajánlatoknál nincs szinkronizálandó eltérés.',
      )
      return
    }

    const confirmed = window.confirm(
      `${selectedListingIds.length} ajánlat van kijelölve.

${changedListings.length} ajánlatnál találtunk eltérést.

Biztosan szinkronizálod őket az Allegróval?`,
    )

    if (!confirmed) {
      return
    }

    setBulkSyncing(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/auth/allegro/sync-selected`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingIds: selectedListingIds,
          }),
        },
      )

      const data = (await response.json()) as {
        status: string
        selected?: number
        attempted?: number
        succeeded?: number
        skipped?: number
        failed?: number
        pending?: number
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          data.message ??
            'A kijelölt ajánlatok szinkronizálása sikertelen.',
        )
      }

      window.alert(
        `Szinkronizálás kész.

Sikeres: ${data.succeeded ?? 0}
Kihagyva: ${data.skipped ?? 0}
Hibás: ${data.failed ?? 0}
Folyamatban: ${data.pending ?? 0}`,
      )

      window.location.reload()
    } catch (error) {
      console.error('Bulk Allegro sync failed:', error)

      window.alert(
        error instanceof Error
          ? error.message
          : 'A szinkronizálás sikertelen.',
      )
    } finally {
      setBulkSyncing(false)
    }
  }
  const syncWholeListingToAllegro = async (
    listing: AllegroListing,
  ) => {
    const effectiveDesiredPriceMinor =
      getEffectiveDesiredPriceMinor(listing)

    const priceChanged =
      hasPriceDifference(listing)

    const isIntentionallyInactive =
      listing.desiredPublicationStatus === 'INACTIVE' &&
      (
        listing.publicationStatus === 'INACTIVE' ||
        listing.publicationStatus === 'ENDED'
      )

    const stockChanged =
      !isIntentionallyInactive &&
      listing.desiredStock !== null &&
      getEffectiveStockAvailable(listing) !==
        listing.desiredStock

    const publicationChanged =
      hasPublicationDifference(listing)

    if (
      !priceChanged &&
      !stockChanged &&
      !publicationChanged
    ) {
      return
    }

    const changes: string[] = []

    if (priceChanged) {
      changes.push(
        `Ár: ${formatMoney(
          listing.priceMinor,
          listing.currency,
        )} → ${formatMoney(
          effectiveDesiredPriceMinor,
          listing.currency,
        )}`,
      )
    }

    if (stockChanged) {
      changes.push(
        `Készlet: ${getEffectiveStockAvailable(listing) ?? 0} db → ${listing.desiredStock} db`,
      )
    }

    if (publicationChanged) {
      const desiredStatusLabel =
        listing.desiredPublicationStatus === 'ACTIVE'
          ? 'Aktív'
          : 'Inaktív'

      changes.push(
        `Státusz: ${formatListingStatus(
          listing.publicationStatus,
        )} → ${desiredStatusLabel}`,
      )
    }

    const confirmed = window.confirm(
      `Biztosan szinkronizálod az ajánlatot?

${changes.join('\n')}`,
    )

    if (!confirmed) {
      return
    }

    setSyncingWholeListingId(listing.id)

    try {
      if (priceChanged) {
        const response = await fetch(
          `${API_BASE_URL}/auth/allegro/push-price/${listing.id}`,
          { method: 'POST' },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ?? 'Az ár szinkronizálása sikertelen.',
          )
        }
      }

      if (stockChanged) {
        const response = await fetch(
          `${API_BASE_URL}/auth/allegro/push-stock/${listing.id}`,
          { method: 'POST' },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ?? 'A készlet szinkronizálása sikertelen.',
          )
        }
      }

      if (publicationChanged) {
        const response = await fetch(
          `${API_BASE_URL}/auth/allegro/push-status/${listing.id}`,
          {
            method: 'POST',
          },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ??
              'A státusz szinkronizálása sikertelen.',
          )
        }
      }

      const syncResponse = await fetch(
        `${API_BASE_URL}/auth/allegro/sync`,
        { method: 'POST' },
      )

      if (!syncResponse.ok) {
        throw new Error(
          'A visszaellenőrző szinkron sikertelen.',
        )
      }

      const listingResponse = await fetch(
        `${API_BASE_URL}/allegro/listings`,
      )

      if (!listingResponse.ok) {
        throw new Error(
          'Nem sikerült frissíteni az ajánlatlistát.',
        )
      }

      const listingData =
        (await listingResponse.json()) as AllegroListingResponse

      setAllegroListings(listingData.data)



      window.alert('Az ajánlat sikeresen szinkronizálva.')
    } catch (error) {
      console.error('Listing sync failed:', error)

      window.alert(
        error instanceof Error
          ? error.message
          : 'A szinkronizálás sikertelen.',
      )
    } finally {
      setSyncingWholeListingId(null)
    }
  }
  const allegro = platforms.find(
    (platform) => platform.code === 'ALLEGRO',
  )

  const arukereso = platforms.find(
    (platform) => platform.code === 'ARUKERESO',
  )

  const services: ServiceStatus[] = [
    {
      name: 'Adminfelület',
      description: 'React + TypeScript alkalmazás',
      status: 'working',
    },
    {
      name: 'Backend API',
      description: apiHealth
        ? `Kapcsolódva • ${apiHealth.service}`
        : 'A backend jelenleg nem érhető el',
      status: apiHealth ? 'working' : 'disconnected',
    },
    {
      name: 'PostgreSQL adatbázis',
      description: 'Neon PostgreSQL kapcsolat',
      status: apiHealth ? 'working' : 'disconnected',
    },
    {
      name: 'Allegro',
      description:
        allegro && allegroListings.length > 0
          ? `${allegroListings.length} magyar ajánlat szinkronizálva`
          : allegro
            ? 'Platform csatlakoztatva'
            : 'A platform nem érhető el',
      status: allegro ? 'working' : 'disconnected',
    },
    {
      name: 'Árukereső',
      description: arukereso
        ? 'Platform előkészítve az integrációhoz'
        : 'A platform nem érhető el',
      status: arukereso ? 'prepared' : 'disconnected',
    },
  ]

  if (view === 'allegroOffers') {
    return (
      <div className="allegro-offers-view">


        <section className="allegro-section">
          <div className="section-heading">
            <div>
              <p className="section-label">
                ALLEGRO MAGYARORSZÁG
              </p>

              <h3>Ajánlatok</h3>
            </div>

            <div className="allegro-heading-actions">
              <span>
                {loading
                  ? 'Betöltés...'
                  : `${filteredAllegroListings.length} / ${allegroListings.length} ajánlat`}
              </span>

              <button
                className="refresh-allegro-button"
                type="button"
                disabled={
                  loading ||
                  refreshingAllegro
                }
                onClick={() =>
                  void refreshAllegroData()
                }
              >
                {refreshingAllegro
                  ? 'Frissítés...'
                  : 'Ajánlatok frissítése'}
              </button>
            </div>
          </div>

          {allegroImportIssues.length > 0 && (
            <div className="import-issues-compact">
              <div className="import-issues-compact-copy">
                <strong>
                  {allegroImportIssues.length}
                  {' importálási probléma'}
                </strong>

                <span>
                  Ezek az ajánlatok hiányzó azonosító miatt
                  nem kerültek be automatikusan.
                </span>
              </div>

              <a href="/allegro/settings">
                Részletek a Beállításokban
                <span aria-hidden="true">→</span>
              </a>
            </div>
          )}
          <div className="listing-filter-panel">
            <div className="listing-search-wrapper">
              <input
                className="listing-search-input"
                type="search"
                value={listingSearch}
                placeholder="Cikkszám, terméknév vagy Offer ID..."
                onChange={(event) => {
                  setListingSearch(
                    event.target.value,
                  )
                  setSelectedListingIds([])
                }}
              />
            </div>

            <div
              className="listing-filter-chips"
              aria-label="Ajánlat szűrők"
            >
              <button
                className={
                  listingFilter === 'ALL'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('ALL')
                  setSelectedListingIds([])
                }}
              >
                Összes ({searchedAllegroListings.length})
              </button>

              <button
                className={
                  listingFilter === 'DIFFERENT'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('DIFFERENT')
                  setSelectedListingIds([])
                }}
              >
                Eltérő ({searchedDifferentListingsCount})
              </button>

              <button
                className={
                  listingFilter === 'UNSAVED'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('UNSAVED')
                  setSelectedListingIds([])
                }}
              >
                Nem mentett ({searchedUnsavedListingsCount})
              </button>

              <button
                className={
                  listingFilter === 'ACTIVE'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('ACTIVE')
                  setSelectedListingIds([])
                }}
              >
                Aktív ({searchedActiveListingsCount})
              </button>

              <button
                className={
                  listingFilter === 'INACTIVE'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('INACTIVE')
                  setSelectedListingIds([])
                }}
              >
                Inaktív ({searchedInactiveListingsCount})
              </button>

              <button
                className={
                  listingFilter === 'ENDED'
                    ? 'listing-filter-chip active'
                    : 'listing-filter-chip'
                }
                type="button"
                onClick={() => {
                  setListingFilter('ENDED')
                  setSelectedListingIds([])
                }}
              >
                Lejárt ({searchedEndedListingsCount})
              </button>
            </div>
          </div>

          <div className="bulk-toolbar">
            <label className="select-all-control">
              <input
                type="checkbox"
                checked={allListingsSelected}
                onChange={toggleAllListings}
              />
              <span>Aktuális oldal kijelölése</span>
            </label>

            <div className="bulk-toolbar-right">
              <span>
                {selectedListingIds.length} kijelölve ·{' '}
                {changedListingsCount} eltérő ajánlat ·{' '}
                {unsavedDesiredChangesCount} nem mentett
              </span>

                <button
                  className="bulk-sync-button bulk-save-button"
                  type="button"
                  disabled={
                    unsavedDesiredChangesCount === 0 ||
                    bulkSavingDesiredChanges ||
                    bulkSyncing
                  }
                  onClick={() =>
                    void saveAllDesiredChanges()
                  }
                >
                  {bulkSavingDesiredChanges
                    ? 'Mentés...'
                    : `Módosítások mentése (${unsavedDesiredChangesCount})`}
                </button>

                <button
                  className="bulk-sync-button bulk-discard-button"
                  type="button"
                  disabled={
                    (changedListingsCount === 0 &&
                      unsavedDesiredChangesCount === 0) ||
                    bulkSavingDesiredChanges ||
                    bulkSyncing ||
                    discardingDesiredChanges
                  }
                  onClick={() =>
                    void discardDesiredDifferences()
                  }
                >
                  {discardingDesiredChanges
                    ? 'Elvetés...'
                    : 'Módosítások elvetése'}
                </button>

                <button
                  className="bulk-sync-button"
                  type="button"
                  disabled={
                    selectedListingIds.length === 0 ||
                    selectedChangedListingsCount === 0 ||
                    bulkSyncing ||
                    bulkSavingDesiredChanges
                  }
                  onClick={() =>
                    void syncSelectedListingsToAllegro()
                  }
                >
                  {bulkSyncing
                    ? 'Szinkronizálás...'
                    : 'Kijelöltek szinkronizálása'}
                </button>

            </div>
          </div>

          {filteredAllegroListings.length > 0 && (
            <div className="campaign-pagination">
              <div className="campaign-pagination-size">
                <span>Sorok oldalanként</span>

                <select
                  value={listingPageSize}
                  onChange={(event) => {
                    const value =
                      Number(event.target.value)

                    if (
                      value === 25 ||
                      value === 50 ||
                      value === 100
                    ) {
                      setListingPageSize(value)
                    }
                  }}
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>

              <div className="campaign-pagination-info">
                {listingPageStart + 1}
                {'–'}
                {Math.min(
                  listingPageStart +
                    listingPageSize,
                  filteredAllegroListings.length,
                )}
                {' / '}
                {filteredAllegroListings.length}
                {' ajánlat'}
              </div>

              <div className="campaign-pagination-actions">
                <button
                  className="secondary-button campaign-pagination-button"
                  type="button"
                  aria-label="Előző oldal"
                  disabled={safeListingPage <= 1}
                  onClick={() =>
                    setListingPage(
                      Math.max(
                        1,
                        safeListingPage - 1,
                      ),
                    )
                  }
                >
                  ‹
                </button>

                <span>
                  {safeListingPage}
                  {' / '}
                  {listingPageCount}
                </span>

                <button
                  className="secondary-button campaign-pagination-button"
                  type="button"
                  aria-label="Következő oldal"
                  disabled={
                    safeListingPage >=
                    listingPageCount
                  }
                  onClick={() =>
                    setListingPage(
                      Math.min(
                        listingPageCount,
                        safeListingPage + 1,
                      ),
                    )
                  }
                >
                  ›
                </button>
              </div>
            </div>
          )}
          <div className="table-card">
            <table className="products-table allegro-table">
              <thead>
                <tr>
                  <th className="selection-column" />
                  <th>Cikkszám</th>
                  <th>Terméknév</th>
                  <th>Offer ID</th>
                  <th>Árkezelés</th>
                  <th>Készletkezelés</th>
                  <th>Eltérés</th>
                  <th>Státusz</th>
                  <th>Utolsó szinkron</th>
                  <th>Szinkron</th>
                </tr>
              </thead>

              <tbody>
                {paginatedAllegroListings.map((listing) => (
                  <tr
                    key={listing.id}
                    className={[
                      selectedListingIds.includes(
                        listing.id,
                      )
                        ? 'allegro-row-selected'
                        : '',
                      hasUnsavedDesiredPrice(listing) ||
                      hasUnsavedDesiredStock(listing) ||
                      hasUnsavedDesiredStatus(listing)
                        ? 'allegro-row-unsaved'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                      <td className="selection-column">
                        <input
                          type="checkbox"
                          checked={selectedListingIds.includes(
                            listing.id,
                          )}
                          onChange={() =>
                            toggleListingSelection(
                              listing.id,
                            )
                          }
                          aria-label={`${listing.sku} kijelölése`}
                        />
                      </td>
                    <td className="sku-cell">
                      {listing.sku}
                    </td>

                    <td>
                      <span className="listing-product-name-with-link">
                        <span>{listing.productName}</span>
                        {listing.offerId && (
                          <a
                            className="allegro-offer-link"
                            href={
                              'http:' +
                              '//' +
                              `${API_BASE_URL}/auth/allegro/open-offer/` +
                              encodeURIComponent(listing.offerId)
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Ajánlat megnyitása az Allegrón"
                            aria-label="Ajánlat megnyitása az Allegrón"
                            onClick={(event) => event.stopPropagation()}
                          >
                            ↗
                          </a>
                        )}
                      </span>
                    </td>

                    <td className="offer-id-cell">
                      {listing.offerId}
                    </td>

                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Alapár
                        </span>

                        <strong>
                          {formatMoney(
                            listing.desiredPriceMinor ??
                              listing.priceMinor,
                            listing.currency,
                          )}
                        </strong>
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-price-editor">
                          <div className="price-input-wrapper">
                            <input
                              className="price-input"
                              type="number"
                              min="0"
                              step="1"
                              value={
                                desiredPriceDrafts[
                                  listing.id
                                ] ??
                                (listing.desiredPriceMinor !== null
                                  ? String(
                                      listing.desiredPriceMinor / 100,
                                    )
                                  : '')
                              }
                              onChange={(event) =>
                                setDesiredPriceDrafts(
                                  (current) => ({
                                    ...current,
                                    [listing.id]:
                                      event.target.value,
                                  }),
                                )
                              }
                            />

                            <span>Ft</span>
                          </div>

                          
                        </div>
                      </div>

                      <div className="price-schedule-trigger">
                        {(() => {
                          const relevantSchedule =
                            getRelevantPriceSchedule(
                              priceSchedulesByListing[
                                listing.id
                              ] ?? [],
                            )

                          return relevantSchedule ? (
                            <div className="price-schedule-compact">
                              <div className="price-schedule-compact-main">
                                <span className="price-schedule-discount-label">
                                  Kedvezményes ár
                                </span>

                                <strong>
                                  {formatMoney(
                                    relevantSchedule.promotionalPriceMinor,
                                    listing.currency,
                                  )}
                                </strong>
                              </div>

                              <span className="price-schedule-period">
                                {formatPriceScheduleDateTime(
                                  relevantSchedule.validFrom,
                                )}
                                {' – '}
                                {formatPriceScheduleDateTime(
                                  relevantSchedule.validTo,
                                )}
                              </span>

                              {isAppliedPriceScheduleActive(relevantSchedule) && (
                                <span className="price-schedule-active-badge">
                                  <span className="price-schedule-active-dot" />
                                  Aktív kedvezmény
                                </span>
                              )}
                            </div>
                          ) : null
                        })()}

                        <button
                          className="price-schedule-open-button"
                          type="button"
                          onClick={() =>
                            openPriceScheduleDialog(listing)
                          }
                        >
                          {(priceSchedulesByListing[
                            listing.id
                          ] ?? []).some(
                            (schedule) =>
                              schedule.scheduleStatus ===
                                'ACTIVE' ||
                              schedule.scheduleStatus ===
                                'SCHEDULED',
                          )
                            ? 'Kedvezmény kezelése'
                            : '+ Időszakos kedvezmény'}
                        </button>
                      </div>

                      {priceScheduleDialogListingId ===
                        listing.id && (
                        <div
                          className="price-schedule-overlay"
                          role="presentation"
                          onMouseDown={closePriceScheduleDialog}
                        >
                          <div
                            className="price-schedule-modal"
                            role="dialog"
                            aria-modal="true"
                            aria-label="Időszakos kedvezmény"
                            onMouseDown={(event) =>
                              event.stopPropagation()
                            }
                          >
                            <div className="price-schedule-modal-header">
                              <div>
                                <span className="price-schedule-eyebrow">
                                  {listing.sku}
                                </span>
                                <h3>
                                  Időszakos kedvezmény
                                </h3>
                                <p>
                                  {listing.productName}
                                </p>
                              </div>

                              <button
                                className="price-schedule-close"
                                type="button"
                                aria-label="Bezárás"
                                onClick={closePriceScheduleDialog}
                              >
                                ×
                              </button>
                            </div>

                            <div className="price-schedule-reference-grid">
                              <div className="price-schedule-reference-card">
                                <span>
                                  Normál ár
                                </span>
                                <strong>
                                  {formatMoney(
                                    listing.desiredPriceMinor,
                                    listing.currency,
                                  )}
                                </strong>
                              </div>

                              <div className="price-schedule-reference-card">
                                <span>
                                  30 napos minimum
                                </span>
                                <strong>
                                  {formatMoney(
                                    priceHistoryByListing[
                                      listing.id
                                    ]?.min30PriceMinor ??
                                      null,
                                    listing.currency,
                                  )}
                                </strong>

                                {priceHistoryByListing[
                                  listing.id
                                ] && (
                                  <small>
                                    {priceHistoryByListing[
                                      listing.id
                                    ].hasFull30DayWindow
                                      ? '30 nap teljes'
                                      : `${priceHistoryByListing[
                                          listing.id
                                        ].coverageDayCount}/30 nap historika`}
                                  </small>
                                )}
                              </div>
                            </div>

                            <div className="price-schedule-form">
                              <label className="price-schedule-field">
                                <span>
                                  Kedvezményes ár
                                </span>

                                <div className="price-schedule-price-input">
                                  <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    placeholder="Pl. 16990"
                                    value={schedulePriceDraft}
                                    onChange={(event) =>
                                      setSchedulePriceDraft(
                                        event.target.value,
                                      )
                                    }
                                  />
                                  <span>Ft</span>
                                </div>
                              </label>

                              <div className="price-schedule-analysis">
                                <div>
                                  <span>Kedvezmény</span>
                                  <strong>
                                    {formatPriceScheduleDiscount(
                                      listing.desiredPriceMinor,
                                      schedulePriceDraft,
                                    )}
                                  </strong>
                                </div>

                                {(() => {
                                  const control =
                                    getPriceScheduleControl(
                                      listing.desiredPriceMinor,
                                      priceHistoryByListing[
                                        listing.id
                                      ]?.min30PriceMinor,
                                      priceHistoryByListing[
                                        listing.id
                                      ]?.hasFull30DayWindow,
                                      schedulePriceDraft,
                                    )

                                  return control ? (
                                    <span
                                      className={`price-schedule-control price-schedule-control-${control.tone}`}
                                    >
                                      {control.label}
                                    </span>
                                  ) : null
                                })()}
                              </div>

                              <div className="price-schedule-period-grid">
                                <label className="price-schedule-field">
                                  <span>Kezdés</span>
                                  <div className="price-schedule-date-time">
                                    <input
                                      type="date"
                                      disabled={isEditingActivePriceSchedule(listing.id)}
                                      onClick={(event) =>
                                        event.currentTarget.showPicker()
                                      }
                                      value={scheduleValidFromDraft}
                                      onChange={(event) =>
                                        setScheduleValidFromDraft(
                                          event.target.value,
                                        )
                                      }
                                    />
                                    <input
                                      type="time"
                                      disabled={isEditingActivePriceSchedule(listing.id)}
                                      onClick={(event) =>
                                        event.currentTarget.showPicker()
                                      }
                                      value={scheduleValidFromTimeDraft}
                                      onChange={(event) =>
                                        setScheduleValidFromTimeDraft(
                                          event.target.value,
                                        )
                                      }
                                    />
                                  </div>
                                </label>

                                <label className="price-schedule-field">
                                  <span>Vége</span>
                                  <div className="price-schedule-date-time">
                                    <input
                                      type="date"
                                      onClick={(event) =>
                                        event.currentTarget.showPicker()
                                      }
                                      value={scheduleValidToDraft}
                                      onChange={(event) =>
                                        setScheduleValidToDraft(
                                          event.target.value,
                                        )
                                      }
                                    />
                                    <input
                                      type="time"
                                      onClick={(event) =>
                                        event.currentTarget.showPicker()
                                      }
                                      value={scheduleValidToTimeDraft}
                                      onChange={(event) =>
                                        setScheduleValidToTimeDraft(
                                          event.target.value,
                                        )
                                      }
                                    />
                                  </div>
                                </label>
                              </div>

                              {(() => {
                                const promotionalPrice =
                                  Number(
                                    schedulePriceDraft.replace(
                                      ',',
                                      '.',
                                    ),
                                  )

                                const promotionalPriceMinor =
                                  Number.isFinite(
                                    promotionalPrice,
                                  ) &&
                                  promotionalPrice > 0
                                    ? Math.round(
                                        promotionalPrice * 100,
                                      )
                                    : null

                                if (
                                  promotionalPriceMinor ===
                                  null
                                ) {
                                  return null
                                }

                                return (
                                  <div className="price-schedule-flow-summary">
                                    <strong className="price-schedule-flow-title">
                                      Árváltás összefoglaló
                                    </strong>

                                    <div className="price-schedule-flow-row">
                                      <span>
                                        Kezdéskor
                                      </span>

                                      <div className="price-schedule-flow-prices">
                                        <span>
                                          <small>
                                            Normál ár
                                          </small>
                                          <strong>
                                            {formatMoney(
                                              listing.desiredPriceMinor,
                                              listing.currency,
                                            )}
                                          </strong>
                                        </span>

                                        <strong className="price-schedule-flow-arrow">
                                          →
                                        </strong>

                                        <span>
                                          <small>
                                            Kedvezményes ár
                                          </small>
                                          <strong>
                                            {formatMoney(
                                              promotionalPriceMinor,
                                              listing.currency,
                                            )}
                                          </strong>
                                        </span>
                                      </div>
                                    </div>

                                    <div className="price-schedule-flow-row">
                                      <span>
                                        Lejáratkor
                                      </span>

                                      <div className="price-schedule-flow-prices">
                                        <span>
                                          <small>
                                            Kedvezményes ár
                                          </small>
                                          <strong>
                                            {formatMoney(
                                              promotionalPriceMinor,
                                              listing.currency,
                                            )}
                                          </strong>
                                        </span>

                                        <strong className="price-schedule-flow-arrow">
                                          →
                                        </strong>

                                        <span>
                                          <small>
                                            Visszaáll erre
                                          </small>
                                          <strong>
                                            {formatMoney(
                                              listing.desiredPriceMinor,
                                              listing.currency,
                                            )}
                                          </strong>
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })()}

                              {priceScheduleError && (
                                <div className="price-schedule-error">
                                  {priceScheduleError}
                                </div>
                              )}

                              <div className="price-schedule-form-actions">
                                {editingPriceScheduleId && (
                                  <button
                                    className="price-schedule-secondary-button"
                                    type="button"
                                    onClick={resetPriceScheduleDraft}
                                  >
                                    Új ütemezés
                                  </button>
                                )}

                                <button
                                  className="price-schedule-primary-button"
                                  type="button"
                                  disabled={savingPriceSchedule}
                                  onClick={() =>
                                    void savePriceSchedule(
                                      listing,
                                    )
                                  }
                                >
                                  {savingPriceSchedule
                                    ? 'Mentés...'
                                    : editingPriceScheduleId
                                      ? 'Módosítás mentése'
                                      : 'Ütemezés mentése'}
                                </button>
                              </div>
                            </div>

                            {(priceSchedulesByListing[
                              listing.id
                            ] ?? []).some(
                              (schedule) =>
                                schedule.scheduleStatus !==
                                  'EXPIRED',
                            ) && (
                              <div className="price-schedule-existing">
                                <h4>
                                  Beállított időszakok
                                </h4>

                                {(priceSchedulesByListing[
                                  listing.id
                                ] ?? [])
                                  .filter(
                                    (schedule) =>
                                      schedule.scheduleStatus !==
                                        'EXPIRED',
                                  )
                                  .map(
                                    (schedule) => (
                                    <div
                                      className="price-schedule-existing-row"
                                      key={schedule.id}
                                    >
                                      <div>
                                        <div className="price-schedule-existing-main">
                                          <strong>
                                            {formatMoney(
                                              schedule.promotionalPriceMinor,
                                              listing.currency,
                                            )}
                                          </strong>
                                          <span
                                            className={`price-schedule-badge price-schedule-badge-${schedule.scheduleStatus.toLowerCase()}`}
                                          >
                                            {formatPriceScheduleStatus(
                                              schedule.scheduleStatus,
                                            )}
                                          </span>
                                        </div>

                                        <small>
                                          {formatPriceScheduleDateTime(
                                            schedule.validFrom,
                                          )}
                                          {' – '}
                                          {formatPriceScheduleDateTime(
                                            schedule.validTo,
                                          )}
                                        </small>
                                      </div>

                                      <div className="price-schedule-existing-actions">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            editPriceSchedule(
                                              schedule,
                                            )
                                          }
                                        >
                                          Szerkesztés
                                        </button>

                                        <button
                                          className="price-schedule-delete-button"
                                          type="button"
                                          disabled={
                                            deletingPriceScheduleId ===
                                              schedule.id
                                          }
                                          onClick={() =>
                                            void deletePriceSchedule(
                                              schedule,
                                            )
                                          }
                                        >
                                          {deletingPriceScheduleId ===
                                          schedule.id
                                            ? 'Törlés...'
                                            : 'Törlés'}
                                        </button>
                                      </div>
                                    </div>
                                  ),
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                    </td>

                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Aktuális
                        </span>

                        <strong>
                          {getEffectiveStockAvailable(listing) ?? '–'} db
                        </strong>
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-stock-editor">
                          <div className="stock-input-wrapper">
                            <input
                              className="stock-input"
                              type="number"
                              min="0"
                              step="1"
                              value={
                                desiredStockDrafts[
                                  listing.id
                                ] ??
                                (listing.desiredStock !== null
                                  ? String(
                                      listing.desiredStock,
                                    )
                                  : '')
                              }
                              onChange={(event) =>
                                setDesiredStockDrafts(
                                  (current) => ({
                                    ...current,
                                    [listing.id]:
                                      event.target.value,
                                  }),
                                )
                              }
                            />

                            <span>db</span>
                          </div>

                        <label className="stock-lock-control">
                          <input
                            type="checkbox"
                            checked={listing.stockLocked ?? false}
                            disabled={savingStockLockId === listing.id}
                            onChange={(event) =>
                              void updateStockLock(
                                listing,
                                event.target.checked,
                              )
                            }
                          />

                          <span>
                            Készlet rögzítve
                          </span>
                        </label>

                        {listing.stockLocked && (
                          <span className="stock-lock-helper">
                            Az automatikus készletszinkron nem írja felül.
                          </span>
                        )}

                          
                        </div>
                      </div>
                    </td>

                    <td>
                      <div className="difference-cell-content">
                        {!hasListingDifference(
                          listing,
                        ) ? (
                          <span className="sync-match">
                            Rendben
                          </span>
                        ) : (
                          <span className="sync-difference">
                            Eltérés
                          </span>
                        )}

                        {(hasUnsavedDesiredPrice(listing) ||
                          hasUnsavedDesiredStock(listing) ||
                          hasUnsavedDesiredStatus(listing)) && (
                          <span className="unsaved-badge">
                            Nem mentett
                          </span>
                        )}
                      </div>
                    </td>



                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Aktuális
                        </span>

                        <span
                          className={`listing-status listing-${listing.publicationStatus.toLowerCase()}`}
                        >
                          {formatListingStatus(listing.publicationStatus)}
                        </span>

                    {listing.publicationStatus === 'ENDED' && (
                      <span
                        className="listing-status-info"
                        title={getListingStatusInfo(listing) ?? undefined}
                        aria-label={getListingStatusInfo(listing) ?? 'Ajánlat információ'}
                      >
                        i
                      </span>
                    )}
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-price-editor">
                          <select
                            className="price-input status-select"
                            value={
                              desiredStatusDrafts[
                                listing.id
                              ] ??
                              (
                                listing.desiredPublicationStatus ===
                                  'ACTIVE' ||
                                listing.desiredPublicationStatus ===
                                  'INACTIVE'
                                  ? listing.desiredPublicationStatus
                                  : listing.publicationStatus ===
                                        'ACTIVE' ||
                                      listing.publicationStatus ===
                                        'ACTIVATING'
                                    ? 'ACTIVE'
                                    : 'INACTIVE'
                              )
                            }
                            onChange={(event) =>
                              setDesiredStatusDrafts(
                                (current) => ({
                                  ...current,
                                  [listing.id]:
                                    event.target.value as
                                      | 'ACTIVE'
                                      | 'INACTIVE',
                                }),
                              )
                            }
                          >
                            <option value="ACTIVE">
                              Aktív
                            </option>

                            <option value="INACTIVE">
                              Inaktív
                            </option>
                          </select>

                          
                        </div>
                      </div>
                    </td>

                    <td className="sync-cell">
                      {formatDate(
                        listing.lastSyncedAt,
                      )}
                    </td>
                    <td className="row-sync-cell">
                      <button
                        className="row-sync-button"
                        type="button"
                        disabled={
                          (!hasPriceDifference(listing) &&
                            getEffectiveStockAvailable(listing) ===
                              listing.desiredStock &&
                            !hasPublicationDifference(
                              listing,
                            )) ||
                          syncingWholeListingId ===
                            listing.id
                        }
                        onClick={() =>
                          void syncWholeListingToAllegro(
                            listing,
                          )
                        }
                      >
                        {syncingWholeListingId ===
                        listing.id
                          ? 'Szinkron...'
                          : 'Szinkronizálás'}
                      </button>
                    </td>
                  </tr>
                ))}

                {!loading &&
                  allegroListings.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="empty-state"
                      >
                        Nincs szinkronizált Allegro
                        ajánlat.
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    )
  }


  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />

          <div>
            <p className="eyebrow">KÄRCHER</p>
            <h1>Commerce Hub</h1>
          </div>
        </div>

        <div className="environment-badge">
          Helyi fejlesztői környezet
        </div>
      </header>

      <main className="content">
        <section className="hero">
          <div>
            <p className="section-label">RENDSZERÁLLAPOT</p>

            <h2>
              {apiHealth
                ? 'A Commerce Hub működik'
                : 'A frontend működik'}
            </h2>

            <p className="hero-text">
              A rendszer már valódi termék- és Allegro-adatokat
              olvas a Neon PostgreSQL-adatbázisból.
            </p>
          </div>

          <div className="hero-status">
            <span className="status-dot" />
            {apiHealth ? 'Rendszer aktív' : 'Frontend aktív'}
          </div>
        </section>

        <section>
          <div className="section-heading">
            <div>
              <p className="section-label">KOMPONENSEK</p>
              <h3>Fejlesztési állapot</h3>
            </div>

            <span>{services.length} komponens</span>
          </div>

          <div className="status-grid">
            {services.map((service) => (
              <article
                className="status-card"
                key={service.name}
              >
                <div className="card-header">
                  <h4>{service.name}</h4>

                  <span
                    className={`status-pill status-${service.status}`}
                  >
                    {statusLabel(service.status)}
                  </span>
                </div>

                <p>{service.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="products-section">
          <div className="section-heading">
            <div>
              <p className="section-label">TERMÉKTÖRZS</p>
              <h3>Termékek</h3>
            </div>

            <span>
              {loading
                ? 'Betöltés...'
                : `${products.length} termék`}
            </span>
          </div>

          <div className="table-card">
            <table className="products-table">
              <thead>
                <tr>
                  <th>Cikkszám</th>
                  <th>EAN</th>
                  <th>Terméknév</th>
                  <th>Termékvonal</th>
                  <th>Kategória</th>
                  <th>Státusz</th>
                </tr>
              </thead>

              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="sku-cell">
                      {product.sku}
                    </td>

                    <td>{getPrimaryEan(product)}</td>

                    <td>{product.name}</td>

                    <td>
                      {formatProductLine(
                        product.productLine,
                      )}
                    </td>

                    <td>{product.category ?? '–'}</td>

                    <td>
                      <span
                        className={`product-status ${
                          product.active
                            ? 'product-active'
                            : 'product-inactive'
                        }`}
                      >
                        {product.active
                          ? 'Aktív'
                          : 'Inaktív'}
                      </span>
                    </td>
                  </tr>
                ))}

                {!loading && products.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="empty-state"
                    >
                      Nincs megjeleníthető termék.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="next-step">
          <div className="step-number">06</div>

          <div>
            <p className="section-label">
              KÖVETKEZŐ LÉPÉS
            </p>

            <h3>Kívánt állapot és szinkron</h3>

            <p>
              Következőként összekötjük az Allegro aktuális
              állapotát a Commerce Hub kívánt állapotával, így
              kezelhetővé válik az ár, a készlet és később a
              kampányárak módosítása.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default HomePage
