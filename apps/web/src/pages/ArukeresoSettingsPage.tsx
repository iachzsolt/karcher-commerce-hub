import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
}

const PRICING_RULES = [
  {
    enabledKey: 'useMinIndex' as const,
    thresholdKey: 'maxMinIndexPercent' as const,
    label: 'Minimum index figyelembevétele',
    helper:
      'Ha a minimum árindex meghaladja a határt, az ajánlat a feedben marad, de DeliveryTime=NO értéket kap.',
    thresholdLabel: 'Maximum minimum index',
  },
  {
    enabledKey: 'useMedianIndex' as const,
    thresholdKey: 'maxMedianIndexPercent' as const,
    label: 'Medián index figyelembevétele',
    helper:
      'Ha a medián árindex nem felel meg, az ajánlat DeliveryTime=NO értéket kap.',
    thresholdLabel: 'Maximum medián index',
  },
  {
    enabledKey: 'useAverageIndex' as const,
    thresholdKey: 'maxAverageIndexPercent' as const,
    label: 'Átlagindex figyelembevétele',
    helper:
      'Ha az átlagos árpozíció nem felel meg, az ajánlat DeliveryTime=NO értéket kap.',
    thresholdLabel: 'Maximum átlagindex',
  },
]

function isFeedSettings(value: unknown): value is FeedSettings {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return false
  }

  const settings = value as Record<string, unknown>

  return (
    typeof settings['useMinIndex'] === 'boolean' &&
    typeof settings['maxMinIndexBps'] === 'number' &&
    typeof settings['useMedianIndex'] === 'boolean' &&
    typeof settings['maxMedianIndexBps'] === 'number' &&
    typeof settings['useAverageIndex'] === 'boolean' &&
    typeof settings['maxAverageIndexBps'] === 'number' &&
    typeof settings['useStockRule'] === 'boolean' &&
    typeof settings['allowNoCompetitor'] === 'boolean' &&
    typeof settings['ruleVersion'] === 'number'
  )
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
  }
}

function ArukeresoSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
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
    setLoaded(false)
    setFeedback(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/settings`,
      )
      const result = (await response.json()) as {
        isActive?: boolean
        settings?: FeedSettings
        appliedDefaults?: string[]
        message?: string
      }

      if (
        !response.ok ||
        !isFeedSettings(result.settings) ||
        typeof result.isActive !== 'boolean'
      ) {
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
      setLoaded(true)
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
            allowNoCompetitor:
              draft.allowNoCompetitor,
          }),
        },
      )
      const result = (await response.json()) as {
        isActive?: boolean
        settings?: FeedSettings
        appliedDefaults?: string[]
        updated?: boolean
        message?: string
      }

      if (
        !response.ok ||
        !isFeedSettings(result.settings) ||
        typeof result.isActive !== 'boolean'
      ) {
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
          A PriceKit-lefedettség adja a feed alapját; a
          szabályok az ajánlatok elérhetőségét vezérlik.
        </p>
        <p className="allegro-settings-hint">
          A közzététel főkapcsolója a{' '}
          <Link to="/settings">
            Commerce Hub Beállítások
          </Link>{' '}
          → Platformok szakaszban található.
        </p>
      </div>

      {loading ? (
        <div className="campaign-message">
          Beállítások betöltése…
        </div>
      ) : !loaded ? (
        <div className="campaign-message campaign-message-error">
          <span>
            {feedback?.text ??
              'A beállítások betöltése sikertelen.'}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadSettings()}
          >
            Újrapróbálás
          </button>
        </div>
      ) : (
        <>
          <article className="allegro-settings-card">
            <header className="allegro-settings-card-header">
              <div>
                <span className="allegro-settings-eyebrow">
                  AJÁNLAT ELÉRHETŐSÉG
                </span>
                <h3>Árpozíciós szabályok</h3>
                <p>
                  Ha több árindexszabály aktív, minden
                  bekapcsolt feltételnek teljesülnie kell az
                  eredeti DeliveryTime megtartásához.
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
                  adatállapot mellett maradhat aktív egy ajánlat.
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
                  Készlethiány esetén a feed-sor megmarad, de
                  DeliveryTime=NO értéket kap.
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
                  versenytársi ár nélküli ajánlatok is aktívak
                  maradhatnak.
                </p>
              </div>

            </div>

            <div className="allegro-settings-info">
              PriceKit adat nélkül a termék alapból nincs a
              feedben. Egyedi kivétel a Termékek oldalon,
              „Mindig aktív” beállítással adható hozzá.
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
