import { useEffect, useState } from 'react'
import { API_BASE_URL } from '../config/api'

type FeedSettings = {
  useMinIndex: boolean
  maxMinIndexBps: number
  useMedianIndex: boolean
  maxMedianIndexBps: number
  useAverageIndex: boolean
  maxAverageIndexBps: number
  useStockRule: boolean
  allowNoCompetitor: boolean
  allowMissingPricingData: boolean
  maxPricingAgeHours: number
  ruleVersion: number
}

type SettingsDraft = {
  useMinIndex: boolean
  maxMinIndexPercent: string
  useMedianIndex: boolean
  maxMedianIndexPercent: string
  useAverageIndex: boolean
  maxAverageIndexPercent: string
  useStockRule: boolean
  allowNoCompetitor: boolean
  allowMissingPricingData: boolean
  maxPricingAgeHours: string
}

const INITIAL_DRAFT: SettingsDraft = {
  useMinIndex: true,
  maxMinIndexPercent: '110',
  useMedianIndex: false,
  maxMedianIndexPercent: '110',
  useAverageIndex: false,
  maxAverageIndexPercent: '110',
  useStockRule: false,
  allowNoCompetitor: false,
  allowMissingPricingData: false,
  maxPricingAgeHours: '48',
}

function toDraft(settings: FeedSettings): SettingsDraft {
  return {
    useMinIndex: settings.useMinIndex,
    maxMinIndexPercent: String(
      settings.maxMinIndexBps / 100,
    ),
    useMedianIndex: settings.useMedianIndex,
    maxMedianIndexPercent: String(
      settings.maxMedianIndexBps / 100,
    ),
    useAverageIndex: settings.useAverageIndex,
    maxAverageIndexPercent: String(
      settings.maxAverageIndexBps / 100,
    ),
    useStockRule: settings.useStockRule,
    allowNoCompetitor:
      settings.allowNoCompetitor,
    allowMissingPricingData:
      settings.allowMissingPricingData,
    maxPricingAgeHours: String(
      settings.maxPricingAgeHours,
    ),
  }
}

function ArukeresoPricingPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] =
    useState<SettingsDraft>(INITIAL_DRAFT)
  const [ruleVersion, setRuleVersion] =
    useState<number | null>(null)
  const [appliedDefaults, setAppliedDefaults] =
    useState<string[]>([])
  const [message, setMessage] = useState<
    string | null
  >(null)
  const [validationError, setValidationError] =
    useState<string | null>(null)

  function updateDraft<K extends keyof SettingsDraft>(
    key: K,
    value: SettingsDraft[K],
  ) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  async function loadSettings() {
    setLoading(true)
    setMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/settings`,
      )
      const result = (await response.json()) as {
        settings?: FeedSettings
        appliedDefaults?: string[]
        message?: string
      }

      if (!response.ok || !result.settings) {
        throw new Error(
          result.message ??
            'A beállítások betöltése sikertelen.',
        )
      }

      setDraft(toDraft(result.settings))
      setRuleVersion(result.settings.ruleVersion)
      setAppliedDefaults(result.appliedDefaults ?? [])
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'A beállítások betöltése sikertelen.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSettings()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [])

  async function saveSettings() {
    setValidationError(null)
    setMessage(null)

    const thresholds = [
      ['minimum', draft.maxMinIndexPercent],
      ['medián', draft.maxMedianIndexPercent],
      ['átlag', draft.maxAverageIndexPercent],
    ] as const

    for (const [label, rawValue] of thresholds) {
      const value = Number(rawValue)

      if (
        !rawValue.trim() ||
        !Number.isInteger(value) ||
        value <= 0
      ) {
        setValidationError(
          `A maximum ${label} index pozitív egész százalék kell legyen.`,
        )
        return
      }
    }

    const hours = Number(draft.maxPricingAgeHours)

    if (
      !draft.maxPricingAgeHours.trim() ||
      !Number.isInteger(hours) ||
      hours <= 0 ||
      hours > 8760
    ) {
      setValidationError(
        'A maximális életkor 1 és 8760 közötti egész óraszám kell legyen.',
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
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            useMinIndex: draft.useMinIndex,
            maxMinIndexBps:
              Number(draft.maxMinIndexPercent) * 100,
            useMedianIndex: draft.useMedianIndex,
            maxMedianIndexBps:
              Number(draft.maxMedianIndexPercent) * 100,
            useAverageIndex: draft.useAverageIndex,
            maxAverageIndexBps:
              Number(draft.maxAverageIndexPercent) * 100,
            useStockRule: draft.useStockRule,
            allowNoCompetitor:
              draft.allowNoCompetitor,
            allowMissingPricingData:
              draft.allowMissingPricingData,
            maxPricingAgeHours: hours,
          }),
        },
      )
      const result = (await response.json()) as {
        settings?: FeedSettings
        appliedDefaults?: string[]
        updated?: boolean
        message?: string
      }

      if (!response.ok || !result.settings) {
        throw new Error(
          result.message ??
            'A beállítások mentése sikertelen.',
        )
      }

      setDraft(toDraft(result.settings))
      setRuleVersion(result.settings.ruleVersion)
      setAppliedDefaults(result.appliedDefaults ?? [])
      setMessage(
        result.updated === false
          ? 'Nincs változás, a beállítások megegyeznek.'
          : `Beállítások elmentve (szabályverzió: ${result.settings.ruleVersion}).`,
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'A beállítások mentése sikertelen.',
      )
    } finally {
      setSaving(false)
    }
  }

  const pricingRules = [
    {
      enabledKey: 'useMinIndex' as const,
      thresholdKey: 'maxMinIndexPercent' as const,
      label: 'Minimum index figyelembevétele',
      thresholdLabel: 'Legmagasabb megengedett minimum index',
    },
    {
      enabledKey: 'useMedianIndex' as const,
      thresholdKey: 'maxMedianIndexPercent' as const,
      label: 'Medián index figyelembevétele',
      thresholdLabel: 'Legmagasabb megengedett medián index',
    },
    {
      enabledKey: 'useAverageIndex' as const,
      thresholdKey: 'maxAverageIndexPercent' as const,
      label: 'Átlagindex figyelembevétele',
      thresholdLabel: 'Legmagasabb megengedett átlagindex',
    },
  ]

  return (
    <section className="campaigns-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">ÁRUKERESŐ FEED</p>
          <h2>Árukereső feed – Pricing szabályok</h2>
          <p className="campaigns-page-description">
            Az összes bekapcsolt indexszabálynak teljesülnie
            kell. A készletszabály külön kapcsolható.
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
              <p className="section-label">GLOBÁLIS SZABÁLYOK</p>
              <h4>
                Pricing szabályok
                {ruleVersion !== null && ` (v${ruleVersion})`}
              </h4>
            </div>
          </div>

          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table">
              <tbody>
                {pricingRules.map((rule) => {
                  const enabled = draft[rule.enabledKey]

                  return (
                    <tr key={rule.enabledKey}>
                      <td>
                        <label>
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={saving}
                            onChange={(event) =>
                              updateDraft(
                                rule.enabledKey,
                                event.target.checked,
                              )
                            }
                          />{' '}
                          {rule.label}
                        </label>
                      </td>
                      <td style={{ opacity: enabled ? 1 : 0.5 }}>
                        {rule.thresholdLabel}:{' '}
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={draft[rule.thresholdKey]}
                          disabled={saving || !enabled}
                          onChange={(event) =>
                            updateDraft(
                              rule.thresholdKey,
                              event.target.value,
                            )
                          }
                        />{' '}
                        %
                      </td>
                    </tr>
                  )
                })}

                <tr>
                  <td>Készlet figyelembevétele</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={draft.useStockRule}
                      disabled={saving}
                      onChange={(event) =>
                        updateDraft(
                          'useStockRule',
                          event.target.checked,
                        )
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>Versenytárs nélküli termékek engedélyezése</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={draft.allowNoCompetitor}
                      disabled={saving}
                      onChange={(event) =>
                        updateDraft(
                          'allowNoCompetitor',
                          event.target.checked,
                        )
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>Pricing adat nélküli termékek engedélyezése</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={draft.allowMissingPricingData}
                      disabled={saving}
                      onChange={(event) =>
                        updateDraft(
                          'allowMissingPricingData',
                          event.target.checked,
                        )
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>Pricing adat maximális életkora</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      step={1}
                      value={draft.maxPricingAgeHours}
                      disabled={saving}
                      onChange={(event) =>
                        updateDraft(
                          'maxPricingAgeHours',
                          event.target.value,
                        )
                      }
                    />{' '}
                    óra
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {appliedDefaults.length > 0 && (
            <div className="campaign-preparation-message">
              Alapértelmezett vagy kompatibilitási értékek:{' '}
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
              A termékszintű felülírások változatlanok maradnak.
            </span>
            <div className="campaign-submit-actions">
              <button
                type="button"
                className="campaign-primary-button"
                disabled={saving}
                onClick={() => void saveSettings()}
              >
                {saving ? 'Mentés…' : 'Beállítások mentése'}
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
