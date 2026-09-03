import {
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

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

  alleDiscount?: {
    campaignConditions?: {
      meetsConditions: boolean
      violations: Array<{
        code?: string
        message?: string
      }>
    }

    requiredMerchantPrice?: {
      amount: string
      currency: string
    } | null

    minimumGuaranteedDiscount?: {
      percentage: string
    } | null
  }
}
type PriceHistorySummary = {
  listingId: string
  min30PriceMinor: number | null
  campaignReferenceMin30PriceMinor: number | null
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
  referencePriceMinor: number | null | undefined,
  campaignPriceValue: string | undefined,
) {
  if (
    referencePriceMinor === null ||
    referencePriceMinor === undefined ||
    referencePriceMinor <= 0 ||
    !campaignPriceValue
  ) {
    return '–'
  }

  const referencePrice =
    referencePriceMinor / 100

  const campaignPrice =
    Number(campaignPriceValue)

  if (
    !Number.isFinite(campaignPrice) ||
    campaignPrice < 0 ||
    campaignPrice > referencePrice
  ) {
    return '–'
  }

  const discount =
    ((referencePrice - campaignPrice) /
      referencePrice) *
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
    state.campaignStatus === 'DECLINED' ||
    state.applicationStatus === 'DECLINED'
  ) {
    return 'Elutasítva'
  }

  if (
    state.campaignStatus === 'IN_VERIFICATION'
  ) {
    return 'Ellenőrzés alatt'
  }

  if (
    state.campaignStatus ===
      'WAITING_FOR_PUBLICATION'
  ) {
    return 'Közzétételre vár'
  }

  if (
    state.campaignStatus === 'AWAITING_BADGE'
  ) {
    return 'Kampánystátuszra vár'
  }

  if (state.campaignStatus === 'ACTIVE') {
    return 'Aktív'
  }

  if (
    state.applicationStatus === 'PROCESSED'
  ) {
    return 'Feldolgozva'
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

  if (
    state.applicationStatus ===
    'SUBMISSION_UNKNOWN'
  ) {
    return 'Kézi ellenőrzés szükséges'
  }

  return state.applicationStatus ?? '–'
}

function getPreparationStatusClassName(
  state: CampaignPreparationState | undefined,
) {
  const classNames = [
    'campaign-preparation-status',
  ]

  if (state?.campaignStatus === 'FINISHED') {
    classNames.push(
      'campaign-preparation-status-finished',
    )
  } else if (
    state?.campaignStatus === 'DECLINED' ||
    state?.applicationStatus === 'DECLINED'
  ) {
    classNames.push(
      'campaign-preparation-status-declined',
    )
  } else if (
    state?.campaignStatus === 'ACTIVE'
  ) {
    classNames.push(
      'campaign-preparation-status-active',
    )
  }

  if (
    state?.applicationStatus ===
    'SUBMISSION_UNKNOWN'
  ) {
    classNames.push(
      'campaign-preparation-status-warning',
    )
  }

  return classNames.join(' ')
}

function getPreparationError(
  state: CampaignPreparationState | undefined,
) {
  if (!state) {
    return null
  }

  const rawError =
    state.finishError ??
    state.applicationError

  if (!rawError) {
    return null
  }

  try {
    const parsed =
      JSON.parse(rawError) as Array<{
        code?: unknown
        messages?: Array<{
          text?: unknown
        }>
      }>

    const error =
      Array.isArray(parsed)
        ? parsed[0]
        : null

    const code =
      typeof error?.code === 'string'
        ? error.code
        : null

    if (code === 'BA104') {
      return (
        'BA104 – A termék nem jogosult a kampányra, ' +
        'vagy a megadott kampányár nem felel meg ' +
        'az Allegro feltételeinek.'
      )
    }

    if (code === 'BB0') {
      return (
        'BB0 – Átmeneti Allegro-hiba. ' +
        'A rendszer automatikusan újrapróbálja.'
      )
    }

    const message =
      Array.isArray(error?.messages)
        ? error.messages.find(
            (item) =>
              typeof item.text === 'string',
          )?.text
        : null

    if (
      code &&
      typeof message === 'string'
    ) {
      return `${code} – ${message}`
    }

    if (typeof message === 'string') {
      return message
    }

    if (code) {
      return code
    }
  } catch {
    // Nem JSON formátumú Allegro-hiba.
  }

  return rawError
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
function isCampaignCurrentlyNominatable(
  campaign: AllegroCampaign,
  now = new Date(),
) {
  if (
    campaign.source === 'BADGE' &&
    !campaign.eligibility.eligible
  ) {
    return false
  }

  const applicationType =
    campaign.application.type.toUpperCase()

  if (applicationType === 'NEVER') {
    return false
  }

  const applicationFrom =
    campaign.application.from
      ? new Date(campaign.application.from)
      : null

  const applicationTo =
    campaign.application.to
      ? new Date(campaign.application.to)
      : null

  if (
    applicationFrom &&
    now < applicationFrom
  ) {
    return false
  }

  if (
    applicationTo &&
    now > applicationTo
  ) {
    return false
  }

  const publicationTo =
    campaign.publication.to
      ? new Date(campaign.publication.to)
      : null

  if (
    publicationTo &&
    now > publicationTo
  ) {
    return false
  }

  return true
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
    alleDiscountOffersById,
    setAlleDiscountOffersById,
  ] = useState<
    Record<string, AlleDiscountEligibleOffer>
  >({})

  const [
    showAlleDiscountEligibleOnly,
    setShowAlleDiscountEligibleOnly,
  ] = useState(true)

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
    showBadgeEligibleOnly,
    setShowBadgeEligibleOnly,
  ] = useState(true)

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

      const alleDiscountOffer =
        alleDiscountOffersById[
          listing.offerId
        ]

      const matchesAlleDiscountEligibility =
        selectedCampaign?.source !==
          'ALLE_DISCOUNT' ||
        (
          alleDiscountOffer !== undefined &&
          (
            !showAlleDiscountEligibleOnly ||
            alleDiscountOffer.alleDiscount
              ?.campaignConditions
              ?.meetsConditions === true
          )
        )

      const matchesBadgeEligibility =
        selectedCampaign?.source !==
          'BADGE' ||
        !showBadgeEligibleOnly ||
        (
          listing.publicationStatus ===
            'ACTIVE' &&
          listing.marketplace ===
            selectedCampaign.marketplace.id &&
          listing.priceMinor !== null
        )

      return (
        matchesSearch &&
        matchesStatus &&
        matchesSelection &&
        matchesAlleDiscountEligibility &&
        matchesBadgeEligibility
      )
    })

  const selectableFilteredListingIds =
    filteredListings
      .filter(
        (listing) =>
          selectedCampaign?.source !==
            'ALLE_DISCOUNT' &&
          listing.publicationStatus ===
            'ACTIVE' &&
          (
            selectedCampaign?.source !==
              'BADGE' ||
            (
              listing.marketplace ===
                selectedCampaign.marketplace.id &&
              listing.priceMinor !== null
            )
          ),
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
    submittingPreparations,
    setSubmittingPreparations,
  ] = useState(false)

  const [
    syncingCampaignStatuses,
    setSyncingCampaignStatuses,
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
          `${API_BASE_URL}/auth/allegro/campaigns`,
        ),
        fetch(
          `${API_BASE_URL}/auth/allegro/alle-discount/campaigns`,
        ),
        fetch(
          `${API_BASE_URL}/allegro/listings`,
        ),
        fetch(
          `${API_BASE_URL}/allegro/listing-price-history-summary`,
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

      setCampaigns(
        [
          ...badgeCampaigns,
          ...alleDiscountCampaigns,
        ].filter((campaign) =>
          isCampaignCurrentlyNominatable(
            campaign,
          ),
        ),
      )

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

  async function loadCampaignPriceHistory(
    campaignId: string,
  ) {
    const response = await fetch(
      `${API_BASE_URL}/allegro/listing-price-history-summary?campaignId=${encodeURIComponent(
        campaignId,
      )}`,
    )

    const result = await response.json()

    if (!response.ok) {
      throw new Error(
        result.message ??
          'Nem sikerült betölteni a kampány 30 napos referenciaárait.',
      )
    }

    const historyRows =
      (
        result.data ?? []
      ) as PriceHistorySummary[]

    setPriceHistoryByListing(
      Object.fromEntries(
        historyRows.map((row) => [
          row.listingId,
          row,
        ]),
      ),
    )
  }
  async function loadPreparations(
    campaignId: string,
  ) {
    const response = await fetch(
      `${API_BASE_URL}/allegro/remote-campaigns/${campaignId}/preparations`,
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

    const prices: Record<string, string> = {}
    const statuses: Record<
      string,
      CampaignPreparationState
    > = {}

    preparedListings.forEach(
      (item: {
        listingId: string
        desiredPriceMinor: number | null
        applicationStatus: string | null
        campaignStatus: string | null
        applicationError: string | null
        finishError: string | null
      }) => {
        if (item.desiredPriceMinor !== null) {
          prices[item.listingId] = String(
            item.desiredPriceMinor / 100,
          )
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

    setSelectedListingIds([])
    setCampaignPriceDrafts(prices)
    setPreparationStatuses(statuses)
  }

  useEffect(() => {
    if (!selectedCampaignId) {
      return
    }

    void loadCampaignPriceHistory(
      selectedCampaignId,
    ).catch((historyError) => {
      console.error(
        'Campaign price history loading failed:',
        historyError,
      )
    })
  }, [selectedCampaignId])
  async function toggleCampaign(
    campaignId: string,
  ) {
    if (selectedCampaignId === campaignId) {
      setSelectedCampaignId(null)
      setSelectedListingIds([])
      setCampaignPriceDrafts({})
      setBulkDiscountPercent('')
      setPreparationMessage(null)
      setPreparationStatuses({})
      setAlleDiscountOffersById({})
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
    setPreparationMessage(null)
    setPreparationStatuses({})
    setAlleDiscountOffersById({})

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
          `${API_BASE_URL}/auth/allegro/alle-discount/${encodeURIComponent(
            campaign.id,
          )}/eligible-offers?meetsConditions=false`,
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

        const offersById =
          Object.fromEntries(
            eligibleOffers.map(
              (offer) => [
                offer.id,
                offer,
              ],
            ),
          )

        setAlleDiscountOffersById(
          offersById,
        )

        const localInScopeOffers =
          listings
            .map(
              (listing) =>
                offersById[
                  listing.offerId
                ],
            )
            .filter(
              (
                offer,
              ): offer is AlleDiscountEligibleOffer =>
                offer !== undefined,
            )

        const localEligibleCount =
          localInScopeOffers.filter(
            (offer) =>
              offer.alleDiscount
                ?.campaignConditions
                ?.meetsConditions === true,
          ).length

        setShowAlleDiscountEligibleOnly(
          true,
        )

        setPreparationMessage(
          localInScopeOffers.length === 0
            ? 'Ehhez a kampányhoz jelenleg nincs megfelelő ajánlat.'
            : `${localEligibleCount} beküldhető ajánlat / ${localInScopeOffers.length} kampányhoz tartozó ajánlat.`,
        )
      } catch (loadError) {
        console.error(
          'AlleDiscount eligibility loading failed:',
          loadError,
        )

        setAlleDiscountOffersById({})

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
  function isPreparationEditable(
    listingId: string,
  ) {
    const preparation =
      preparationStatuses[listingId]

    return (
      !preparation ||
      (
        preparation.applicationStatus ===
          'PREPARED' &&
        preparation.campaignStatus ===
          'PREPARED'
      )
    )
  }

  function isPreparationSelectable(
    listingId: string,
  ) {
    const preparation =
      preparationStatuses[listingId]

    return (
      isPreparationEditable(listingId) ||
      preparation?.applicationStatus ===
        'SCHEDULED'
    )
  }

  function selectAllFilteredListings() {
    setSelectedListingIds(
      (current) =>
        Array.from(
          new Set([
            ...current,
            ...selectableFilteredListingIds.filter(
              isPreparationSelectable,
            ),
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

    const publicationFrom =
      campaign.publication.from

    const publicationTo =
      campaign.publication.to

    if (!publicationFrom || !publicationTo) {
      setPreparationMessage(
        'Az Allegro kampány hivatalos kezdési vagy zárási időpontja hiányzik.',
      )
      return false
    }

    const publicationFromDate =
      new Date(publicationFrom)

    const publicationToDate =
      new Date(publicationTo)

    if (
      Number.isNaN(
        publicationFromDate.getTime(),
      ) ||
      Number.isNaN(
        publicationToDate.getTime(),
      ) ||
      publicationToDate < publicationFromDate
    ) {
      setPreparationMessage(
        'Az Allegro kampány hivatalos időszaka érvénytelen.',
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

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        setPreparationMessage(
          `Hiányzó vagy hibás kampányár: ${listing.sku}`,
        )
        return false
      }
    }

    setSavingPreparations(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/remote-campaigns/${campaign.id}/preparations`,
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

                  validFrom: publicationFrom,
                  validTo: publicationTo,
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
  async function submitSelectedCampaignOffers(
    campaign: AllegroCampaign,
    submitNow = false,
  ) {
    setPreparationMessage(null)

    if (selectedListingIds.length === 0) {
      setPreparationMessage(
        'Jelölj ki legalább egy ajánlatot.',
      )
      return
    }

    const invalidStateListingIds =
      selectedListingIds.filter(
        (listingId) => {
          const preparation =
            preparationStatuses[listingId]

          return submitNow
            ? preparation?.applicationStatus !==
                'PREPARED' ||
                preparation.campaignStatus !==
                  'PREPARED'
            : preparation?.applicationStatus !==
                'SCHEDULED'
        },
      )

    if (invalidStateListingIds.length > 0) {
      setPreparationMessage(
        submitNow
          ? 'A Beküldés most művelet előtt mentsd az előkészítést minden kijelölt ajánlatnál.'
          : 'Beküldés előtt véglegesítsd az ütemezést minden kijelölt ajánlatnál.',
      )
      return
    }

    setSubmittingPreparations(true)

    try {
      if (submitNow) {
        const scheduleResponse = await fetch(
          `${API_BASE_URL}/allegro/remote-campaigns/${campaign.id}/schedule`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              listingIds:
                selectedListingIds,
              submitNow: true,
            }),
          },
        )

        const scheduleResult =
          await scheduleResponse.json()

        if (!scheduleResponse.ok) {
          throw new Error(
            scheduleResult.message ??
              'Nem sikerült előkészíteni az azonnali beküldést.',
          )
        }
      }

      const response = await fetch(
        `${API_BASE_URL}/allegro/remote-campaigns/${campaign.id}/submit`,
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
            'Nem sikerült beküldeni az ajánlatokat az Allegro kampányba.',
        )
      }

      const resultItems =
        submitNow
          ? result.results ?? result.data
          : result.results

      const results = Array.isArray(
        resultItems,
      )
        ? resultItems
        : []

      const failedResults =
        results.filter(
          (item: {
            status?: string
          }) =>
            item.status === 'FAILED',
        )

      const scheduledResults =
        results.filter(
          (item: {
            status?: string
          }) =>
            item.status === 'SCHEDULED',
        )

      const submittedResults =
        results.filter(
          (item: {
            status?: string
          }) =>
            item.status !== 'FAILED' &&
            item.status !== 'SKIPPED' &&
            item.status !== 'SCHEDULED',
        )

      if (failedResults.length > 0) {
        const firstError =
          failedResults[0]?.error

        setPreparationMessage(
          `${submittedResults.length} ajánlat beküldve, ${failedResults.length} sikertelen.${
            firstError
              ? ` Első hiba: ${firstError}`
              : ''
          }`,
        )
      } else if (
        scheduledResults.length > 0
      ) {
        setPreparationMessage(
          `${scheduledResults.length} ajánlat még ütemezve van, a kezdési időpontjuk nem érkezett el.`,
        )
      } else {
        setPreparationMessage(
          `${submittedResults.length} ajánlat beküldése elindult az Allegrón.`,
        )
      }

      await loadPreparations(
        campaign.id,
      )
    } catch (submitError) {
      console.error(
        'Campaign submission failed:',
        submitError,
      )

      setPreparationMessage(
        submitError instanceof Error
          ? submitError.message
          : 'Nem sikerült beküldeni az ajánlatokat az Allegro kampányba.',
      )
    } finally {
      setSubmittingPreparations(false)
    }
  }

  async function syncCampaignApplicationStatuses(
    campaign: AllegroCampaign,
  ) {
    setPreparationMessage(null)
    setSyncingCampaignStatuses(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/allegro/campaign-applications/sync`,
        {
          method: 'POST',
        },
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Nem sikerült frissíteni a kampánystátuszokat.',
        )
      }

      await loadPreparations(campaign.id)

      setPreparationMessage(
        'A kampánystátuszok frissítése befejeződött.',
      )
    } catch (syncError) {
      console.error(
        'Campaign application status sync failed:',
        syncError,
      )

      setPreparationMessage(
        syncError instanceof Error
          ? syncError.message
          : 'Nem sikerült frissíteni a kampánystátuszokat.',
      )
    } finally {
      setSyncingCampaignStatuses(false)
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

      if (!isPreparationSelectable(listingId)) {
        return current
      }

      return [...current, listingId]
    })
  }

  useEffect(() => {
    setSelectedListingIds((current) => {
      const next = current.filter(
        isPreparationSelectable,
      )

      return next.length === current.length
        ? current
        : next
    })
  }, [preparationStatuses])

  useEffect(() => {
    void loadData()
  }, [])

  const allSelectedPreparationsEditable =
    selectedListingIds.length > 0 &&
    selectedListingIds.every(
      isPreparationEditable,
    )

  const allSelectedListingsPrepared =
    selectedListingIds.length > 0 &&
    selectedListingIds.every(
      (listingId) => {
        const preparation =
          preparationStatuses[listingId]

        return (
          preparation?.applicationStatus ===
            'PREPARED' &&
          preparation.campaignStatus ===
            'PREPARED'
        )
      },
    )

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

          const canSubmit =
            campaign.source === 'BADGE' &&
            isCampaignCurrentlyNominatable(
              campaign,
            )

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

                    {campaign.source ===
                      'BADGE' && (
                      <label
                        className="campaign-selected-filter"
                        title="Aktív, megfelelő marketplace-en lévő, ismert aktuális árral rendelkező ajánlatok"
                      >
                        <input
                          type="checkbox"
                          checked={
                            showBadgeEligibleOnly
                          }
                          onChange={(event) => {
                            setShowBadgeEligibleOnly(
                              event.target.checked,
                            )
                            setListingPage(1)
                          }}
                        />

                        <span>
                          Csak előszűrt
                        </span>
                      </label>
                    )}

                    {campaign.source ===
                      'ALLE_DISCOUNT' && (
                      <label className="campaign-selected-filter">
                        <input
                          type="checkbox"
                          checked={
                            showAlleDiscountEligibleOnly
                          }
                          onChange={(event) => {
                            setShowAlleDiscountEligibleOnly(
                              event.target.checked,
                            )
                            setListingPage(1)
                          }}
                        />

                        <span>
                          Csak beküldhetők
                        </span>
                      </label>
                    )}

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

                  <div className="campaign-offers-table-wrapper">
                    <table className="campaign-offers-table">
                      <thead>
                        <tr>
                          <th />
                          <th>SKU</th>
                          <th>Termék</th>
                          <th>Allegro ID</th>
                          <th>Aktuális ár</th>

                          {campaign.source ===
                            'BADGE' && (
                            <th>Előszűrés</th>
                          )}

                          {campaign.source ===
                            'ALLE_DISCOUNT' && (
                            <th>Kampányfeltétel</th>
                          )}

                          <th>30 napos min.</th>
                          <th>Kampányár</th>
                          <th className="campaign-discount-heading">
                            Kedvezmény
                            <span>
                              30 napos minimumhoz képest
                            </span>
                          </th>
                          <th>Kampány státusz</th>
                          <th>Publikáció</th>
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
                              priceHistory
                                ?.campaignReferenceMin30PriceMinor ??
                                priceHistory?.min30PriceMinor,
                              priceHistory?.hasFull30DayWindow,
                              campaignPriceDrafts[
                                listing.id
                              ],
                            )

                          const alleDiscountOffer =
                            alleDiscountOffersById[
                              listing.offerId
                            ]

                          const alleDiscountConditions =
                            alleDiscountOffer
                              ?.alleDiscount
                              ?.campaignConditions

                          const alleDiscountEligible =
                            alleDiscountConditions
                              ?.meetsConditions ===
                            true

                          const alleDiscountViolations =
                            alleDiscountConditions
                              ?.violations ?? []

                          const requiredMerchantPrice =
                            alleDiscountOffer
                              ?.alleDiscount
                              ?.requiredMerchantPrice

                          const requiredMerchantPriceAmount =
                            requiredMerchantPrice
                              ? Number(
                                  requiredMerchantPrice.amount,
                                )
                              : null

                          const requiredMerchantPriceMinor =
                            requiredMerchantPriceAmount !==
                              null &&
                            Number.isFinite(
                              requiredMerchantPriceAmount,
                            )
                              ? Math.round(
                                  requiredMerchantPriceAmount *
                                    100,
                                )
                              : null

                          const badgePrecheckReasons =
                            campaign.source === 'BADGE'
                              ? [
                                  ...(listing.publicationStatus !==
                                  'ACTIVE'
                                    ? ['Nem aktív ajánlat']
                                    : []),

                                  ...(listing.marketplace !==
                                  campaign.marketplace.id
                                    ? [
                                        `Más marketplace: ${listing.marketplace}`,
                                      ]
                                    : []),

                                  ...(listing.priceMinor ===
                                  null
                                    ? [
                                        'Nincs ismert aktuális ár',
                                      ]
                                    : []),
                                ]
                              : []

                          const badgePrecheckEligible =
                            badgePrecheckReasons.length ===
                            0

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
                                      'ACTIVE' ||
                                    (
                                      campaign.source ===
                                        'BADGE' &&
                                      (
                                        listing.marketplace !==
                                          campaign.marketplace.id ||
                                        listing.priceMinor ===
                                          null
                                      )
                                    ) ||
                                    !isPreparationSelectable(
                                      listing.id,
                                    )
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

                              {campaign.source ===
                                'BADGE' && (
                                <td>
                                  <div className="campaign-condition-cell">
                                    <span
                                      className={
                                        badgePrecheckEligible
                                          ? 'campaign-eligibility campaign-eligible'
                                          : 'campaign-eligibility campaign-ineligible'
                                      }
                                    >
                                      {badgePrecheckEligible
                                        ? '✓ Előszűrt'
                                        : '✕ Nem megfelelő'}
                                    </span>

                                    {!badgePrecheckEligible && (
                                      <div className="campaign-condition-violations">
                                        {badgePrecheckReasons.map(
                                          (reason) => (
                                            <span
                                              key={`${listing.id}-${reason}`}
                                            >
                                              {reason}
                                            </span>
                                          ),
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              )}

                              {campaign.source ===
                                'ALLE_DISCOUNT' && (
                                <td>
                                  <div className="campaign-condition-cell">
                                    <span
                                      className={
                                        alleDiscountEligible
                                          ? 'campaign-eligibility campaign-eligible'
                                          : 'campaign-eligibility campaign-ineligible'
                                      }
                                    >
                                      {alleDiscountEligible
                                        ? '✓ Beküldhető'
                                        : '✕ Nem megfelelő'}
                                    </span>

                                    {!alleDiscountEligible &&
                                      alleDiscountViolations.length >
                                        0 && (
                                        <div className="campaign-condition-violations">
                                          {alleDiscountViolations.map(
                                            (
                                              violation,
                                              index,
                                            ) => (
                                              <span
                                                key={`${listing.id}-${violation.code ?? index}`}
                                              >
                                                {violation.message ??
                                                  violation.code ??
                                                  'Nem teljesített kampányfeltétel'}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      )}

                                    {requiredMerchantPriceMinor !==
                                      null && (
                                      <span className="campaign-condition-price">
                                        Elvárt max. ár:{' '}
                                        {formatPrice(
                                          requiredMerchantPriceMinor,
                                          requiredMerchantPrice
                                            ?.currency ??
                                            listing.currency,
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              )}

                              <td>
                                <div className="campaign-history-price">
                                  <strong>
                                    {formatPrice(
                                      priceHistory
                                        ?.campaignReferenceMin30PriceMinor ??
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
                                <span className="campaign-discount-value">
                                  {formatCampaignDiscount(
                                    priceHistoryByListing[
                                      listing.id
                                    ]
                                      ?.campaignReferenceMin30PriceMinor ??
                                      priceHistoryByListing[
                                        listing.id
                                      ]?.min30PriceMinor,
                                    campaignPriceDrafts[
                                      listing.id
                                    ],
                                  )}
                                </span>
                              </td>

                              <td>
                                <div className="campaign-preparation-state">
                                  <span
                                    className={getPreparationStatusClassName(
                                      preparationStatuses[
                                        listing.id
                                      ],
                                    )}
                                  >
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
                      {campaign.source === 'BADGE' && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            syncingCampaignStatuses ||
                            savingPreparations ||
                            submittingPreparations
                          }
                          onClick={() =>
                            void syncCampaignApplicationStatuses(
                              campaign,
                            )
                          }
                        >
                          {syncingCampaignStatuses
                            ? 'Frissítés…'
                            : 'Státusz frissítése'}
                        </button>
                      )}

                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          savingPreparations ||
                          selectedListingIds.length === 0 ||
                          !allSelectedPreparationsEditable
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
                        title="Az Allegro a kampány hivatalos kezdetekor aktiválja."
                        disabled={
                          !canSubmit ||
                          submittingPreparations ||
                          !allSelectedListingsPrepared
                        }
                        onClick={() =>
                          void submitSelectedCampaignOffers(
                            campaign,
                            true,
                          )
                        }
                      >
                        {submittingPreparations
                          ? 'Beküldés…'
                          : 'Beküldés most'}
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
