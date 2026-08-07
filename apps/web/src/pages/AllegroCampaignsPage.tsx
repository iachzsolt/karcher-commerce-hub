import {
  useEffect,
  useState,
} from 'react'

type CampaignMessage = {
  text: string
  link: string | null
}

type RefusalReason = {
  code: string
  messages: CampaignMessage[]
}

type CampaignPeriod = {
  type: string
  from: string | null
  to: string | null
}

type AllegroCampaign = {
  id: string
  source: 'BADGE' | 'ALLE_DISCOUNT'
  name: string
  marketplace: {
    id: string
  }
  type: string
  eligibility: {
    eligible: boolean
    refusalReasons: RefusalReason[]
  }
  application: CampaignPeriod
  publication: CampaignPeriod
  visibility: CampaignPeriod
  regulationsLink: string | null
  stockReservationIsRequired: boolean
}

type AlleDiscountCampaign = {
  id: string
  name: string
  type?: string
  marketplace?: {
    id: string
  }
  application?: CampaignPeriod
  publication?: CampaignPeriod
  visibility?: CampaignPeriod
}

type AlleDiscountEligibleOffer = {
  id: string
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
  autoPriceSync: boolean | null
  autoStockSync: boolean | null
}

function formatDate(value: string | null) {
  if (!value) {
    return null
  }

  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function formatPrice(
  value: number | null,
  currency = 'HUF',
) {
  if (value === null) {
    return '–'
  }

  return new Intl.NumberFormat('hu-HU', {
    style: 'currency',
    currency,
    maximumFractionDigits:
      currency === 'HUF' ? 0 : 2,
  }).format(value / 100)
}

function formatCampaignDiscount(
  currentPriceMinor: number | null,
  campaignPriceValue: string | undefined,
) {
  if (
    currentPriceMinor === null ||
    currentPriceMinor <= 0 ||
    !campaignPriceValue
  ) {
    return '–'
  }

  const currentPrice =
    currentPriceMinor / 100

  const campaignPrice =
    Number(campaignPriceValue)

  if (
    !Number.isFinite(campaignPrice) ||
    campaignPrice < 0 ||
    campaignPrice > currentPrice
  ) {
    return '–'
  }

  const discount =
    ((currentPrice - campaignPrice) /
      currentPrice) *
    100

  return `${new Intl.NumberFormat(
    'hu-HU',
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    },
  ).format(discount)}%`
}
function getPriceHistoryControl(
  currentPriceMinor: number | null,
  min30PriceMinor: number | null | undefined,
  hasFull30DayWindow: boolean | undefined,
  campaignPriceValue: string | undefined,
) {
  if (!campaignPriceValue) {
    return null
  }

  const campaignPrice =
    Number(campaignPriceValue)

  if (
    !Number.isFinite(campaignPrice) ||
    campaignPrice <= 0
  ) {
    return null
  }

  const campaignPriceMinor =
    Math.round(campaignPrice * 100)

  if (
    currentPriceMinor !== null &&
    campaignPriceMinor >= currentPriceMinor
  ) {
    return {
      tone: 'error',
      label: '✕ Nem kedvezmény',
    }
  }

  if (
    min30PriceMinor === null ||
    min30PriceMinor === undefined
  ) {
    return null
  }

  if (campaignPriceMinor < min30PriceMinor) {
    return {
      tone: 'good',
      label: hasFull30DayWindow
        ? '✓ 30 napos minimum alatt'
        : '✓ Eddigi minimum alatt',
    }
  }

  if (campaignPriceMinor === min30PriceMinor) {
    return {
      tone: 'neutral',
      label: hasFull30DayWindow
        ? '= 30 napos minimummal'
        : '= Eddigi minimummal',
    }
  }

  return {
    tone: 'warning',
    label: hasFull30DayWindow
      ? '⚠ Volt már olcsóbb 30 napon belül'
      : '⚠ Eddig már volt olcsóbb',
  }
}
function getCampaignPeriod(
  campaign: AllegroCampaign,
) {
  const from = formatDate(
    campaign.publication.from,
  )

  const to = formatDate(
    campaign.publication.to,
  )

  if (from && to) {
    return `${from} – ${to}`
  }

  if (from) {
    return `${from}-tól`
  }

  if (to) {
    return `${to}-ig`
  }

  return 'Folyamatos'
}

function getApplicationLabel(type: string) {
  switch (type) {
    case 'ALWAYS':
      return 'Folyamatosan jelentkeztethető'

    case 'NEVER':
      return 'Nem jelentkeztethető manuálisan'

    case 'WITHIN':
      return 'Meghatározott időszakban'

    default:
      return type
  }
}

type CampaignPreparationState = {
  applicationStatus: string | null
  campaignStatus: string | null
  applicationError: string | null
  finishError: string | null
}
function formatPreparationStatus(
  state: CampaignPreparationState | undefined,
) {
  if (!state) return '–'

  if (state.campaignStatus === 'FINISHED') {
    return 'Lezárva'
  }

  if (state.campaignStatus === 'FINISHING') {
    return 'Lezárás...'
  }

  if (state.campaignStatus === 'FINISH_FAILED') {
    return 'Lezárási hiba'
  }

  if (
    state.campaignStatus === 'ACTIVE' ||
    state.applicationStatus === 'PROCESSED'
  ) {
    return 'Aktív'
  }

  if (state.applicationStatus === 'DECLINED') {
    return 'Elutasítva'
  }

  if (state.applicationStatus === 'REQUESTED') {
    return 'Feldolgozásra vár'
  }

  if (state.applicationStatus === 'SUBMITTING') {
    return 'Beküldés...'
  }

  if (state.applicationStatus === 'SUBMITTED') {
    return 'Beküldve'
  }

  if (state.applicationStatus === 'SCHEDULED') {
    return 'Ütemezve'
  }

  if (state.applicationStatus === 'PREPARED') {
    return 'Előkészítve'
  }

  if (state.applicationStatus === 'FAILED') {
    return 'Hiba'
  }

  return state.applicationStatus ?? '–'
}

function getPreparationError(
  state: CampaignPreparationState | undefined,
) {
  if (!state) {
    return null
  }

  return (
    state.finishError ??
    state.applicationError ??
    null
  )
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
const CAMPAIGN_TIME_ZONE =
  'Europe/Budapest'

function getBudapestDateTimeParts(
  value: string,
) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone: CAMPAIGN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      },
    )

  const parts =
    formatter.formatToParts(
      new Date(value),
    )

  const getPart = (type: string) =>
    parts.find(
      (part) => part.type === type,
    )?.value ?? ''

  return {
    date:
      `${getPart('year')}-${getPart('month')}-${getPart('day')}`,

    time:
      `${getPart('hour')}:${getPart('minute')}`,
  }
}

function getBudapestOffsetMilliseconds(
  date: Date,
) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone: CAMPAIGN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      },
    )

  const parts =
    formatter.formatToParts(date)

  const getNumber = (type: string) =>
    Number(
      parts.find(
        (part) => part.type === type,
      )?.value ?? 0,
    )

  const asUtc = Date.UTC(
    getNumber('year'),
    getNumber('month') - 1,
    getNumber('day'),
    getNumber('hour'),
    getNumber('minute'),
    getNumber('second'),
  )

  return asUtc - date.getTime()
}

function budapestLocalToIso(
  dateValue: string,
  timeValue: string,
) {
  const [year, month, day] =
    dateValue.split('-').map(Number)

  const [hour, minute] =
    timeValue.split(':').map(Number)

  const tentativeUtc =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        0,
        0,
      ),
    )

  let offset =
    getBudapestOffsetMilliseconds(
      tentativeUtc,
    )

  let utcDate =
    new Date(
      tentativeUtc.getTime() -
        offset,
    )

  const correctedOffset =
    getBudapestOffsetMilliseconds(
      utcDate,
    )

  if (correctedOffset !== offset) {
    utcDate =
      new Date(
        tentativeUtc.getTime() -
          correctedOffset,
      )
  }

  return utcDate.toISOString()
}
function AllegroCampaignsPage() {
  const [campaigns, setCampaigns] =
    useState<AllegroCampaign[]>([])

  const [listings, setListings] =
    useState<AllegroListing[]>([])

  const [
    priceHistoryByListing,
    setPriceHistoryByListing,
  ] = useState<
    Record<string, PriceHistorySummary>
  >({})

  const [
    selectedCampaignId,
    setSelectedCampaignId,
  ] = useState<string | null>(null)

  const [
    alleDiscountEligibleOfferIds,
    setAlleDiscountEligibleOfferIds,
  ] = useState<Set<string> | null>(null)

  const [
    ,
    setAlleDiscountEligibilityLoading,
  ] = useState(false)

  const selectedCampaign =
    campaigns.find(
      (campaign) =>
        campaign.id === selectedCampaignId,
    ) ?? null

  const [
    selectedListingIds,
    setSelectedListingIds,
  ] = useState<string[]>([])

  const [
    listingSearch,
    setListingSearch,
  ] = useState('')

  const [
    listingStatusFilter,
    setListingStatusFilter,
  ] = useState<
    'ALL' | 'ACTIVE' | 'ENDED'
  >('ALL')

  const [
    showSelectedOnly,
    setShowSelectedOnly,
  ] = useState(false)

  const [
    listingPage,
    setListingPage,
  ] = useState(1)

  const [
    listingPageSize,
    setListingPageSize,
  ] = useState(25)

  const normalizedListingSearch =
    listingSearch.trim().toLowerCase()

  const filteredListings =
    listings.filter((listing) => {
      const matchesSearch =
        !normalizedListingSearch ||
        listing.sku
          .toLowerCase()
          .includes(normalizedListingSearch) ||
        listing.productName
          .toLowerCase()
          .includes(normalizedListingSearch) ||
        listing.offerId
          .toLowerCase()
          .includes(normalizedListingSearch)

      const matchesStatus =
        listingStatusFilter === 'ALL' ||
        listing.publicationStatus ===
          listingStatusFilter

      const matchesSelection =
        !showSelectedOnly ||
        selectedListingIds.includes(
          listing.id,
        )

      const matchesCampaignEligibility =
        selectedCampaign?.source !==
          'ALLE_DISCOUNT' ||
        (
          alleDiscountEligibleOfferIds?.has(
            listing.offerId,
          ) ?? false
        )

      return (
        matchesSearch &&
        matchesStatus &&
        matchesSelection &&
        matchesCampaignEligibility
      )
    })

  const selectableFilteredListingIds =
    filteredListings
      .filter(
        (listing) =>
          selectedCampaign?.source !==
            'ALLE_DISCOUNT' &&
          listing.publicationStatus ===
            'ACTIVE',
      )
      .map((listing) => listing.id)

  const listingPageCount =
    Math.max(
      1,
      Math.ceil(
        filteredListings.length /
          listingPageSize,
      ),
    )

  const currentListingPage =
    Math.min(
      listingPage,
      listingPageCount,
    )

  const listingPageStart =
    (currentListingPage - 1) *
    listingPageSize

  const paginatedListings =
    filteredListings.slice(
      listingPageStart,
      listingPageStart +
        listingPageSize,
    )

  const [
    campaignPriceDrafts,
    setCampaignPriceDrafts,
  ] = useState<Record<string, string>>({})

  const [
    bulkDiscountPercent,
    setBulkDiscountPercent,
  ] = useState('')

  const [
    validFromDrafts,
    setValidFromDrafts,
  ] = useState<Record<string, string>>({})

  const [
    validToDrafts,
    setValidToDrafts,
  ] = useState<Record<string, string>>({})

  const [
    validFromTimeDrafts,
    setValidFromTimeDrafts,
  ] = useState<Record<string, string>>({})

  const [
    validToTimeDrafts,
    setValidToTimeDrafts,
  ] = useState<Record<string, string>>({})

  const [bulkValidFrom, setBulkValidFrom] =
    useState('')

  const [bulkValidFromTime, setBulkValidFromTime] =
    useState('00:00')

  const [bulkValidTo, setBulkValidTo] =
    useState('')

  const [bulkValidToTime, setBulkValidToTime] =
    useState('23:59')

  const [
    savingPreparations,
    setSavingPreparations,
  ] = useState(false)

  const [
    preparationMessage,
    setPreparationMessage,
  ] = useState<string | null>(null)

  const [
    preparationStatuses,
    setPreparationStatuses,
  ] = useState<
    Record<string, CampaignPreparationState>
  >({})

  const [
    schedulingPreparations,
    setSchedulingPreparations,
  ] = useState(false)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  async function loadData() {
    setLoading(true)
    setError(null)

    try {
      const [
        campaignsResponse,
        alleDiscountResponse,
        listingsResponse,
        priceHistoryResponse,
      ] = await Promise.all([
        fetch(
          'http://localhost:3000/auth/allegro/campaigns',
        ),
        fetch(
          'http://localhost:3000/auth/allegro/alle-discount/campaigns',
        ),
        fetch(
          'http://localhost:3000/allegro/listings',
        ),
        fetch(
          'http://localhost:3000/allegro/listing-price-history-summary',
        ),
      ])

      const campaignResult =
        await campaignsResponse.json()

      const alleDiscountResult =
        await alleDiscountResponse.json()

      const listingResult =
        await listingsResponse.json()

      const priceHistoryResult =
        await priceHistoryResponse.json()

      if (!campaignsResponse.ok) {
        throw new Error(
          campaignResult.message ??
            'Nem sikerült lekérni az Allegro kampányokat.',
        )
      }

      if (!listingsResponse.ok) {
        throw new Error(
          listingResult.message ??
            'Nem sikerült betölteni az Allegro-ajánlatokat.',
        )
      }

      if (!priceHistoryResponse.ok) {
        throw new Error(
          priceHistoryResult.message ??
            'Nem sikerült betölteni a 30 napos árhistorikát.',
        )
      }

      const badgeCampaigns =
        (
          campaignResult.data?.badgeCampaigns ??
          []
        ).map(
          (
            campaign: Omit<
              AllegroCampaign,
              'source'
            >,
          ) => ({
            ...campaign,
            source: 'BADGE' as const,
          }),
        )

      const alleDiscountCampaigns =
        alleDiscountResponse.ok
          ? (
              (
                alleDiscountResult.data
                  ?.alleDiscountCampaigns ??
                []
              ) as AlleDiscountCampaign[]
            )
              .filter(
                (campaign) =>
                  campaign.marketplace?.id ===
                  'allegro-hu',
              )
              .map(
                (campaign): AllegroCampaign => ({
                  id: campaign.id,
                  name: campaign.name,
                  source: 'ALLE_DISCOUNT',
                  type:
                    campaign.type ?? 'DISCOUNT',

                  marketplace: {
                    id:
                      campaign.marketplace?.id ??
                      'allegro-hu',
                  },

                  eligibility: {
                    eligible: true,
                    refusalReasons: [],
                  },

                  application:
                    campaign.application ?? {
                      type: 'ALWAYS',
                      from: null,
                      to: null,
                    },

                  publication:
                    campaign.publication ?? {
                      type: 'ALWAYS',
                      from: null,
                      to: null,
                    },

                  visibility:
                    campaign.visibility ?? {
                      type: 'ALWAYS',
                      from: null,
                      to: null,
                    },

                  regulationsLink: null,

                  stockReservationIsRequired:
                    false,
                }),
              )
          : []

      if (!alleDiscountResponse.ok) {
        console.warn(
          'AlleDiscount campaigns could not be loaded:',
          alleDiscountResult,
        )
      }

      setCampaigns([
        ...badgeCampaigns,
        ...alleDiscountCampaigns,
      ])

      setListings(
        listingResult.data ?? [],
      )

      const historyRows =
        (
          priceHistoryResult.data ?? []
        ) as PriceHistorySummary[]

      setPriceHistoryByListing(
        Object.fromEntries(
          historyRows.map((row) => [
            row.listingId,
            row,
          ]),
        ),
      )
    } catch (loadError) {
      console.error(
        'Allegro campaign data loading failed:',
        loadError,
      )

      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Nem sikerült betölteni az Allegro kampányadatokat.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadPreparations(
    campaignId: string,
  ) {
    const response = await fetch(
      `http://localhost:3000/allegro/remote-campaigns/${campaignId}/preparations`,
    )

    const result = await response.json()

    if (!response.ok) {
      throw new Error(
        result.message ??
          'Nem sikerült betölteni az előkészített ajánlatokat.',
      )
    }

    const preparedListings =
      result.data ?? []

    const selectedIds: string[] = []
    const prices: Record<string, string> = {}
    const starts: Record<string, string> = {}
    const ends: Record<string, string> = {}
    const startTimes: Record<string, string> = {}
    const endTimes: Record<string, string> = {}
    const statuses: Record<
      string,
      CampaignPreparationState
    > = {}

    preparedListings.forEach(
      (item: {
        listingId: string
        desiredPriceMinor: number | null
        validFrom: string | null
        validTo: string | null
        applicationStatus: string | null
        campaignStatus: string | null
        applicationError: string | null
        finishError: string | null
      }) => {
        selectedIds.push(item.listingId)

        if (item.desiredPriceMinor !== null) {
          prices[item.listingId] = String(
            item.desiredPriceMinor / 100,
          )
        }

        if (item.validFrom) {
          const parts =
            getBudapestDateTimeParts(
              item.validFrom,
            )

          starts[item.listingId] =
            parts.date

          startTimes[item.listingId] =
            parts.time
        }

        if (item.validTo) {
          const parts =
            getBudapestDateTimeParts(
              item.validTo,
            )

          ends[item.listingId] =
            parts.date

          endTimes[item.listingId] =
            parts.time
        }

        statuses[item.listingId] = {
          applicationStatus:
            item.applicationStatus,

          campaignStatus:
            item.campaignStatus,

          applicationError:
            item.applicationError,

          finishError:
            item.finishError,
        }
      },
    )

    setSelectedListingIds(selectedIds)
    setCampaignPriceDrafts(prices)
    setValidFromDrafts(starts)
    setValidToDrafts(ends)
    setValidFromTimeDrafts(startTimes)
    setValidToTimeDrafts(endTimes)
    setPreparationStatuses(statuses)
  }

  async function toggleCampaign(
    campaignId: string,
  ) {
    if (selectedCampaignId === campaignId) {
      setSelectedCampaignId(null)
      setSelectedListingIds([])
      setCampaignPriceDrafts({})
      setBulkDiscountPercent('')
      setValidFromDrafts({})
      setValidToDrafts({})
      setValidFromTimeDrafts({})
      setValidToTimeDrafts({})
      setBulkValidFrom('')
      setBulkValidFromTime('00:00')
      setBulkValidTo('')
      setBulkValidToTime('23:59')
      setPreparationMessage(null)
      setPreparationStatuses({})
      setAlleDiscountEligibleOfferIds(null)
      setAlleDiscountEligibilityLoading(false)
      return
    }

    const campaign =
      campaigns.find(
        (item) => item.id === campaignId,
      )

    setSelectedCampaignId(campaignId)
    setSelectedListingIds([])
    setCampaignPriceDrafts({})
    setBulkDiscountPercent('')
    setValidFromDrafts({})
    setValidToDrafts({})
    setValidFromTimeDrafts({})
    setValidToTimeDrafts({})
    setBulkValidFrom('')
    setBulkValidFromTime('00:00')
    setBulkValidTo('')
    setBulkValidToTime('23:59')
    setPreparationMessage(null)
    setPreparationStatuses({})
    setAlleDiscountEligibleOfferIds(null)

    if (
      campaign?.source ===
      'ALLE_DISCOUNT'
    ) {
      setAlleDiscountEligibilityLoading(true)

      try {
        setPreparationMessage(
          'Beküldhető ajánlatok ellenőrzése…',
        )

        const response = await fetch(
          `http://localhost:3000/auth/allegro/alle-discount/${encodeURIComponent(
            campaign.id,
          )}/eligible-offers?meetsConditions=true`,
        )

        const result =
          await response.json()

        if (!response.ok) {
          throw new Error(
            result.message ??
              'Nem sikerült ellenőrizni a kampány ajánlatait.',
          )
        }

        const eligibleOffers =
          (
            result.data?.eligibleOffers ??
            []
          ) as AlleDiscountEligibleOffer[]

        const offerIds =
          new Set(
            eligibleOffers.map(
              (offer) => offer.id,
            ),
          )

        setAlleDiscountEligibleOfferIds(
          offerIds,
        )

        const localEligibleCount =
          listings.filter(
            (listing) =>
              offerIds.has(
                listing.offerId,
              ),
          ).length

        setPreparationMessage(
          localEligibleCount === 0
            ? 'Ehhez a kampányhoz jelenleg nincs beküldhető ajánlat.'
            : `${localEligibleCount} beküldhető ajánlat található ehhez a kampányhoz.`,
        )
      } catch (loadError) {
        console.error(
          'AlleDiscount eligibility loading failed:',
          loadError,
        )

        setAlleDiscountEligibleOfferIds(
          new Set(),
        )

        setPreparationMessage(
          loadError instanceof Error
            ? loadError.message
            : 'Nem sikerült ellenőrizni a kampány ajánlatait.',
        )
      } finally {
        setAlleDiscountEligibilityLoading(
          false,
        )
      }

      return
    }

    try {
      await loadPreparations(campaignId)
    } catch (loadError) {
      console.error(
        'Preparation loading failed:',
        loadError,
      )

      setPreparationMessage(
        'A korábban előkészített ajánlatokat nem sikerült betölteni.',
      )
    }
  }
  function selectAllFilteredListings() {
    setSelectedListingIds(
      (current) =>
        Array.from(
          new Set([
            ...current,
            ...selectableFilteredListingIds,
          ]),
        ),
    )
  }

  function clearListingSelection() {
    setSelectedListingIds([])
  }
  function applyBulkDiscount() {
    const discount =
      Number(bulkDiscountPercent)

    if (
      selectedListingIds.length === 0 ||
      !Number.isFinite(discount) ||
      discount <= 0 ||
      discount >= 100
    ) {
      return
    }

    const selectedIds =
      new Set(selectedListingIds)

    setCampaignPriceDrafts(
      (current) => {
        const next = { ...current }

        listings.forEach((listing) => {
          if (
            !selectedIds.has(listing.id) ||
            listing.publicationStatus !==
              'ACTIVE' ||
            listing.priceMinor === null
          ) {
            return
          }

          const currentPrice =
            listing.priceMinor / 100

          const campaignPrice =
            Math.round(
              currentPrice *
                (1 - discount / 100),
            )

          next[listing.id] =
            String(campaignPrice)
        })

        return next
      },
    )
  }
  function applyBulkPeriod() {
    if (
      !bulkValidFrom ||
      !bulkValidFromTime ||
      !bulkValidTo ||
      !bulkValidToTime ||
      selectedListingIds.length === 0
    ) {
      return
    }

    setValidFromDrafts((current) => {
      const next = { ...current }

      selectedListingIds.forEach((listingId) => {
        next[listingId] = bulkValidFrom
      })

      return next
    })

    setValidFromTimeDrafts((current) => {
      const next = { ...current }

      selectedListingIds.forEach((listingId) => {
        next[listingId] =
          bulkValidFromTime
      })

      return next
    })

    setValidToDrafts((current) => {
      const next = { ...current }

      selectedListingIds.forEach((listingId) => {
        next[listingId] = bulkValidTo
      })

      return next
    })

    setValidToTimeDrafts((current) => {
      const next = { ...current }

      selectedListingIds.forEach((listingId) => {
        next[listingId] =
          bulkValidToTime
      })

      return next
    })
  }

  async function savePreparations(
    campaign: AllegroCampaign,
  ): Promise<boolean> {
    setPreparationMessage(null)

    if (selectedListingIds.length === 0) {
      setPreparationMessage(
        'Jelölj ki legalább egy ajánlatot.',
      )
      return false
    }

    for (const listingId of selectedListingIds) {
      const listing = listings.find(
        (item) => item.id === listingId,
      )

      if (
        !listing ||
        listing.publicationStatus !== 'ACTIVE'
      ) {
        setPreparationMessage(
          'Csak aktív Allegro-ajánlat készíthető elő kampányhoz.',
        )
        return false
      }

      const price = Number(
        campaignPriceDrafts[listingId],
      )

      const validFrom =
        validFromDrafts[listingId]

      const validTo =
        validToDrafts[listingId]

      const validFromTime =
        validFromTimeDrafts[listingId] ??
        '00:00'

      const validToTime =
        validToTimeDrafts[listingId] ??
        '23:59'

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        setPreparationMessage(
          `Hiányzó vagy hibás kampányár: ${listing.sku}`,
        )
        return false
      }

      if (
        !validFrom ||
        !validFromTime ||
        !validTo ||
        !validToTime
      ) {
        setPreparationMessage(
          `Hiányzó időszak: ${listing.sku}`,
        )
        return false
      }

      const validFromIso =
        budapestLocalToIso(
          validFrom,
          validFromTime,
        )

      const validToIso =
        budapestLocalToIso(
          validTo,
          validToTime,
        )

      if (
        new Date(validToIso) <
        new Date(validFromIso)
      ) {
        setPreparationMessage(
          `A zárási időpont nem lehet korábbi a kezdésnél: ${listing.sku}`,
        )
        return false
      }

      if (
        campaign.publication.from &&
        new Date(validFromIso) <
          new Date(
            campaign.publication.from,
          )
      ) {
        setPreparationMessage(
          `Az ajánlat kezdete a kampány időszaka elé esik: ${listing.sku}`,
        )
        return false
      }

      if (
        campaign.publication.to &&
        new Date(validToIso) >
          new Date(
            campaign.publication.to,
          )
      ) {
        setPreparationMessage(
          `Az ajánlat vége a kampány időszaka utánra esik: ${listing.sku}`,
        )
        return false
      }
    }

    setSavingPreparations(true)

    try {
      const response = await fetch(
        `http://localhost:3000/allegro/remote-campaigns/${campaign.id}/preparations`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            campaign: {
              name: campaign.name,
              type: campaign.type,
              marketplace:
                campaign.marketplace.id,
              publicationFrom:
                campaign.publication.from,
              publicationTo:
                campaign.publication.to,
            },

            listings:
              selectedListingIds.map(
                (listingId) => ({
                  listingId,

                  desiredPrice: Number(
                    campaignPriceDrafts[
                      listingId
                    ],
                  ),

                  validFrom:
                    budapestLocalToIso(
                      validFromDrafts[
                        listingId
                      ],
                      validFromTimeDrafts[
                        listingId
                      ] ?? '00:00',
                    ),

                  validTo:
                    budapestLocalToIso(
                      validToDrafts[
                        listingId
                      ],
                      validToTimeDrafts[
                        listingId
                      ] ?? '23:59',
                    ),
                }),
              ),
          }),
        },
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Nem sikerült menteni az előkészítést.',
        )
      }

      setPreparationMessage(
        `${result.count} ajánlat előkészítése elmentve.`,
      )

      await loadPreparations(
        campaign.id,
      )

      return true
    } catch (saveError) {
      console.error(
        'Preparation saving failed:',
        saveError,
      )

      setPreparationMessage(
        saveError instanceof Error
          ? saveError.message
          : 'Nem sikerült menteni az előkészítést.',
      )

      return false
    } finally {
      setSavingPreparations(false)
    }
  }
  async function finalizeSchedule(
    campaign: AllegroCampaign,
  ) {
    setPreparationMessage(null)

    if (hasInvalidSelectedCampaignPrice) {
      setPreparationMessage(
        'A kampányárnak minden kijelölt ajánlatnál alacsonyabbnak kell lennie az aktuális árnál.',
      )
      return
    }

    const saved =
      await savePreparations(campaign)

    if (!saved) {
      return
    }

    setSchedulingPreparations(true)

    try {
      const response = await fetch(
        `http://localhost:3000/allegro/remote-campaigns/${campaign.id}/schedule`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingIds:
              selectedListingIds,
          }),
        },
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Nem sikerült véglegesíteni az ütemezést.',
        )
      }

      setPreparationMessage(
        `${result.count} ajánlat ütemezése véglegesítve.`,
      )

      await loadPreparations(
        campaign.id,
      )
    } catch (scheduleError) {
      console.error(
        'Campaign scheduling failed:',
        scheduleError,
      )

      setPreparationMessage(
        scheduleError instanceof Error
          ? scheduleError.message
          : 'Nem sikerült véglegesíteni az ütemezést.',
      )
    } finally {
      setSchedulingPreparations(false)
    }
  }
  function toggleListing(
    listingId: string,
  ) {
    setSelectedListingIds((current) => {
      if (current.includes(listingId)) {
        return current.filter(
          (id) => id !== listingId,
        )
      }

      return [...current, listingId]
    })
  }

  useEffect(() => {
    void loadData()
  }, [])

  const hasInvalidSelectedCampaignPrice =
    selectedListingIds.some((listingId) => {
      const listing = listings.find(
        (item) => item.id === listingId,
      )

      const priceValue =
        campaignPriceDrafts[listingId]

      if (
        !listing ||
        listing.priceMinor === null ||
        !priceValue
      ) {
        return false
      }

      const campaignPrice =
        Number(priceValue)

      if (!Number.isFinite(campaignPrice)) {
        return false
      }

      return (
        Math.round(campaignPrice * 100) >=
        listing.priceMinor
      )
    })

  return (
    <section className="campaigns-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">
            ALLEGRO
          </p>

          <h2>Kampányok</h2>

          <p className="campaigns-page-description">
            Az Allegro által elérhetővé tett magyar
            kampányok és a hozzájuk tartozó
            jelentkezési feltételek.
          </p>
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={() => void loadData()}
          disabled={loading}
        >
          {loading
            ? 'Frissítés…'
            : 'Kampányok frissítése'}
        </button>
      </div>

      {error && (
        <div className="campaign-message campaign-message-error">
          {error}
        </div>
      )}

      {loading && campaigns.length === 0 && (
        <div className="campaign-message">
          Allegro kampányok lekérése…
        </div>
      )}

      {!loading &&
        !error &&
        campaigns.length === 0 && (
          <div className="campaign-empty-state">
            <h3>Nincs elérhető kampány</h3>

            <p>
              Az Allegro jelenleg nem adott vissza
              kampányt az allegro-hu piactérhez.
            </p>
          </div>
        )}

      <div className="campaign-list">
        {campaigns.map((campaign) => {
          const selected =
            selectedCampaignId === campaign.id

          const manualApplication =
            campaign.application.type !== 'NEVER'

          const canSubmit =
            campaign.source === 'BADGE' &&
            campaign.eligibility.eligible &&
            manualApplication

          return (
            <article
              className={`campaign-card${
                selected
                  ? ' campaign-card-selected'
                  : ''
              }`}
              key={campaign.id}
            >
              <div className="campaign-card-header">
                <div className="campaign-card-main">
                  <div className="campaign-card-title-row">
                    <h3>{campaign.name}</h3>

                    <span className="campaign-status-badge">
                      {campaign.type}
                    </span>

                    <span
                      className={
                        campaign.eligibility.eligible
                          ? 'campaign-eligibility campaign-eligible'
                          : 'campaign-eligibility campaign-ineligible'
                      }
                    >
                      {campaign.source ===
                      'ALLE_DISCOUNT'
                        ? 'Ajánlatszintű ellenőrzés'
                        : campaign.eligibility.eligible
                          ? 'Jogosult'
                          : 'Nem jogosult'}
                    </span>
                  </div>

                  <div className="campaign-meta">
                    <span>
                      {getCampaignPeriod(
                        campaign,
                      )}
                    </span>

                    <span>•</span>

                    <span>
                      {getApplicationLabel(
                        campaign.application.type,
                      )}
                    </span>

                    <span>•</span>

                    <span>
                      {campaign.stockReservationIsRequired
                        ? 'Kampánykészlet szükséges'
                        : 'Nem szükséges kampánykészlet'}
                    </span>
                  </div>
                </div>

                <div className="campaign-card-actions">
                  <button
                    type="button"
                    className={
                      selected
                        ? 'secondary-button'
                        : 'campaign-primary-button'
                    }
                    onClick={() =>
                      void toggleCampaign(campaign.id)
                    }
                  >
                    {selected
                      ? 'Bezárás'
                      : 'Kampány megnyitása'}
                  </button>
                </div>
              </div>

              {campaign.source === 'BADGE' &&
                !campaign.eligibility.eligible &&
                campaign.eligibility.refusalReasons.length >
                  0 && (
                  <div className="campaign-refusal">
                    <strong>
                      Miért nem jogosult a fiók?
                    </strong>

                    {campaign.eligibility.refusalReasons.map(
                      (reason) => (
                        <div
                          className="campaign-refusal-reason"
                          key={reason.code}
                        >
                          {reason.messages.map(
                            (message, index) => (
                              <p
                                key={`${reason.code}-${index}`}
                              >
                                {message.text}

                                {message.link && (
                                  <>
                                    {' '}
                                    <a
                                      href={message.link}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Részletek
                                    </a>
                                  </>
                                )}
                              </p>
                            ),
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}

              <div className="campaign-detail-row">
                <div>
                  <span className="campaign-detail-label">
                    Kampányazonosító
                  </span>

                  <strong>
                    {campaign.id}
                  </strong>
                </div>

                <div>
                  <span className="campaign-detail-label">
                    Marketplace
                  </span>

                  <strong>
                    {campaign.marketplace.id}
                  </strong>
                </div>

                <div>
                  <span className="campaign-detail-label">
                    Jelentkezés
                  </span>

                  <strong>
                    {campaign.application.type}
                  </strong>
                </div>

                {campaign.regulationsLink && (
                  <div>
                    <span className="campaign-detail-label">
                      Feltételek
                    </span>

                    <a
                      href={campaign.regulationsLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Szabályzat megnyitása
                    </a>
                  </div>
                )}
              </div>

              {selected && (
                <div className="campaign-offers-panel">
                  <div className="campaign-offers-heading">
                    <div>
                      <p className="section-label">
                        AJÁNLATOK
                      </p>

                      <h4>
                        Kedvezményes ajánlatok
                      </h4>

                      <p>
                        Jelöld ki a kampányba
                        beküldendő ajánlatokat, majd
                        add meg a kívánt kampányárat.
                      </p>
                    </div>

                    <div className="campaign-selection-count">
                      {selectedListingIds.length}
                      {' '}
                      ajánlat kijelölve
                    </div>
                  </div>

                  {!canSubmit && (
                    <div className="campaign-submit-warning">
                      {campaign.application.type ===
                      'NEVER'
                        ? 'Ez a kampány nem kezel manuális ajánlatjelentkezést.'
                        : 'A fiók jelenleg nem jogosult a kampányba történő beküldésre. Az ajánlatokat és árakat ettől függetlenül előkészítheted.'}
                    </div>
                  )}

                  <div className="campaign-offer-toolbar">
                    <div className="campaign-offer-search">
                      <span className="campaign-offer-search-icon">
                        ⌕
                      </span>

                      <input
                        type="search"
                        placeholder="Keresés SKU, terméknév vagy Allegro ID alapján..."
                        value={listingSearch}
                        onChange={(event) => {
                          setListingSearch(
                            event.target.value,
                          )
                          setListingPage(1)
                        }}
                      />
                    </div>

                    <select
                      className="campaign-offer-filter"
                      value={listingStatusFilter}
                      onChange={(event) => {
                        setListingStatusFilter(
                          event.target.value as
                            | 'ALL'
                            | 'ACTIVE'
                            | 'ENDED',
                        )
                        setListingPage(1)
                      }}
                    >
                      <option value="ALL">
                        Minden státusz
                      </option>

                      <option value="ACTIVE">
                        Aktív
                      </option>

                      <option value="ENDED">
                        Lejárt
                      </option>
                    </select>

                    <label className="campaign-selected-filter">
                      <input
                        type="checkbox"
                        checked={showSelectedOnly}
                        onChange={(event) => {
                          setShowSelectedOnly(
                            event.target.checked,
                          )
                          setListingPage(1)
                        }}
                      />

                      <span>
                        Csak kijelöltek
                      </span>
                    </label>

                    <div className="campaign-filter-count">
                      <strong>
                        {filteredListings.length}
                      </strong>

                      <span>
                        / {listings.length} ajánlat
                      </span>
                    </div>

                    <div className="campaign-filter-actions">
                      <button
                        type="button"
                        className="secondary-button campaign-compact-button"
                        onClick={
                          selectAllFilteredListings
                        }
                        disabled={
                          selectableFilteredListingIds.length ===
                          0
                        }
                      >
                        Összes szűrt kijelölése
                      </button>

                      <button
                        type="button"
                        className="secondary-button campaign-compact-button"
                        onClick={
                          clearListingSelection
                        }
                        disabled={
                          selectedListingIds.length ===
                          0
                        }
                      >
                        Kijelölések törlése
                      </button>
                    </div>
                  </div>

                  <div className="campaign-bulk-discount">
                    <div>
                      <span className="campaign-detail-label">
                        Kedvezmény a kijelölt ajánlatokra
                      </span>

                      <div className="campaign-bulk-discount-fields">
                        <div className="campaign-discount-input">
                          <input
                            type="number"
                            min="0.1"
                            max="99.9"
                            step="0.1"
                            placeholder="Pl. 15"
                            value={bulkDiscountPercent}
                            onChange={(event) =>
                              setBulkDiscountPercent(
                                event.target.value,
                              )
                            }
                          />

                          <span>%</span>
                        </div>

                        <button
                          type="button"
                          className="secondary-button"
                          onClick={applyBulkDiscount}
                          disabled={
                            selectedListingIds.length === 0 ||
                            !bulkDiscountPercent ||
                            Number(
                              bulkDiscountPercent,
                            ) <= 0 ||
                            Number(
                              bulkDiscountPercent,
                            ) >= 100
                          }
                        >
                          Kedvezmény alkalmazása
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="campaign-bulk-period">
                    <div>
                      <span className="campaign-detail-label">
                        Időszak a kijelölt ajánlatokra
                      </span>

                      <div className="campaign-bulk-period-fields">
                        <label>
                          <span>Mettől</span>

                          <div className="campaign-date-time-inputs">
                            <input
                              type="date"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                              value={bulkValidFrom}
                              min={
                                campaign.publication.from
                                  ? campaign.publication.from.slice(0, 10)
                                  : undefined
                              }
                              max={
                                campaign.publication.to
                                  ? campaign.publication.to.slice(0, 10)
                                  : undefined
                              }
                              onChange={(event) =>
                                setBulkValidFrom(
                                  event.target.value,
                                )
                              }
                            />

                            <input
                              type="time"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                              step="60"
                              value={bulkValidFromTime}
                              onChange={(event) =>
                                setBulkValidFromTime(
                                  event.target.value,
                                )
                              }
                            />
                          </div>
                        </label>

                        <label>
                          <span>Meddig</span>

                          <div className="campaign-date-time-inputs">
                            <input
                              type="date"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                              value={bulkValidTo}
                              min={
                                bulkValidFrom ||
                                (campaign.publication.from
                                  ? campaign.publication.from.slice(0, 10)
                                  : undefined)
                              }
                              max={
                                campaign.publication.to
                                  ? campaign.publication.to.slice(0, 10)
                                  : undefined
                              }
                              onChange={(event) =>
                                setBulkValidTo(
                                  event.target.value,
                                )
                              }
                            />

                            <input
                              type="time"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                              step="60"
                              value={bulkValidToTime}
                              onChange={(event) =>
                                setBulkValidToTime(
                                  event.target.value,
                                )
                              }
                            />
                          </div>
                        </label>

                        <button
                          type="button"
                          className="secondary-button"
                          onClick={applyBulkPeriod}
                          disabled={
                            selectedListingIds.length === 0 ||
                            !bulkValidFrom ||
                            !bulkValidFromTime ||
                            !bulkValidTo ||
                            !bulkValidToTime
                          }
                        >
                          Alkalmazás a kijelöltekre
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="campaign-offers-table-wrapper">
                    <table className="campaign-offers-table">
                      <thead>
                        <tr>
                          <th />
                          <th>SKU</th>
                          <th>Termék</th>
                          <th>Allegro ID</th>
                          <th>Aktuális ár</th>
                          <th>30 napos min.</th>
                          <th>Kampányár</th>
                          <th>Kedvezmény</th>
                          <th>Mettől</th>
                          <th>Meddig</th>
                          <th>Kampány státusz</th>
                          <th>Ajánlat státusz</th>
                        </tr>
                      </thead>

                      <tbody>
                        {paginatedListings.map((listing) => {
                          const checked =
                            selectedListingIds.includes(
                              listing.id,
                            )

                          const priceHistory =
                            priceHistoryByListing[
                              listing.id
                            ]

                          const priceHistoryControl =
                            getPriceHistoryControl(
                              listing.priceMinor,
                              priceHistory?.min30PriceMinor,
                              priceHistory?.hasFull30DayWindow,
                              campaignPriceDrafts[
                                listing.id
                              ],
                            )

                          return (
                            <tr key={listing.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={
                                    campaign.source ===
                                      'ALLE_DISCOUNT' ||
                                    listing.publicationStatus !==
                                      'ACTIVE'
                                  }
                                  onChange={() =>
                                    toggleListing(
                                      listing.id,
                                    )
                                  }
                                />
                              </td>

                              <td>
                                <strong>
                                  {listing.sku}
                                </strong>
                              </td>

                              <td>
                                {listing.productName}
                              </td>

                              <td>
                                {listing.offerId}
                              </td>

                              <td>
                                {formatPrice(
                                  listing.priceMinor,
                                  listing.currency,
                                )}
                              </td>

                              <td>
                                <div className="campaign-history-price">
                                  <strong>
                                    {formatPrice(
                                      priceHistory?.min30PriceMinor ??
                                        null,
                                      listing.currency,
                                    )}
                                  </strong>

                                  {priceHistory && (
                                    <span
                                      className={
                                        priceHistory.hasFull30DayWindow
                                          ? 'campaign-history-complete'
                                          : 'campaign-history-partial'
                                      }
                                    >
                                      {priceHistory.hasFull30DayWindow
                                        ? '30 nap teljes'
                                        : `${priceHistory.coverageDayCount}/30 nap historika`}
                                    </span>
                                  )}

                                  {priceHistoryControl && (
                                    <span
                                      className={`campaign-history-control campaign-history-control-${priceHistoryControl.tone}`}
                                    >
                                      {priceHistoryControl.label}
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td>
                                <div className="campaign-price-input">
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    placeholder="Pl. 13990"
                                    value={
                                      campaignPriceDrafts[
                                        listing.id
                                      ] ?? ''
                                    }
                                    onChange={(event) =>
                                      setCampaignPriceDrafts(
                                        (current) => ({
                                          ...current,
                                          [listing.id]:
                                            event.target.value,
                                        }),
                                      )
                                    }
                                    disabled={!checked}
                                  />

                                  <span>Ft</span>
                                </div>
                              </td>

                              <td className="campaign-row-discount">
                                {formatCampaignDiscount(
                                  listing.priceMinor,
                                  campaignPriceDrafts[
                                    listing.id
                                  ],
                                )}
                              </td>

                              <td>
                                <div className="campaign-date-time-inputs campaign-row-date-time">
                                  <input
                                    className="campaign-date-input"
                                    type="date"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                                    value={
                                      validFromDrafts[
                                        listing.id
                                      ] ?? ''
                                    }
                                    min={
                                      campaign.publication.from
                                        ? campaign.publication.from.slice(0, 10)
                                        : undefined
                                    }
                                    max={
                                      campaign.publication.to
                                        ? campaign.publication.to.slice(0, 10)
                                        : undefined
                                    }
                                    disabled={!checked}
                                    onChange={(event) =>
                                      setValidFromDrafts(
                                        (current) => ({
                                          ...current,
                                          [listing.id]:
                                            event.target.value,
                                        }),
                                      )
                                    }
                                  />

                                  <input
                                    className="campaign-time-input"
                                    type="time"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                                    step="60"
                                    value={
                                      validFromTimeDrafts[
                                        listing.id
                                      ] ?? '00:00'
                                    }
                                    disabled={!checked}
                                    onChange={(event) =>
                                      setValidFromTimeDrafts(
                                        (current) => ({
                                          ...current,
                                          [listing.id]:
                                            event.target.value,
                                        }),
                                      )
                                    }
                                  />
                                </div>
                              </td>

                              <td>
                                <div className="campaign-date-time-inputs campaign-row-date-time">
                                  <input
                                    className="campaign-date-input"
                                    type="date"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                                    value={
                                      validToDrafts[
                                        listing.id
                                      ] ?? ''
                                    }
                                    min={
                                      validFromDrafts[
                                        listing.id
                                      ] ||
                                      (campaign.publication.from
                                        ? campaign.publication.from.slice(0, 10)
                                        : undefined)
                                    }
                                    max={
                                      campaign.publication.to
                                        ? campaign.publication.to.slice(0, 10)
                                        : undefined
                                    }
                                    disabled={!checked}
                                    onChange={(event) =>
                                      setValidToDrafts(
                                        (current) => ({
                                          ...current,
                                          [listing.id]:
                                            event.target.value,
                                        }),
                                      )
                                    }
                                  />

                                  <input
                                    className="campaign-time-input"
                                    type="time"
                                    onClick={(event) =>
                                      event.currentTarget.showPicker()
                                    }
                                    step="60"
                                    value={
                                      validToTimeDrafts[
                                        listing.id
                                      ] ?? '23:59'
                                    }
                                    disabled={!checked}
                                    onChange={(event) =>
                                      setValidToTimeDrafts(
                                        (current) => ({
                                          ...current,
                                          [listing.id]:
                                            event.target.value,
                                        }),
                                      )
                                    }
                                  />
                                </div>
                              </td>

                              <td>
                                <div className="campaign-preparation-state">
                                  <span className="campaign-preparation-status">
                                    {formatPreparationStatus(
                                      preparationStatuses[
                                        listing.id
                                      ],
                                    )}
                                  </span>

                                  {getPreparationError(
                                    preparationStatuses[
                                      listing.id
                                    ],
                                  ) && (
                                    <span
                                      className="campaign-status-info"
                                      data-tooltip={
                                        getPreparationError(
                                          preparationStatuses[
                                            listing.id
                                          ],
                                        ) ?? undefined
                                      }
                                      aria-label="Részletek"
                                      tabIndex={0}
                                    >
                                      ⓘ
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td>
                                {formatListingStatus(
                                  listing.publicationStatus,
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {filteredListings.length > 0 && (
                    <div className="campaign-pagination">
                      <div className="campaign-pagination-size">
                        <span>
                          Sorok oldalanként
                        </span>

                        <select
                          value={listingPageSize}
                          onChange={(event) => {
                            setListingPageSize(
                              Number(
                                event.target.value,
                              ),
                            )
                            setListingPage(1)
                          }}
                        >
                          <option value={25}>
                            25
                          </option>

                          <option value={50}>
                            50
                          </option>

                          <option value={100}>
                            100
                          </option>
                        </select>
                      </div>

                      <div className="campaign-pagination-info">
                        {listingPageStart + 1}
                        {' – '}
                        {Math.min(
                          listingPageStart +
                            listingPageSize,
                          filteredListings.length,
                        )}
                        {' / '}
                        {filteredListings.length}
                      </div>

                      <div className="campaign-pagination-actions">
                        <button
                          type="button"
                          className="secondary-button campaign-pagination-button"
                          disabled={
                            currentListingPage <= 1
                          }
                          onClick={() =>
                            setListingPage(
                              Math.max(
                                1,
                                currentListingPage - 1,
                              ),
                            )
                          }
                        >
                          ‹
                        </button>

                        <span>
                          {currentListingPage}
                          {' / '}
                          {listingPageCount}
                        </span>

                        <button
                          type="button"
                          className="secondary-button campaign-pagination-button"
                          disabled={
                            currentListingPage >=
                            listingPageCount
                          }
                          onClick={() =>
                            setListingPage(
                              Math.min(
                                listingPageCount,
                                currentListingPage + 1,
                              ),
                            )
                          }
                        >
                          ›
                        </button>
                      </div>
                    </div>
                  )}

                  {preparationMessage && (
                    <div className="campaign-preparation-message">
                      {preparationMessage}
                    </div>
                  )}

                  <div className="campaign-submit-bar">
                    <span>
                      {selectedListingIds.length}
                      {' '}
                      ajánlat kijelölve
                    </span>

                    <div className="campaign-submit-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          savingPreparations ||
                          selectedListingIds.length === 0
                        }
                        onClick={() =>
                          void savePreparations(
                            campaign,
                          )
                        }
                      >
                        {savingPreparations
                          ? 'Mentés…'
                          : 'Előkészítés mentése'}
                      </button>

                      <button
                        type="button"
                        className="campaign-primary-button"
                        disabled={
                          schedulingPreparations ||
                          selectedListingIds.length === 0 ||
                          hasInvalidSelectedCampaignPrice
                        }
                        onClick={() =>
                          void finalizeSchedule(
                            campaign,
                          )
                        }
                      >
                        {schedulingPreparations
                          ? 'Véglegesítés…'
                          : 'Ütemezés véglegesítése'}
                      </button>

                      <button
                        type="button"
                        className="campaign-primary-button"
                        disabled={
                          !canSubmit ||
                          selectedListingIds.length === 0
                        }
                      >
                        Kijelölt ajánlatok beküldése
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default AllegroCampaignsPage