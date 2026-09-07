import {
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

type FeedSettings = {
  maxPriceIndexBps: number
  allowNoCompetitor: boolean
  allowMissingPricingData: boolean
  maxPricingAgeHours: number
  ruleVersion: number
}

function ArukeresoPricingPage() {
  const [loading, setLoading] =
    useState(true)

  const [saving, setSaving] = useState(false)

  const [maxIndexPercent, setMaxIndexPercent] =
    useState('110')

  const [allowNoCompetitor, setAllowNoCompetitor] =
    useState(false)

  const [
    allowMissingPricingData,
    setAllowMissingPricingData,
  ] = useState(false)

  const [maxPricingAgeHours, setMaxPricingAgeHours] =
    useState('48')

  const [ruleVersion, setRuleVersion] =
    useState<number | null>(null)

  const [appliedDefaults, setAppliedDefaults] =
    useState<string[]>([])

  const [message, setMessage] = useState<
    string | null
  >(null)

  const [validationError, setValidationError] =
    useState<string | null>(null)

  async function loadSettings() {
    setLoading(true)
    setMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/settings`,
      )

      const result = (await response.json()) as {
        status: string
        settings?: FeedSettings
        appliedDefaults?: string[]
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'A beállítások betöltése sikertelen.',
        )
      }

      const settings = result.settings

      if (!settings) {
        throw new Error(
          'A beállítások betöltése sikertelen.',
        )
      }

      setMaxIndexPercent(
        String(
          Math.round(
            settings.maxPriceIndexBps / 100,
          ),
        ),
      )
      setAllowNoCompetitor(
        settings.allowNoCompetitor,
      )
      setAllowMissingPricingData(
        settings.allowMissingPricingData,
      )
      setMaxPricingAgeHours(
        String(settings.maxPricingAgeHours),
      )
      setRuleVersion(settings.ruleVersion)
      setAppliedDefaults(
        result.appliedDefaults ?? [],
      )
    } catch (loadError) {
      setMessage(
        loadError instanceof Error
          ? loadError.message
          : 'A beállítások betöltése sikertelen.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  async function saveSettings() {
    setValidationError(null)
    setMessage(null)

    const percent = Number(maxIndexPercent)
    const hours = Number(maxPricingAgeHours)

    if (
      !maxIndexPercent.trim() ||
      !Number.isInteger(percent) ||
      percent <= 0
    ) {
      setValidationError(
        'A maximum árindex pozitív egész százalék kell legyen.',
      )
      return
    }

    if (
      !maxPricingAgeHours.trim() ||
      !Number.isFinite(hours) ||
      hours <= 0 ||
      hours > 8760
    ) {
      setValidationError(
        'A maximális életkor 0 és 8760 közötti óraszám kell legyen.',
      )
      return
    }

    setSaving(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/settings`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            maxPriceIndexBps: percent * 100,
            allowNoCompetitor,
            allowMissingPricingData,
            maxPricingAgeHours: hours,
          }),
        },
      )

      const result = (await response.json()) as {
        status: string
        settings?: FeedSettings
        appliedDefaults?: string[]
        updated?: boolean
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'A beállítások mentése sikertelen.',
        )
      }

      const settings = result.settings

      if (settings) {
        setMaxIndexPercent(
          String(
            Math.round(
              settings.maxPriceIndexBps /
                100,
            ),
          ),
        )
        setAllowNoCompetitor(
          settings.allowNoCompetitor,
        )
        setAllowMissingPricingData(
          settings.allowMissingPricingData,
        )
        setMaxPricingAgeHours(
          String(
            settings.maxPricingAgeHours,
          ),
        )
        setRuleVersion(
          settings.ruleVersion,
        )
        setAppliedDefaults(
          result.appliedDefaults ?? [],
        )
      }

      setMessage(
        result.updated === false
          ? 'Nincs változás, a beállítások megegyeznek.'
          : `Beállítások elmentve (szabályverzió: ${settings?.ruleVersion ?? '–'}).`,
      )
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : 'A beállítások mentése sikertelen.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="campaigns-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">
            ÁRUKERESŐ FEED
          </p>

          <h2>
            Árukereső feed – Pricing
            szabályok
          </h2>

          <p className="campaigns-page-description">
            Globális feed-jogosultsági
            szabályok. A százalékos
            értékek az API Bps
            egységeire váltódnak
            mentéskor.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="campaign-message">
          Beállítások betöltése…
        </div>
      ) : (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-heading">
            <div>
              <p className="section-label">
                GLOBÁLIS SZABÁLYOK
              </p>

              <h4>
                Pricing szabályok
                {ruleVersion !== null &&
                  ` (v${ruleVersion})`}
              </h4>
            </div>
          </div>

          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table">
              <tbody>
                <tr>
                  <td>Maximum árindex</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={
                        maxIndexPercent
                      }
                      onChange={(event) =>
                        setMaxIndexPercent(
                          event.target.value,
                        )
                      }
                      disabled={saving}
                    />{' '}
                    %
                  </td>
                </tr>

                <tr>
                  <td>
                    Competitor nélküli
                    termékek engedélyezése
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={
                        allowNoCompetitor
                      }
                      onChange={(event) =>
                        setAllowNoCompetitor(
                          event.target.checked,
                        )
                      }
                      disabled={saving}
                    />
                  </td>
                </tr>

                <tr>
                  <td>
                    Pricing adat nélküli
                    termékek engedélyezése
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={
                        allowMissingPricingData
                      }
                      onChange={(event) =>
                        setAllowMissingPricingData(
                          event.target.checked,
                        )
                      }
                      disabled={saving}
                    />
                  </td>
                </tr>

                <tr>
                  <td>
                    Pricing adat maximális
                    életkora
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={
                        maxPricingAgeHours
                      }
                      onChange={(event) =>
                        setMaxPricingAgeHours(
                          event.target.value,
                        )
                      }
                      disabled={saving}
                    />{' '}
                    óra
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {appliedDefaults.length > 0 && (
            <div className="campaign-preparation-message">
              Alapértelmezett értékek
              érvényesek:{' '}
              {appliedDefaults.join(', ')}.
            </div>
          )}

          {validationError && (
            <div className="campaign-submit-warning">
              {validationError}
            </div>
          )}

          <div className="campaign-submit-bar">
            <span>
              A termékszintű
              felülírások változatlanok
              maradnak.
            </span>

            <div className="campaign-submit-actions">
              <button
                type="button"
                className="campaign-primary-button"
                disabled={saving}
                onClick={() =>
                  void saveSettings()
                }
              >
                {saving
                  ? 'Mentés…'
                  : 'Beállítások mentése'}
              </button>
            </div>
          </div>

          {message && (
            <div className="campaign-preparation-message">
              {message}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default ArukeresoPricingPage
