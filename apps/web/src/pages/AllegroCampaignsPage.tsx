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

  function toggleCampaign(
    campaignId: string,
  ) {
    setSelectedCampaignId((current) =>
      current === campaignId
        ? null
        : campaignId,
    )

    setSelectedListingIds([])
    setCampaignPriceDrafts({})
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
                      toggleCampaign(campaign.id)
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
                          <th>Állapot</th>
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
                                {listing.publicationStatus}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="campaign-submit-bar">
                    <span>
                      {selectedListingIds.length}
                      {' '}
                      ajánlat kijelölve
                    </span>

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
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default AllegroCampaignsPage