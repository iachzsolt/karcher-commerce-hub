import {
  useEffect,
  useState,
} from 'react'

const API_BASE_URL =
  'http://localhost:3000'

type ScheduleMode =
  | 'DAILY_TIMES'
  | 'INTERVAL'

type ScheduleResponse = {
  connectionId: string
  enabled: boolean
  mode: ScheduleMode
  intervalMinutes: number | null
  dailyTimes: string[]
  timeZone: string
  weekdaysOnly: boolean
  lastRunAt: string | null
  nextRunAt: string | null
}

type ScheduleDraft = {
  enabled: boolean
  mode: ScheduleMode
  intervalMinutes: number
  dailyTimes: string[]
  weekdaysOnly: boolean
}

type SaveState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error'

type Props = {
  connectionId: string
  isActive: boolean
}

async function readJson<T>(
  response: Response,
): Promise<T> {
  const data =
    (await response
      .json()
      .catch(() => null)) as
      | ({
          error?: string
        } & Partial<T>)
      | null

  if (!response.ok) {
    throw new Error(
      data?.error ??
        `HTTP ${response.status}`,
    )
  }

  return data as T
}

function formatDate(
  value: string | null,
) {
  if (!value) {
    return '—'
  }

  const date =
    new Date(value)

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return value
  }

  return new Intl.DateTimeFormat(
    'hu-HU',
    {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date)
}

function DataConnectionSchedulePanel({
  connectionId,
  isActive,
}: Props) {
  const [
    loading,
    setLoading,
  ] = useState(true)

  const [
    enabled,
    setEnabled,
  ] = useState(false)

  const [
    mode,
    setMode,
  ] = useState<ScheduleMode>(
    'DAILY_TIMES',
  )

  const [
    intervalMinutes,
    setIntervalMinutes,
  ] = useState(60)

  const [
    dailyTimes,
    setDailyTimes,
  ] = useState<string[]>([])

  const [
    weekdaysOnly,
    setWeekdaysOnly,
  ] = useState(true)

  const [
    newTime,
    setNewTime,
  ] = useState('')

  const [
    showTimeInput,
    setShowTimeInput,
  ] = useState(false)

  const [
    lastRunAt,
    setLastRunAt,
  ] = useState<string | null>(
    null,
  )

  const [
    nextRunAt,
    setNextRunAt,
  ] = useState<string | null>(
    null,
  )

  const [
    saveState,
    setSaveState,
  ] = useState<SaveState>(
    'idle',
  )

  const [
    error,
    setError,
  ] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const load =
      async () => {
        setLoading(true)
        setError(null)

        try {
          const response =
            await fetch(
              `${API_BASE_URL}/data-connections/${connectionId}/schedule`,
            )

          const result =
            await readJson<ScheduleResponse>(
              response,
            )

          setEnabled(
            result.enabled,
          )

          setMode(
            result.mode,
          )

          setIntervalMinutes(
            result.intervalMinutes ??
              60,
          )

          setDailyTimes(
            result.dailyTimes,
          )

          setWeekdaysOnly(
            result.weekdaysOnly,
          )

          setLastRunAt(
            result.lastRunAt,
          )

          setNextRunAt(
            result.nextRunAt,
          )

          setSaveState(
            'saved',
          )
        } catch (loadError) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Az időzítés nem tölthető be.',
          )

          setSaveState(
            'error',
          )
        } finally {
          setLoading(false)
        }
      }

    void load()
  }, [connectionId])

  const persist =
    async (
      draft: ScheduleDraft,
    ) => {
      setSaveState(
        'saving',
      )

      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/${connectionId}/schedule`,
            {
              method: 'PUT',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                enabled:
                  draft.enabled,
                mode:
                  draft.mode,
                intervalMinutes:
                  draft.mode ===
                  'INTERVAL'
                    ? draft
                        .intervalMinutes
                    : null,
                dailyTimes:
                  draft.mode ===
                  'DAILY_TIMES'
                    ? draft.dailyTimes
                    : [],
                weekdaysOnly:
                  draft.weekdaysOnly,
              }),
            },
          )

        const result =
          await readJson<ScheduleResponse>(
            response,
          )

        setLastRunAt(
          result.lastRunAt,
        )

        setNextRunAt(
          result.nextRunAt,
        )

        setSaveState(
          'saved',
        )
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : 'Az időzítés nem menthető.',
        )

        setSaveState(
          'error',
        )
      }
    }

  const getDraft = (
    changes: Partial<ScheduleDraft> = {},
  ): ScheduleDraft => ({
    enabled,
    mode,
    intervalMinutes,
    dailyTimes,
    weekdaysOnly,
    ...changes,
  })

  const toggleEnabled = (
    nextEnabled: boolean,
  ) => {
    setEnabled(
      nextEnabled,
    )

    setError(null)

    /*
     * Ha még nincs napi időpont,
     * először csak kinyitjuk a panelt.
     * A mentés az első időpont
     * hozzáadásakor történik meg.
     */
    if (
      nextEnabled &&
      mode === 'DAILY_TIMES' &&
      dailyTimes.length === 0
    ) {
      setSaveState('idle')
      return
    }

    void persist(
      getDraft({
        enabled:
          nextEnabled,
      }),
    )
  }

  const changeMode = (
    nextMode: ScheduleMode,
  ) => {
    setMode(
      nextMode,
    )

    if (
      enabled &&
      nextMode ===
        'DAILY_TIMES' &&
      dailyTimes.length === 0
    ) {
      setError(
        'Adj meg legalább egy frissítési időpontot.',
      )

      return
    }

    void persist(
      getDraft({
        mode:
          nextMode,
      }),
    )
  }

  const addTime = () => {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(
        newTime,
      )
    ) {
      return
    }

    const nextTimes =
      [
        ...new Set([
          ...dailyTimes,
          newTime,
        ]),
      ].sort()

    setDailyTimes(
      nextTimes,
    )

    setNewTime('')
    setShowTimeInput(false)

    void persist(
      getDraft({
        dailyTimes:
          nextTimes,
      }),
    )
  }

  const removeTime = (
    value: string,
  ) => {
    const nextTimes =
      dailyTimes.filter(
        (time) =>
          time !== value,
      )

    if (
      enabled &&
      mode === 'DAILY_TIMES' &&
      nextTimes.length === 0
    ) {
      setError(
        'Bekapcsolt automatikus frissítésnél legalább egy időpont szükséges.',
      )

      return
    }

    setDailyTimes(
      nextTimes,
    )

    void persist(
      getDraft({
        dailyTimes:
          nextTimes,
      }),
    )
  }

  const changeInterval = (
    nextInterval: number,
  ) => {
    setIntervalMinutes(
      nextInterval,
    )

    void persist(
      getDraft({
        intervalMinutes:
          nextInterval,
      }),
    )
  }

  const changeWeekdaysOnly = (
    nextValue: boolean,
  ) => {
    setWeekdaysOnly(
      nextValue,
    )

    void persist(
      getDraft({
        weekdaysOnly:
          nextValue,
      }),
    )
  }

  if (loading) {
    return (
      <div className="schedule-panel schedule-panel-loading">
        Automatikus frissítés betöltése…
      </div>
    )
  }

  return (
    <div className="schedule-panel schedule-panel-v2">
      <div className="schedule-v2-header">
        <div className="schedule-v2-title">
          <div className="schedule-v2-title-line">
            <span className="schedule-eyebrow">
              AUTOMATIKUS FRISSÍTÉS
            </span>

            <span
              className={`schedule-save-state schedule-save-${saveState}`}
            >
              {saveState === 'saving'
                ? 'Mentés…'
                : saveState ===
                    'error'
                  ? 'Mentési hiba'
                  : '✓ Mentve'}
            </span>
          </div>

          <strong>
            Google Sheets → Commerce Hub
          </strong>

          <small>
            Az import még nem frissíti
            az Allegro készletet.
          </small>
        </div>

        <label className="schedule-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!isActive}
            onChange={(event) =>
              toggleEnabled(
                event.target.checked,
              )
            }
          />

          <span />

          <strong>
            {enabled
              ? 'Bekapcsolva'
              : 'Kikapcsolva'}
          </strong>
        </label>
      </div>

      {!isActive && (
        <div className="schedule-info-note">
          Automatikus frissítés csak az aktív
          készletforráson kapcsolható be.
        </div>
      )}

      {error && (
        <div className="schedule-v2-error">
          {error}
        </div>
      )}

      {enabled && (
        <div className="schedule-v2-expanded">
          <div className="schedule-v2-toolbar">
        <div className="schedule-v2-mode">
          <button
            type="button"
            className={
              mode === 'DAILY_TIMES'
                ? 'active'
                : ''
            }
            onClick={() =>
              changeMode(
                'DAILY_TIMES',
              )
            }
          >
            Időpontok
          </button>

          <button
            type="button"
            className={
              mode === 'INTERVAL'
                ? 'active'
                : ''
            }
            onClick={() =>
              changeMode(
                'INTERVAL',
              )
            }
          >
            Időközönként
          </button>
        </div>

        {mode === 'DAILY_TIMES' ? (
          <div className="schedule-v2-times">
            {dailyTimes.map(
              (time) => (
                <button
                  key={time}
                  type="button"
                  className="schedule-time-chip"
                  title="Időpont eltávolítása"
                  onClick={() =>
                    removeTime(
                      time,
                    )
                  }
                >
                  {time}
                  <b>×</b>
                </button>
              ),
            )}

            {showTimeInput ? (
              <div className="schedule-time-add schedule-time-add-open">
                <input
                  type="time"
                  autoFocus
                  value={newTime}
                  onChange={(event) =>
                    setNewTime(
                      event.target.value,
                    )
                  }
                />

                <button
                  type="button"
                  disabled={!newTime}
                  onClick={addTime}
                >
                  +
                </button>

                <button
                  type="button"
                  className="schedule-time-cancel"
                  onClick={() => {
                    setNewTime('')
                    setShowTimeInput(
                      false,
                    )
                  }}
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                className="schedule-add-time-button"
                type="button"
                onClick={() =>
                  setShowTimeInput(
                    true,
                  )
                }
              >
                + Időpont
              </button>
            )}
          </div>
        ) : (
          <select
            className="schedule-v2-interval"
            value={intervalMinutes}
            onChange={(event) =>
              changeInterval(
                Number(
                  event.target.value,
                ),
              )
            }
          >
            <option value={15}>
              15 percenként
            </option>

            <option value={30}>
              30 percenként
            </option>

            <option value={60}>
              1 óránként
            </option>

            <option value={120}>
              2 óránként
            </option>

            <option value={360}>
              6 óránként
            </option>

            <option value={720}>
              12 óránként
            </option>

            <option value={1440}>
              Naponta
            </option>
          </select>
        )}

        <label className="schedule-v2-weekdays">
          <input
            type="checkbox"
            checked={weekdaysOnly}
            onChange={(event) =>
              changeWeekdaysOnly(
                event.target.checked,
              )
            }
          />

          <span>
            Csak hétköznap
          </span>
        </label>
      </div>

      <div className="schedule-v2-runtime">
        <span>
          Utolsó futás
          <strong>
            {formatDate(
              lastRunAt,
            )}
          </strong>
        </span>

        <i />

        <span>
          Következő
          <strong>
            {enabled
              ? formatDate(
                  nextRunAt,
                )
              : 'Kikapcsolva'}
          </strong>
        </span>

        <small>
          Europe/Budapest
        </small>
          </div>
        </div>
      )}
    </div>
  )
}

export default DataConnectionSchedulePanel