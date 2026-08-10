import {
  useEffect,
  useState,
} from 'react'

const API_BASE_URL =
  'http://localhost:3000'

type InventorySyncSettings = {
  enabled: boolean
  triggerMode: string
  updatedAt: string | null
}

function AllegroSettingsPage() {
  const [
    syncEnabled,
    setSyncEnabled,
  ] = useState(false)

  const [
    loading,
    setLoading,
  ] = useState(true)

  const [
    saving,
    setSaving,
  ] = useState(false)

  const [
    error,
    setError,
  ] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const loadSettings =
      async () => {
        try {
          const response =
            await fetch(
              `${API_BASE_URL}/auth/allegro/inventory-sync-settings`,
            )

          if (!response.ok) {
            throw new Error(
              'A készletszinkron beállítása nem tölthető be.',
            )
          }

          const result =
            (await response.json()) as
              InventorySyncSettings

          setSyncEnabled(
            result.enabled,
          )
        } catch (loadError) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Ismeretlen hiba történt.',
          )
        } finally {
          setLoading(false)
        }
      }

    void loadSettings()
  }, [])

  const updateSyncEnabled =
    async (
      enabled: boolean,
    ) => {
      setSaving(true)
      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/auth/allegro/inventory-sync-settings`,
            {
              method: 'PUT',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                enabled,
              }),
            },
          )

        if (!response.ok) {
          throw new Error(
            'A készletszinkron beállítása nem menthető.',
          )
        }

        const result =
          (await response.json()) as
            InventorySyncSettings

        setSyncEnabled(
          result.enabled,
        )
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : 'Ismeretlen hiba történt.',
        )
      } finally {
        setSaving(false)
      }
    }

  return (
    <section className="allegro-settings-page">
      <div className="allegro-settings-heading">
        <p className="section-label">
          ALLEGRO
        </p>

        <h2>Beállítások</h2>

        <p>
          Az Allegro és a Commerce Hub közötti
          szinkronizáció kezelése.
        </p>
      </div>

      <div className="allegro-settings-card">
        <div className="allegro-settings-card-header">
          <div>
            <span className="allegro-settings-eyebrow">
              KÉSZLETSZINKRON
            </span>

            <h3>
              Commerce Hub készlet → Allegro
            </h3>

            <p>
              Az Allegro ajánlatok készlete a Commerce Hub
              központi készletadatai alapján frissül.
            </p>
          </div>

          <label className="allegro-sync-switch">
            <input
              type="checkbox"
              checked={syncEnabled}
              disabled={
                loading ||
                saving
              }
              onChange={(event) => {
                void updateSyncEnabled(
                  event.target.checked,
                )
              }}
            />

            <span />

            <strong>
              {loading
                ? 'Betöltés...'
                : saving
                  ? 'Mentés...'
                  : syncEnabled
                    ? 'Bekapcsolva'
                    : 'Kikapcsolva'}
            </strong>
          </label>
        </div>

        {error && (
          <div className="allegro-settings-error">
            {error}
          </div>
        )}

        <div className="allegro-settings-source">
          <div className="allegro-settings-source-node">
            <span>CH</span>

            <div>
              <strong>Commerce Hub</strong>
              <small>Központi készlet</small>
            </div>
          </div>

          <div className="allegro-settings-source-arrow">
            →
          </div>

          <div className="allegro-settings-source-node">
            <span>A</span>

            <div>
              <strong>Allegro</strong>
              <small>Ajánlatkészlet</small>
            </div>
          </div>
        </div>

        <div className="allegro-settings-rules">
          <div>
            <span>✓</span>
            <div>
              <strong>
                Központi készlet használata
              </strong>
              <small>
                Az Allegro készletértékét a Commerce Hub
                központi készlete határozza meg.
              </small>
            </div>
          </div>

          <div>
            <span>✓</span>
            <div>
              <strong>
                0 készlet → ajánlat leállítása
              </strong>
              <small>
                Nulla elérhető készlet esetén az ajánlat
                automatikusan leállítható.
              </small>
            </div>
          </div>

          <div>
            <span>✓</span>
            <div>
              <strong>
                Készlet visszatér → újraaktiválás
              </strong>
              <small>
                A Commerce Hub által készlethiány miatt
                leállított ajánlat újraaktiválható.
              </small>
            </div>
          </div>

          <div>
            <span>✓</span>
            <div>
              <strong>
                Készlet rögzítve → kihagyás
              </strong>
              <small>
                A manuálisan rögzített készletű ajánlatokat
                az automatizáció nem módosítja.
              </small>
            </div>
          </div>
        </div>

        <div className="allegro-settings-runtime">
          <div>
            <span>Automatikus szinkron</span>
            <strong>
              {syncEnabled
                ? 'Bekapcsolva'
                : 'Kikapcsolva'}
            </strong>
          </div>

          <div>
            <span>Forrás</span>
            <strong>
              Commerce Hub központi készlet
            </strong>
          </div>

          <div>
            <span>Indítás módja</span>
            <strong>
              Központi készletfrissítés után
            </strong>
          </div>
        </div>
      </div>
    </section>
  )
}

export default AllegroSettingsPage