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
  allowMissingPricingData: boolean
  allowNoCompetitor: boolean
}

const INITIAL_DRAFT: SettingsDraft = {
  useMinIndex: true,
  maxMinIndexPercent: '110',
  useMedianIndex: false,
  maxMedianIndexPercent: '110',
  useAverageIndex: false,
  maxAverageIndexPercent: '110',
  useStockRule: false,
  allowMissingPricingData: false,
  allowNoCompetitor: false,
}

const PRICING_RULES = [
  {
    enabledKey: 'useMinIndex' as const,
    thresholdKey: 'maxMinIndexPercent' as const,
    label: 'Minimum index figyelembevétele',
    helper:
      'A termék csak akkor kerülhet a feedbe, ha a minimum árindex nem haladja meg a megadott értéket.',
    thresholdLabel: 'Maximum minimum index',
  },
  {
    enabledKey: 'useMedianIndex' as const,
    thresholdKey: 'maxMedianIndexPercent' as const,
    label: 'Medián index figyelembevétele',
    helper:
      'A medián árindexnek is meg kell felelnie a beállított határnak.',
    thresholdLabel: 'Maximum medián index',
  },
  {
    enabledKey: 'useAverageIndex' as const,
    thresholdKey: 'maxAverageIndexPercent' as const,
    label: 'Átlagindex figyelembevétele',
    helper:
      'Az átlagos piaci árpozíció alapján is szűrheted a termékeket.',
    thresholdLabel: 'Maximum átlagindex',
  },
]

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
    allowMissingPricingData:
      settings.allowMissingPricingData,
    allowNoCompetitor:
      settings.allowNoCompetitor,
  }
}

function ArukeresoSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] =
    useState<SettingsDraft>(INITIAL_DRAFT)
  const [savedDraft, setSavedDraft] =
    useState<SettingsDraft>(INITIAL_DRAFT)
  const [ruleVersion, setRuleVersion] =
    useState<number | null>(null)
  const [usesDefaults, setUsesDefaults] =
    useState(false)
  const [pricingError, setPricingError] =
    useState<string | null>(null)
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)

  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(savedDraft)

  function updateDraft<K extends keyof SettingsDraft>(
    key: K,
    value: SettingsDraft[K],
  ) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
    setFeedback(null)
  }

  async function loadSettings() {
    setLoading(true)

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

      const nextDraft = toDraft(result.settings)
      setDraft(nextDraft)
      setSavedDraft(nextDraft)
      setRuleVersion(result.settings.ruleVersion)
      setUsesDefaults(
        (result.appliedDefaults?.length ?? 0) > 0,
      )
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'A beállítások betöltése sikertelen.',
      })
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
    setPricingError(null)
    setFeedback(null)

    for (const rule of PRICING_RULES) {
      const rawValue = draft[rule.thresholdKey]
      const value = Number(rawValue)
      const bps = value * 100

      if (
        !rawValue.trim() ||
        !Number.isFinite(value) ||
        value <= 0 ||
        Math.abs(bps - Math.round(bps)) >
          Number.EPSILON * 10000
      ) {
        setPricingError(
          `${rule.thresholdLabel}: adj meg egy pozitív százalékot, legfeljebb két tizedesjeggyel.`,
        )
        return
      }
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
              Math.round(
                Number(draft.maxMinIndexPercent) * 100,
              ),
            useMedianIndex: draft.useMedianIndex,
            maxMedianIndexBps:
              Math.round(
                Number(draft.maxMedianIndexPercent) * 100,
              ),
            useAverageIndex: draft.useAverageIndex,
            maxAverageIndexBps:
              Math.round(
                Number(draft.maxAverageIndexPercent) * 100,
              ),
            useStockRule: draft.useStockRule,
            allowMissingPricingData:
              draft.allowMissingPricingData,
            allowNoCompetitor:
              draft.allowNoCompetitor,
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

      const nextDraft = toDraft(result.settings)
      setDraft(nextDraft)
      setSavedDraft(nextDraft)
      setRuleVersion(result.settings.ruleVersion)
      setUsesDefaults(
        (result.appliedDefaults?.length ?? 0) > 0,
      )
      setFeedback({
        kind: 'success',
        text:
          result.updated === false
            ? 'A beállítások már naprakészek.'
            : 'A feed-szabályok mentése sikerült.',
      })
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'A beállítások mentése sikertelen.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="allegro-settings-page arukereso-settings-page">
      <div className="allegro-settings-heading">
        <span>ÁRUKERESŐ FEED</span>
        <h2>Árukereső beállítások</h2>
        <p>
          Állítsd be, milyen feltételek alapján kerülhetnek
          termékek az Árukereső feedbe.
        </p>
      </div>

      {loading ? (
        <div className="campaign-message">
          Beállítások betöltése…
        </div>
      ) : (
        <>
          <article className="allegro-settings-card">
            <header className="allegro-settings-card-header">
              <div>
                <span className="allegro-settings-eyebrow">
                  FEED-JOGOSULTSÁG
                </span>
                <h3>Árpozíciós szabályok</h3>
                <p>
                  Ha több árindexszabály aktív, minden
                  bekapcsolt feltételnek teljesülnie kell.
                </p>
              </div>
            </header>

            <div className="arukereso-settings-rules">
              {PRICING_RULES.map((rule) => {
                const enabled = draft[rule.enabledKey]

                return (
                  <div
                    className={`arukereso-settings-rule${
                      enabled ? '' : ' is-muted'
                    }`}
                    key={rule.enabledKey}
                  >
                    <div className="arukereso-settings-rule-copy">
                      <label className="schedule-switch">
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
                        />
                        <span aria-hidden="true" />
                        <strong>{rule.label}</strong>
                      </label>
                      <p>{rule.helper}</p>
                    </div>

                    <label className="arukereso-settings-number">
                      <span>{rule.thresholdLabel}</span>
                      <span>
                        <input
                          type="number"
                          min={1}
                          step={0.01}
                          value={draft[rule.thresholdKey]}
                          disabled={saving || !enabled}
                          onChange={(event) =>
                            updateDraft(
                              rule.thresholdKey,
                              event.target.value,
                            )
                          }
                        />
                        <b>%</b>
                      </span>
                    </label>
                  </div>
                )
              })}
            </div>

            {pricingError && (
              <div className="allegro-settings-error">
                {pricingError}
              </div>
            )}
          </article>

          <article className="allegro-settings-card">
            <header className="allegro-settings-card-header">
              <div>
                <span className="allegro-settings-eyebrow">
                  ELÉRHETŐSÉG ÉS ADATMINŐSÉG
                </span>
                <h3>Készlet és pricing adatok</h3>
                <p>
                  Határozd meg, milyen készlet- és
                  adatállapot mellett kerülhet ki egy termék.
                </p>
              </div>
            </header>

            <div className="arukereso-settings-data-grid">
              <div className="arukereso-settings-toggle-row">
                <label className="schedule-switch">
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
                  <span aria-hidden="true" />
                  <strong>Készlet figyelembevétele</strong>
                </label>
                <p>
                  Bekapcsolva csak a készleten lévő termékek
                  kerülhetnek a feedbe.
                </p>
              </div>

              <div className="arukereso-settings-toggle-row">
                <label className="schedule-switch">
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
                  <span aria-hidden="true" />
                  <strong>
                    PriceKit adat nélküli termékek engedélyezése
                  </strong>
                </label>
                <p>
                  Bekapcsolva azok a termékek is
                  megjelenhetnek, amelyekhez nincs aktuális
                  PriceKit/Cockpit adat.
                </p>
              </div>

              <div className="arukereso-settings-toggle-row">
                <label className="schedule-switch">
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
                  <span aria-hidden="true" />
                  <strong>
                    Competitor nélküli termékek engedélyezése
                  </strong>
                </label>
                <p>
                  Bekapcsolva a PriceKitben szereplő, de
                  versenytársi ár nélküli termékek is
                  megjelenhetnek.
                </p>
              </div>

            </div>

            <div className="allegro-settings-info">
              A PriceKit-lefedettség, competitor-adatok és
              készlet kezelése külön szabályozható.
            </div>
          </article>

          <div className="arukereso-settings-footer">
            <div>
              {usesDefaults && (
                <p>
                  Az alapértelmezett feed-szabályok vannak
                  használatban.
                </p>
              )}
              <small>
                {dirty
                  ? 'Nem mentett módosítások'
                  : 'Minden módosítás mentve'}
                {ruleVersion !== null &&
                  ` · Szabályverzió: v${ruleVersion}`}
              </small>
            </div>
            <button
              type="button"
              className="campaign-primary-button"
              disabled={saving || !dirty}
              onClick={() => void saveSettings()}
            >
              {saving ? 'Mentés…' : 'Beállítások mentése'}
            </button>
          </div>

          {feedback && (
            <div
              className={
                feedback.kind === 'error'
                  ? 'campaign-message campaign-message-error'
                  : 'campaign-preparation-message'
              }
            >
              {feedback.text}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default ArukeresoSettingsPage
