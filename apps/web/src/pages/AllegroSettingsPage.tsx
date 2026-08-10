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

type AllegroStatus = {
  status: string
  connected: boolean
  environment: string | null
  account?: {
    id: string
    login: string
    baseMarketplace: string | null
  }
  accessTokenExpiresAt?: string
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
    connectionLoading,
    setConnectionLoading,
  ] = useState(true)

  const [
    connection,
    setConnection,
  ] = useState<AllegroStatus | null>(
    null,
  )

  const [
    error,
    setError,
  ] = useState<string | null>(
    null,
  )

  const [
    connectionError,
    setConnectionError,
  ] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const loadData =
      async () => {
        setConnectionLoading(true)
        setLoading(true)

        try {
          const statusResponse =
            await fetch(
              `${API_BASE_URL}/auth/allegro/status`,
            )

          if (!statusResponse.ok) {
            throw new Error(
              'Az Allegro kapcsolat állapota nem tölthető be.',
            )
          }

          const status =
            (await statusResponse.json()) as
              AllegroStatus

          setConnection(status)

          if (!status.connected) {
            setSyncEnabled(false)
            return
          }

          const settingsResponse =
            await fetch(
              `${API_BASE_URL}/auth/allegro/inventory-sync-settings`,
            )

          if (!settingsResponse.ok) {
            throw new Error(
              'A készletszinkron beállítása nem tölthető be.',
            )
          }

          const settings =
            (await settingsResponse.json()) as
              InventorySyncSettings

          setSyncEnabled(
            settings.enabled,
          )
        } catch (loadError) {
          const message =
            loadError instanceof Error
              ? loadError.message
              : 'Ismeretlen hiba történt.'

          setConnectionError(message)
        } finally {
          setConnectionLoading(false)
          setLoading(false)
        }
      }

    void loadData()
  }, [])

  const connectAllegro = () => {
    window.location.assign(
      `${API_BASE_URL}/auth/allegro/connect`,
    )
  }

  const disconnectAllegro =
    async () => {
      const confirmed =
        window.confirm(
          'Biztosan le szeretnéd kapcsolni az Allegro fiókot?',
        )

      if (!confirmed) {
        return
      }

      setConnectionError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/auth/allegro/disconnect`,
            {
              method: 'POST',
            },
          )

        if (!response.ok) {
          throw new Error(
            'Az Allegro kapcsolat nem bontható.',
          )
        }

        setConnection({
          status: 'ok',
          connected: false,
          environment:
            connection?.environment ??
            null,
        })

        setSyncEnabled(false)
      } catch (disconnectError) {
        setConnectionError(
          disconnectError instanceof Error
            ? disconnectError.message
            : 'Ismeretlen hiba történt.',
        )
      }
    }

  const updateSyncEnabled =
    async (
      enabled: boolean,
    ) => {
      if (!connection?.connected) {
        return
      }

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

  const connected =
    connection?.connected === true

  return (
    <section className="allegro-settings-page">
      <div className="allegro-settings-heading">
        <span>ALLEGRO</span>

        <h2>Beállítások</h2>

        <p>
          Az Allegro és a Commerce Hub közötti
          szinkronizáció kezelése.
        </p>
      </div>

      <div className="allegro-connection-card">
        <div className="allegro-connection-main">
          <div className="allegro-connection-icon">
            A
          </div>

          <div>
            <span className="allegro-settings-eyebrow">
              ALLEGRO KAPCSOLAT
            </span>

            <div className="allegro-connection-title">
              <h3>
                Allegro kapcsolat
              </h3>

              {!connectionLoading && (
                <span
                  className={
                    connected
                      ? 'allegro-connection-status is-connected'
                      : 'allegro-connection-status'
                  }
                >
                  {connected
                    ? 'Csatlakoztatva'
                    : 'Nincs kapcsolat'}
                </span>
              )}
            </div>

            {connectionLoading ? (
              <p>
                Kapcsolat ellenőrzése...
              </p>
            ) : connected ? (
              <p>
                <strong>
                  {connection?.account?.login ??
                    'Allegro'}
                </strong>
                {' · '}
                {connection?.environment ??
                  '—'}
                {connection?.account
                  ?.baseMarketplace
                  ? ` · ${connection.account.baseMarketplace}`
                  : ''}
              </p>
            ) : (
              <p>
                Csatlakoztasd az Allegro fiókot a
                Commerce Hubhoz az adatok
                szinkronizálásához.
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          className="allegro-connection-button"
          disabled={connectionLoading}
          onClick={() => {
            if (connected) {
              void disconnectAllegro()
              return
            }

            connectAllegro()
          }}
        >
          {connected
            ? 'Kapcsolat bontása'
            : 'Kapcsolódás az Allegrohoz'}
        </button>
      </div>

      {connectionError && (
        <div className="allegro-settings-error allegro-connection-error">
          {connectionError}
        </div>
      )}

      <div
        className={
          connected
            ? 'allegro-settings-card'
            : 'allegro-settings-card is-disabled'
        }
      >
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
                !connected ||
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
              {!connected
                ? 'Kikapcsolva'
                : loading
                  ? 'Betöltés...'
                  : saving
                    ? 'Mentés...'
                    : syncEnabled
                      ? 'Bekapcsolva'
                      : 'Kikapcsolva'}
            </strong>
          </label>
        </div>

        {!connected && (
          <div className="allegro-settings-info">
            A készletszinkron az Allegro fiók
            csatlakoztatása után kapcsolható be.
          </div>
        )}

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

