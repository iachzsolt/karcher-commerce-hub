import {
  useEffect,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from '../config/api'

function PlatformMasterSwitches() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const [savedIsActive, setSavedIsActive] =
    useState(false)
  const [allegroConnected, setAllegroConnected] =
    useState<boolean | null>(null)
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)

  const dirty = isActive !== savedIsActive

  async function loadPlatforms() {
    setLoading(true)
    setFeedback(null)

    try {
      const [feedResponse, allegroResponse] =
        await Promise.all([
          fetch(
            `${API_BASE_URL}/arukereso/feed/settings`,
          ),
          fetch(
            `${API_BASE_URL}/auth/allegro/status`,
          ),
        ])
      const feedResult =
        (await feedResponse.json()) as {
          isActive?: boolean
          message?: string
        }

      if (
        !feedResponse.ok ||
        typeof feedResult.isActive !== 'boolean'
      ) {
        throw new Error(
          feedResult.message ??
            'A platformok állapota nem tölthető be.',
        )
      }

      setIsActive(feedResult.isActive)
      setSavedIsActive(feedResult.isActive)

      if (allegroResponse.ok) {
        const allegroResult =
          (await allegroResponse.json()) as {
            connected?: boolean
          }

        if (
          typeof allegroResult.connected ===
          'boolean'
        ) {
          setAllegroConnected(
            allegroResult.connected,
          )
        }
      }
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'A platformok állapota nem tölthető be.',
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadPlatforms()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [])

  async function saveArukereso() {
    setSaving(true)
    setFeedback(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/settings`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            isActive,
          }),
        },
      )
      const result = (await response.json()) as {
        isActive?: boolean
        message?: string
      }

      if (
        !response.ok ||
        typeof result.isActive !== 'boolean'
      ) {
        throw new Error(
          result.message ??
            'Az Árukereső kapcsoló mentése sikertelen.',
        )
      }

      setIsActive(result.isActive)
      setSavedIsActive(result.isActive)
      setFeedback({
        kind: 'success',
        text: result.isActive
          ? 'Az Árukereső integráció bekapcsolva.'
          : 'Az Árukereső integráció kikapcsolva.',
      })
    } catch (error) {
      setFeedback({
        kind: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Az Árukereső kapcsoló mentése sikertelen.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="hub-section">
      <div className="hub-section-heading">
        <div>
          <h3>Platformok</h3>
          <p>
            Az aktív értékesítési csatornák
            kezelése a Commerce Hubban.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="hub-empty-state">
          <strong>
            Platformok betöltése…
          </strong>
        </div>
      ) : (
        <div className="hub-platform-list">
          <article className="hub-platform-row is-allegro">
            <div className="hub-platform-main">
              <span className="platform-type">
                MARKETPLACE
              </span>
              <div className="hub-platform-title">
                <h4>Allegro</h4>
                {allegroConnected !== null && (
                  <span
                    className={
                      allegroConnected
                        ? 'platform-status platform-status-active'
                        : 'platform-status platform-status-disconnected'
                    }
                  >
                    <span className="platform-status-dot" />
                    {allegroConnected
                      ? 'Aktív'
                      : 'Nincs kapcsolat'}
                  </span>
                )}
              </div>
              <p>
                Ajánlatok, kampányok és
                szinkronizáció kezelése.
              </p>
            </div>
            <div className="hub-platform-side">
              <Link
                className="hub-text-link"
                to="/allegro/settings"
              >
                Beállítások megnyitása →
              </Link>
            </div>
          </article>

          <article className="hub-platform-row is-arukereso">
            <div className="hub-platform-main">
              <span className="platform-type">
                ÁR-ÖSSZEHASONLÍTÓ
              </span>
              <div className="hub-platform-title">
                <h4>Árukereső</h4>
                <span
                  className={
                    isActive
                      ? 'platform-status platform-status-active'
                      : 'platform-status platform-status-disconnected'
                  }
                >
                  <span className="platform-status-dot" />
                  {isActive
                    ? 'Aktív'
                    : 'Kikapcsolva'}
                </span>
              </div>
              <p>
                {isActive
                  ? 'A publikus feed a normál aktuális ajánlatokat szolgálja ki.'
                  : 'Leállított állapot: a publikus feed minden ajánlatot DeliveryTime=NO értékkel ad át.'}
              </p>
            </div>
            <div className="hub-platform-side">
              <label className="schedule-switch">
                <input
                  type="checkbox"
                  checked={isActive}
                  disabled={saving}
                  onChange={(event) => {
                    setIsActive(
                      event.target.checked,
                    )
                    setFeedback(null)
                  }}
                />
                <span aria-hidden="true" />
                <strong>
                  {isActive
                    ? 'Bekapcsolva'
                    : 'Kikapcsolva'}
                </strong>
              </label>
              {dirty && (
                <button
                  type="button"
                  className="hub-primary-button"
                  disabled={saving}
                  onClick={() =>
                    void saveArukereso()
                  }
                >
                  {saving
                    ? 'Mentés…'
                    : 'Mentés'}
                </button>
              )}
              <Link
                className="hub-text-link"
                to="/arukereso/settings"
              >
                Beállítások megnyitása →
              </Link>
            </div>
          </article>
        </div>
      )}

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
    </section>
  )
}

export default PlatformMasterSwitches
