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

function formatPreparationStatus(
  status: string | null | undefined,
) {
  if (status === 'PREPARED') return 'Előkészítve'
  if (status === 'SCHEDULED') return 'Ütemezve'
  if (status === 'SUBMITTING') return 'Beküldés alatt'
  if (status === 'SUBMITTED') return 'Beküldve'
  if (status === 'FAILED') return 'Hiba'
  if (status === 'FINISHED') return 'Lezárva'
  return '–'
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
    selectedCampaignId,
    setSelectedCampaignId,
  ] = useState<string | null>(null)

  const [
    selectedListingIds,
    setSelectedListingIds,
  ] = useState<string[]>([])

  const [
    campaignPriceDrafts,
    setCampaignPriceDrafts,
  ] = useState<Record<string, string>>({})

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
  ] = useState<Record<string, string | null>>({})

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
        listingsResponse,
      ] = await Promise.all([
        fetch(
          'http://localhost:3000/auth/allegro/campaigns',
        ),
        fetch(
          'http://localhost:3000/allegro/listings',
        ),
      ])

      const campaignResult =
        await campaignsResponse.json()

      const listingResult =
        await listingsResponse.json()

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

      setCampaigns(
        campaignResult.data?.badgeCampaigns ?? [],
      )

      setListings(
        listingResult.data ?? [],
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
    const statuses: Record<string, string | null> = {}

    preparedListings.forEach(
      (item: {
        listingId: string
        desiredPriceMinor: number | null
        validFrom: string | null
        validTo: string | null
        applicationStatus: string | null
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

        statuses[item.listingId] =
          item.applicationStatus
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
      return
    }

    setSelectedCampaignId(campaignId)
    setSelectedListingIds([])
    setCampaignPriceDrafts({})
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
                      {campaign.eligibility.eligible
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

              {!campaign.eligibility.eligible &&
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
                          <th>Kampányár</th>
                          <th>Mettől</th>
                          <th>Meddig</th>
                          <th>Kampány státusz</th>
                          <th>Ajánlat státusz</th>
                        </tr>
                      </thead>

                      <tbody>
                        {listings.map((listing) => {
                          const checked =
                            selectedListingIds.includes(
                              listing.id,
                            )

                          return (
                            <tr key={listing.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={
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

                              <td>
                                <div className="campaign-date-time-inputs campaign-row-date-time">
                                  <input
                                    className="campaign-date-input"
                                    type="date"
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
                                <span className="campaign-preparation-status">
                                  {formatPreparationStatus(
                                    preparationStatuses[
                                      listing.id
                                    ],
                                  )}
                                </span>
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
                          selectedListingIds.length === 0
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