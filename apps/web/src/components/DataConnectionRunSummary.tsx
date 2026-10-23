import {
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'
import { isActiveRun, startActiveRunPolling } from '../utils/activeRunPolling'

type DataConnectionRun = {
  id: string
  connectionId: string
  triggerType: string
  status: string
  importStatus: string | null
  rowsImported: number
  changedItemCount: number
  error: string | null
  startedAt: string
  finishedAt: string | null
}

type LatestRunResponse = {
  run: DataConnectionRun | null
}

type Props = {
  connectionId: string
}

function formatRunDate(
  value: string | null,
) {
  if (!value) {
    return '–'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '–'
  }

  return new Intl.DateTimeFormat(
    'hu-HU',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
  ).format(date)
}

function getStatusLabel(
  status: string,
) {
  if (status === 'COMPLETED') {
    return '✓ Sikeres'
  }

  if (status === 'IMPORT_ONLY') {
    return 'Csak beolvasás'
  }

  if (status === 'SUCCESS') {
    return 'Nem ellenőrizhető'
  }

  if (status === 'FAILED') {
    return 'Sikertelen'
  }

  if (status === 'RUNNING') {
    return 'Folyamatban'
  }

  if (status === 'PARTIAL') {
    return 'Részleges'
  }

  return status
}

function getStatusClass(
  status: string,
) {
  if (status === 'COMPLETED') {
    return 'success'
  }

  if (status === 'FAILED') {
    return 'error'
  }

  if (status === 'PARTIAL' || status === 'IMPORT_ONLY') {
    return 'warning'
  }

  return 'neutral'
}

function getImportStatusLabel(
  status: string | null,
) {
  if (!status) {
    return '–'
  }

  if (status === 'NO_CHANGE') {
    return 'Nincs változás'
  }

  if (status === 'SUCCESS') {
    return 'Sikeres'
  }

  if (status === 'FAILED') {
    return 'Sikertelen'
  }

  if (status === 'RUNNING') {
    return 'Folyamatban'
  }

  return status
}

function DataConnectionRunSummary({
  connectionId,
}: Props) {
  const [run, setRun] =
    useState<DataConnectionRun | null>(
      null,
    )
  useEffect(() => {
    return startActiveRunPolling<DataConnectionRun | null>({
      read: async () => {
        const response = await fetch(`${API_BASE_URL}/data-connections/${connectionId}/runs/latest`)
        if (!response.ok) throw new Error('Run summary unavailable')
        const result = await response.json() as LatestRunResponse
        return result.run ?? null
      },
      publish: setRun,
      isActive: value => isActiveRun(value?.status),
      visibility: () => document.visibilityState,
      subscribe: listener => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: timer => window.clearTimeout(timer),
    })
  }, [connectionId])

  if (!run) {
    return null
  }

  return (
    <div className="data-connection-run-summary">
      <div className="data-connection-run-header">
        <div>
          <span>
            UTOLSÓ AUTOMATIKUS FUTÁS
          </span>

          <small>
            {formatRunDate(
              run.finishedAt ??
                run.startedAt,
            )}
          </small>
        </div>

        <strong
          className={`data-connection-run-status data-connection-run-status-${getStatusClass(
            run.status,
          )}`}
        >
          {getStatusLabel(
            run.status,
          )}
        </strong>
      </div>

      <div className="data-connection-run-metrics">
        <div>
          <span>
            Beolvasott SKU
          </span>

          <strong>
            {run.rowsImported}
          </strong>
        </div>

        <div>
          <span>
            Módosult tétel
          </span>

          <strong>
            {run.changedItemCount}
          </strong>
        </div>

        <div>
          <span>
            Import állapot
          </span>

          <strong>
            {getImportStatusLabel(
              run.importStatus,
            )}
          </strong>
        </div>
      </div>

      {run.error && (
        <div className="data-connection-run-error">
          {run.error}
        </div>
      )}
    </div>
  )
}

export default DataConnectionRunSummary
