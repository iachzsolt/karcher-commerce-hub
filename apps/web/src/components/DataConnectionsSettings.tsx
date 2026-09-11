import DataConnectionSchedulePanel from './DataConnectionSchedulePanel'
import {
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

type DataConnection = {
  id: string
  name: string
  sourceType: string
  purpose: string
  isActive: boolean
  status: string
  lastSuccessfulAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

type InventoryConnectionConfig = {
  id: string
  connectionId: string
  spreadsheetId: string
  spreadsheetUrl: string | null
  sheetName: string
  headerRow: number
  skuSourceField: string
  stockSourceField: string
}

type ConnectionRow = {
  connection: DataConnection
  config: InventoryConnectionConfig | null
}

type InventoryItem = {
  sku: string
  stock: number
  sourceStockValue: string | null
  normalizedToZero: boolean
  observedAt: string
}

type InventoryItemsResponse = {
  run: {
    id: string
    status: string
    startedAt: string
    finishedAt: string | null
  } | null
  data: InventoryItem[]
}

type ConnectionMetric = {
  itemCount: number
  normalizedCount: number
}

type InspectResponse = {
  spreadsheetId: string
  title: string | null
  sheets: Array<{
    id: number | null
    title: string
    index: number | null
    hidden: boolean
  }>
  headers: string[] | null
}

type TestResponse = {
  ok: boolean
  valid: boolean
  rowsRead: number
  rowsImported: number
  rowsNormalizedToZero: number
  duplicateSkuCount: number
  blankSkuCount: number
}

type ImportResponse = {
  status: string
  rowsRead: number
  rowsImported: number
  rowsNormalizedToZero: number
  changedItemCount: number
  removedItemCount?: number
}

type CreateResponse = {
  connection: DataConnection
  config: InventoryConnectionConfig
}

type BusyAction = {
  connectionId: string
  action: 'test' | 'import' | 'activate'
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
    return 'Még nem történt import'
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
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ).format(date)
}

function getStatusLabel(
  status: string,
) {
  switch (status) {
    case 'ACTIVE':
      return 'Kapcsolódva'

    case 'READY':
      return 'Kapcsolódva'

    case 'READY_WITH_WARNINGS':
      return 'Figyelmeztetés'

    case 'ERROR':
      return 'Hiba'

    case 'NOT_CONFIGURED':
      return 'Nincs tesztelve'

    default:
      return status
  }
}

function getStatusClass(
  status: string,
) {
  return status
    .toLowerCase()
    .replaceAll('_', '-')
}

function getPurposeLabel(
  purpose: string,
) {
  switch (purpose) {
    case 'INVENTORY':
      return 'Készletforrás'

    case 'PRICING':
      return 'Árforrás'

    case 'CATALOG':
      return 'Katalógusforrás'

    default:
      return 'Adatforrás'
  }
}

function getSourceLabel(
  sourceType: string,
) {
  switch (sourceType) {
    case 'GOOGLE_SHEETS':
      return 'Google Sheets'

    case 'CSV_UPLOAD':
      return 'CSV feltöltés'

    default:
      return sourceType
  }
}

type PurposeGroup =
  | 'INVENTORY'
  | 'PRICING'
  | 'CATALOG'
  | 'OTHER'

function getPurposeGroup(
  purpose: string,
): PurposeGroup {
  switch (purpose) {
    case 'INVENTORY':
    case 'PRICING':
    case 'CATALOG':
      return purpose

    default:
      return 'OTHER'
  }
}

const PURPOSE_SECTIONS: Array<{
  group: PurposeGroup
  title: string
  description: string
  emptyLabel: string
  canCreate: boolean
}> = [
  {
    group: 'INVENTORY',
    title: 'Készlet',
    description:
      'Készletadatok forrásai és szinkronizációja.',
    emptyLabel: 'Nincs készletforrás kapcsolat.',
    canCreate: true,
  },
  {
    group: 'PRICING',
    title: 'Árazás',
    description:
      'Ár- és promóciós adatok forrásai.',
    emptyLabel: 'Nincs árforrás kapcsolat.',
    canCreate: false,
  },
  {
    group: 'CATALOG',
    title: 'Katalógus',
    description:
      'Termék- és katalógusadatok forrásai.',
    emptyLabel: 'Nincs katalógusforrás kapcsolat.',
    canCreate: false,
  },
  {
    group: 'OTHER',
    title: 'Egyéb',
    description:
      'Nem besorolt adatkapcsolatok.',
    emptyLabel: '',
    canCreate: false,
  },
]

function getConnectionHealth(
  connection: DataConnection,
): 'active' | 'partial' | 'error' {
  if (connection.status === 'ERROR') {
    return 'error'
  }

  if (
    connection.isActive &&
    (connection.status === 'READY' ||
      connection.status === 'ACTIVE')
  ) {
    return 'active'
  }

  return 'partial'
}

type PricingStatusResponse = {
  pricingConnectionIds?: string[]
  totalRows?: number
  currentRows?: number
  latestObservedAt?: string | null
  dataStatusCounts?: {
    hasCompetitor?: number
    noCompetitor?: number
    partialMarketData?: number
  }
  coverage?: {
    candidateProducts?: number
    withCurrentPricing?: number
    missingCurrentPricing?: number
    percent?: number
  } | null
  pricingStatus?: 'HAS_DATA' | 'NO_DATA'
  message?: string
}

function DataConnectionsSettings() {
  const [
    connections,
    setConnections,
  ] = useState<ConnectionRow[]>([])

  const [
    metrics,
    setMetrics,
  ] = useState<
    Record<
      string,
      ConnectionMetric
    >
  >({})

  const [
    loading,
    setLoading,
  ] = useState(true)

  const [
    busy,
    setBusy,
  ] = useState<BusyAction | null>(
    null,
  )

  const [
    message,
    setMessage,
  ] = useState<string | null>(
    null,
  )

  const [
    error,
    setError,
  ] = useState<string | null>(
    null,
  )

  const [
    showCreate,
    setShowCreate,
  ] = useState(false)

  const [
    connectionName,
    setConnectionName,
  ] = useState('')

  const [
    spreadsheet,
    setSpreadsheet,
  ] = useState('')

  const [
    sheetName,
    setSheetName,
  ] = useState('')

  const [
    headerRow,
    setHeaderRow,
  ] = useState(1)

  const [
    skuSourceField,
    setSkuSourceField,
  ] = useState('')

  const [
    stockSourceField,
    setStockSourceField,
  ] = useState('')

  const [
    inspectResult,
    setInspectResult,
  ] = useState<InspectResponse | null>(
    null,
  )

  const [
    headers,
    setHeaders,
  ] = useState<string[]>([])

  const [
    wizardBusy,
    setWizardBusy,
  ] = useState(false)

  const [
    wizardError,
    setWizardError,
  ] = useState<string | null>(
    null,
  )

  const loadConnections =
    async () => {
      setLoading(true)
      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections`,
          )

        const result =
          await readJson<{
            data: ConnectionRow[]
          }>(response)

        setConnections(
          result.data,
        )

        const metricEntries =
          await Promise.all(
            result.data.map(
              async ({
                connection,
              }) => {
                try {
                  const itemResponse =
                    await fetch(
                      `${API_BASE_URL}/data-connections/${connection.id}/items`,
                    )

                  const itemResult =
                    await readJson<InventoryItemsResponse>(
                      itemResponse,
                    )

                  return [
                    connection.id,
                    {
                      itemCount:
                        itemResult
                          .data
                          .length,
                      normalizedCount:
                        itemResult
                          .data
                          .filter(
                            (item) =>
                              item
                                .normalizedToZero,
                          )
                          .length,
                    },
                  ] as const
                } catch {
                  return [
                    connection.id,
                    {
                      itemCount: 0,
                      normalizedCount: 0,
                    },
                  ] as const
                }
              },
            ),
          )

        setMetrics(
          Object.fromEntries(
            metricEntries,
          ),
        )
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Az adatkapcsolatok nem tölthetők be.',
        )
      } finally {
        setLoading(false)
      }
    }

  const [
    pricingStatus,
    setPricingStatus,
  ] = useState<PricingStatusResponse | null>(
    null,
  )

  const [
    pricingStatusLoading,
    setPricingStatusLoading,
  ] = useState(true)

  const [
    pricingStatusError,
    setPricingStatusError,
  ] = useState<string | null>(null)

  async function loadPricingStatus() {
    setPricingStatusLoading(true)
    setPricingStatusError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/pricing/status`,
      )
      const result =
        (await response.json()) as PricingStatusResponse

      if (
        !response.ok ||
        typeof result.totalRows !== 'number' ||
        typeof result.currentRows !== 'number'
      ) {
        throw new Error(
          result.message ??
            'A pricing diagnosztika nem tölthető be.',
        )
      }

      setPricingStatus(result)
    } catch (loadError) {
      setPricingStatusError(
        loadError instanceof Error
          ? loadError.message
          : 'A pricing diagnosztika nem tölthető be.',
      )
      setPricingStatus(null)
    } finally {
      setPricingStatusLoading(false)
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadConnections()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadPricingStatus()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [])

  const handleTest =
    async (
      connectionId: string,
    ) => {
      setBusy({
        connectionId,
        action: 'test',
      })

      setMessage(null)
      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/${connectionId}/test`,
            {
              method: 'POST',
            },
          )

        const result =
          await readJson<TestResponse>(
            response,
          )

        setMessage(
          [
            'Kapcsolat rendben.',
            `${result.rowsImported} cikkszám`,
            `${result.rowsNormalizedToZero} érték 0-ra normalizálva.`,
          ].join(' '),
        )

        await loadConnections()
      } catch (testError) {
        setError(
          testError instanceof Error
            ? testError.message
            : 'A kapcsolat tesztelése sikertelen.',
        )
      } finally {
        setBusy(null)
      }
    }

  const handleActivate =
    async (
      connectionId: string,
    ) => {
      setBusy({
        connectionId,
        action: 'activate',
      })

      setMessage(null)
      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/${connectionId}/activate`,
            {
              method: 'POST',
            },
          )

        await readJson<{
          connection: DataConnection
        }>(response)

        setMessage(
          'Az adatkapcsolat mostantól az aktív készletforrás.',
        )

        await loadConnections()
      } catch (activateError) {
        setError(
          activateError instanceof Error
            ? activateError.message
            : 'Az aktív készletforrás nem állítható be.',
        )
      } finally {
        setBusy(null)
      }
    }

  const handleImport =
    async (
      connectionId: string,
    ) => {
      setBusy({
        connectionId,
        action: 'import',
      })

      setMessage(null)
      setError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/${connectionId}/import`,
            {
              method: 'POST',
            },
          )

        const result =
          await readJson<ImportResponse>(
            response,
          )

        if (
          result.status ===
          'NO_CHANGE'
        ) {
          setMessage(
            `A készlet beolvasva: ${result.rowsImported} cikkszám, nincs változás.`,
          )
        } else {
          const removed =
            result.removedItemCount ??
            0

          setMessage(
            [
              `A készlet sikeresen beolvasva: ${result.rowsImported} cikkszám.`,
              `${result.changedItemCount} változás.`,
              removed > 0
                ? `${removed} eltűnt cikkszám eltávolítva.`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          )
        }

        await loadConnections()
      } catch (importError) {
        setError(
          importError instanceof Error
            ? importError.message
            : 'Az import sikertelen.',
        )
      } finally {
        setBusy(null)
      }
    }

  const inspectSpreadsheet =
    async () => {
      setWizardBusy(true)
      setWizardError(null)
      setHeaders([])
      setSkuSourceField('')
      setStockSourceField('')

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/google-sheets/inspect`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                spreadsheet,
              }),
            },
          )

        const result =
          await readJson<InspectResponse>(
            response,
          )

        setInspectResult(result)

        const firstVisibleSheet =
          result.sheets.find(
            (sheet) =>
              !sheet.hidden,
          ) ??
          result.sheets[0]

        if (firstVisibleSheet) {
          setSheetName(
            firstVisibleSheet.title,
          )
        }

        if (
          !connectionName.trim() &&
          result.title
        ) {
          setConnectionName(
            result.title,
          )
        }
      } catch (inspectError) {
        setWizardError(
          inspectError instanceof Error
            ? inspectError.message
            : 'A Spreadsheet nem olvasható.',
        )
      } finally {
        setWizardBusy(false)
      }
    }

  const loadHeaders =
    async () => {
      if (!sheetName) {
        return
      }

      setWizardBusy(true)
      setWizardError(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections/google-sheets/inspect`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                spreadsheet,
                sheetName,
                headerRow,
              }),
            },
          )

        const result =
          await readJson<InspectResponse>(
            response,
          )

        const loadedHeaders =
          result.headers ?? []

        setHeaders(
          loadedHeaders,
        )

        const normalized =
          loadedHeaders.map(
            (header) =>
              header
                .trim()
                .toLocaleLowerCase(
                  'hu-HU',
                ),
          )

        const skuGuess =
          normalized.findIndex(
            (header) =>
              header.includes(
                'cikkszám',
              ) ||
              header === 'sku',
          )

        const stockGuess =
          normalized.findIndex(
            (header) =>
              header.includes(
                'készlet',
              ) ||
              header.includes(
                'stock',
              ),
          )

        if (skuGuess >= 0) {
          setSkuSourceField(
            loadedHeaders[
              skuGuess
            ],
          )
        }

        if (stockGuess >= 0) {
          setStockSourceField(
            loadedHeaders[
              stockGuess
            ],
          )
        }
      } catch (headerError) {
        setWizardError(
          headerError instanceof Error
            ? headerError.message
            : 'A fejléc nem olvasható.',
        )
      } finally {
        setWizardBusy(false)
      }
    }

  const resetWizard =
    () => {
      setConnectionName('')
      setSpreadsheet('')
      setSheetName('')
      setHeaderRow(1)
      setSkuSourceField('')
      setStockSourceField('')
      setInspectResult(null)
      setHeaders([])
      setWizardError(null)
    }

  const closeWizard =
    () => {
      setShowCreate(false)
      resetWizard()
    }

  const createConnection =
    async () => {
      setWizardBusy(true)
      setWizardError(null)
      setMessage(null)

      try {
        const response =
          await fetch(
            `${API_BASE_URL}/data-connections`,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body: JSON.stringify({
                name:
                  connectionName,
                spreadsheet,
                sheetName,
                headerRow,
                skuSourceField,
                stockSourceField,
              }),
            },
          )

        const created =
          await readJson<CreateResponse>(
            response,
          )

        const testResponse =
          await fetch(
            `${API_BASE_URL}/data-connections/${created.connection.id}/test`,
            {
              method: 'POST',
            },
          )

        if (testResponse.ok) {
          setMessage(
            'Az adatkapcsolat létrejött és a kapcsolat tesztje sikeres.',
          )
        } else {
          const testBody =
            (await testResponse
              .json()
              .catch(() => null)) as
              | {
                  error?: string
                }
              | null

          setMessage(
            [
              'Az adatkapcsolat elmentve,',
              'de a teszt hibát jelzett:',
              testBody?.error ??
                'ismeretlen hiba.',
            ].join(' '),
          )
        }

        closeWizard()

        await loadConnections()
      } catch (createError) {
        setWizardError(
          createError instanceof Error
            ? createError.message
            : 'Az adatkapcsolat nem hozható létre.',
        )
      } finally {
        setWizardBusy(false)
      }
    }

  const renderPriceKitOverview = (
    rows: ConnectionRow[],
  ) => {
    const coverage =
      pricingStatus?.coverage ?? null
    const counts =
      pricingStatus?.dataStatusCounts ?? null

    return (
      <div className="pricekit-panel">
        <div className="pricekit-panel-heading">
          <span className="allegro-settings-eyebrow">
            PRICING COCKPIT ÁTTEKINTÉS
          </span>
        </div>

        {rows.map(({ connection }) => {
          const health =
            getConnectionHealth(connection)

          return (
            <div
              className="pricekit-source"
              key={connection.id}
            >
              <div className="pricekit-source-top">
                <div>
                  <span className="pricekit-block-label">
                    Pricing Cockpit kapcsolat
                  </span>
                  <strong>
                    {connection.name}
                  </strong>
                  <small>
                    {getSourceLabel(
                      connection.sourceType,
                    )}
                  </small>
                </div>

                <span
                  className={
                    health === 'active'
                      ? 'platform-status platform-status-active'
                      : health === 'error'
                        ? 'connection-status status-error'
                        : 'platform-status platform-status-disconnected'
                  }
                >
                  <span
                    className={
                      health === 'error'
                        ? undefined
                        : 'platform-status-dot'
                    }
                  />
                  {health === 'active'
                    ? 'Aktív'
                    : health === 'error'
                      ? 'Hiba'
                      : 'Inaktív'}
                </span>
              </div>

              <div className="connection-metrics-grid">
                <div>
                  <span>
                    Kapcsolat állapota
                  </span>

                  <strong>
                    {getStatusLabel(
                      connection.status,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Utolsó frissítés
                  </span>

                  <strong className="connection-date-value">
                    {connection.lastSuccessfulAt
                      ? formatDate(
                          connection.lastSuccessfulAt,
                        )
                      : 'Nincs adat'}
                  </strong>
                </div>
              </div>
            </div>
          )
        })}

        <div className="pricekit-source">
          <div className="pricekit-source-top">
            <div>
              <span className="pricekit-block-label">
                Pricing Cockpit adatállapot
              </span>

              {pricingStatusLoading ? (
                <strong>
                  Betöltés…
                </strong>
              ) : pricingStatus ? (
                <strong className="pricekit-neutral">
                  {pricingStatus.pricingStatus ===
                  'HAS_DATA'
                    ? 'Van adat'
                    : 'Nincs adat'}
                </strong>
              ) : (
                <strong className="pricekit-neutral">
                  Nincs adat
                </strong>
              )}
            </div>
          </div>

          {pricingStatusError ? (
            <p className="hub-muted-line">
              A pricing diagnosztika nem
              érhető el.
            </p>
          ) : pricingStatus ? (
            <div className="connection-metrics-grid">
              <div>
                <span>
                  Legutóbbi pricing adat
                </span>

                <strong className="connection-date-value">
                  {pricingStatus.latestObservedAt
                    ? formatDate(
                        pricingStatus.latestObservedAt,
                      )
                    : 'Nincs adat'}
                </strong>
              </div>

              <div>
                <span>
                  Összes pricing sor
                </span>

                <strong>
                  {pricingStatus.totalRows}
                </strong>
              </div>

              <div>
                <span>
                  Aktuális pricing adatok
                </span>

                <strong>
                  {pricingStatus.currentRows}
                </strong>
              </div>

              {counts && (
                <div>
                  <span>
                    Piaci adatállapot
                  </span>

                  <strong>
                    {counts.hasCompetitor} van ·{' '}
                    {counts.noCompetitor} nincs ·{' '}
                    {counts.partialMarketData}{' '}
                    részleges
                  </strong>
                </div>
              )}
            </div>
          ) : null}

          {coverage && (
            <div className="pricekit-coverage">
              <span>
                Lefedettség a katalógushoz
                képest
              </span>

              <strong>
                {coverage.withCurrentPricing} /{' '}
                {coverage.candidateProducts}{' '}
                termék ·{' '}
                {String(
                  coverage.percent ?? 0,
                ).replace('.', ',')}
                %
              </strong>

              <small>
                A Pricing Cockpit jelenleg a
                katalógus kiválasztott
                termékkörét fedi le.
              </small>
            </div>
          )}

        </div>

        <div className="pricekit-fields">
          <span>
            Észlelt ármezők
          </span>

          <div>
            {[
              'Piaci index',
              'Mediánindex',
              'Átlagindex',
              'Piaci adatállapot',
            ].map((field) => (
              <span
                className="pricekit-chip"
                key={field}
              >
                {field}
              </span>
            ))}
          </div>

          <small>
            A Pricing Cockpit piaci
            árpozíció-indexeket szállít;
            abszolút aktuális- vagy akciós
            ármező nem része a jelenlegi
            adatfolyamnak.
          </small>
        </div>
      </div>
    )
  }

  return (
    <section className="hub-section data-connections-section">
      <div className="hub-section-heading">
        <div>
          <h3>Adatkapcsolatok</h3>

          <p>
            Külső adatforrások
            csatlakoztatása és kezelése.
          </p>
        </div>
      </div>

      {message && (
        <div className="connection-message connection-message-success">
          {message}
        </div>
      )}

      {error && (
        <div className="connection-message connection-message-error">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="connection-wizard">
          <div className="connection-wizard-heading">
            <div>
              <p className="section-label">
                ÚJ ADATKAPCSOLAT
              </p>

              <h4>
                Google Sheets készletforrás
              </h4>

              <p>
                A Commerce Hub mindig
                cikkszám + készlet
                adatpárt olvas be.
              </p>
            </div>

            <span className="connection-source-badge">
              Google Sheets
            </span>
          </div>

          {wizardError && (
            <div className="connection-message connection-message-error">
              {wizardError}
            </div>
          )}

          <div className="connection-wizard-step">
            <div className="wizard-step-number">
              1
            </div>

            <div className="wizard-step-content">
              <h5>Spreadsheet</h5>

              <div className="wizard-grid wizard-grid-source">
                <label>
                  <span>
                    Kapcsolat neve
                  </span>

                  <input
                    type="text"
                    value={
                      connectionName
                    }
                    onChange={(
                      event,
                    ) =>
                      setConnectionName(
                        event
                          .target
                          .value,
                      )
                    }
                    placeholder="Pl. HU készletforrás"
                  />
                </label>

                <label className="wizard-wide-field">
                  <span>
                    Google Spreadsheet link
                  </span>

                  <input
                    type="text"
                    value={
                      spreadsheet
                    }
                    onChange={(
                      event,
                    ) => {
                      setSpreadsheet(
                        event
                          .target
                          .value,
                      )

                      setInspectResult(
                        null,
                      )

                      setHeaders([])
                    }}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                  />
                </label>
              </div>

              <button
                className="hub-secondary-button"
                type="button"
                disabled={
                  wizardBusy ||
                  !spreadsheet.trim()
                }
                onClick={() =>
                  void inspectSpreadsheet()
                }
              >
                {wizardBusy
                  ? 'Ellenőrzés…'
                  : 'Spreadsheet ellenőrzése'}
              </button>

              {inspectResult && (
                <div className="wizard-success-line">
                  <span className="wizard-success-dot" />

                  <span>
                    {inspectResult.title ??
                      'Spreadsheet'}{' '}
                    elérhető
                  </span>
                </div>
              )}
            </div>
          </div>

          {inspectResult && (
            <div className="connection-wizard-step">
              <div className="wizard-step-number">
                2
              </div>

              <div className="wizard-step-content">
                <h5>
                  Munkalap és fejléc
                </h5>

                <div className="wizard-grid">
                  <label>
                    <span>
                      Munkalap
                    </span>

                    <select
                      value={
                        sheetName
                      }
                      onChange={(
                        event,
                      ) => {
                        setSheetName(
                          event
                            .target
                            .value,
                        )

                        setHeaders(
                          [],
                        )

                        setSkuSourceField(
                          '',
                        )

                        setStockSourceField(
                          '',
                        )
                      }}
                    >
                      {inspectResult.sheets.map(
                        (sheet) => (
                          <option
                            key={
                              sheet.id ??
                              sheet.title
                            }
                            value={
                              sheet.title
                            }
                          >
                            {sheet.title}
                            {sheet.hidden
                              ? ' (rejtett)'
                              : ''}
                          </option>
                        ),
                      )}
                    </select>
                  </label>

                  <label>
                    <span>
                      Fejléc sora
                    </span>

                    <input
                      type="number"
                      min={1}
                      value={
                        headerRow
                      }
                      onChange={(
                        event,
                      ) =>
                        setHeaderRow(
                          Math.max(
                            1,
                            Number(
                              event
                                .target
                                .value,
                            ) || 1,
                          ),
                        )
                      }
                    />
                  </label>
                </div>

                <button
                  className="hub-secondary-button"
                  type="button"
                  disabled={
                    wizardBusy ||
                    !sheetName
                  }
                  onClick={() =>
                    void loadHeaders()
                  }
                >
                  Fejléc beolvasása
                </button>
              </div>
            </div>
          )}

          {headers.length > 0 && (
            <div className="connection-wizard-step">
              <div className="wizard-step-number">
                3
              </div>

              <div className="wizard-step-content">
                <h5>
                  Mezők összekötése
                </h5>

                <p>
                  Válaszd ki, melyik
                  forrásoszlop tartalmazza
                  a Commerce Hub két
                  készletmezőjét.
                </p>

                <div className="mapping-grid">
                  <div className="mapping-row">
                    <div className="mapping-target">
                      <span>
                        Commerce Hub
                      </span>

                      <strong>
                        Cikkszám
                      </strong>
                    </div>

                    <span className="mapping-arrow">
                      ←
                    </span>

                    <select
                      value={
                        skuSourceField
                      }
                      onChange={(
                        event,
                      ) =>
                        setSkuSourceField(
                          event
                            .target
                            .value,
                        )
                      }
                    >
                      <option value="">
                        Válassz oszlopot
                      </option>

                      {headers.map(
                        (header) => (
                          <option
                            key={
                              header
                            }
                            value={
                              header
                            }
                          >
                            {header}
                          </option>
                        ),
                      )}
                    </select>
                  </div>

                  <div className="mapping-row">
                    <div className="mapping-target">
                      <span>
                        Commerce Hub
                      </span>

                      <strong>
                        Készlet
                      </strong>
                    </div>

                    <span className="mapping-arrow">
                      ←
                    </span>

                    <select
                      value={
                        stockSourceField
                      }
                      onChange={(
                        event,
                      ) =>
                        setStockSourceField(
                          event
                            .target
                            .value,
                        )
                      }
                    >
                      <option value="">
                        Válassz oszlopot
                      </option>

                      {headers.map(
                        (header) => (
                          <option
                            key={
                              header
                            }
                            value={
                              header
                            }
                          >
                            {header}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                </div>

                <div className="normalization-note">
                  <strong>
                    Készletszabály:
                  </strong>{' '}
                  negatív, üres vagy
                  nem numerikus érték
                  automatikusan 0.
                </div>
              </div>
            </div>
          )}

          <div className="connection-wizard-footer">
            <button
              className="hub-secondary-button"
              type="button"
              onClick={
                closeWizard
              }
            >
              Mégse
            </button>

            <button
              className="hub-primary-button"
              type="button"
              disabled={
                wizardBusy ||
                !connectionName.trim() ||
                !spreadsheet.trim() ||
                !sheetName ||
                !skuSourceField ||
                !stockSourceField
              }
              onClick={() =>
                void createConnection()
              }
            >
              {wizardBusy
                ? 'Mentés…'
                : 'Adatkapcsolat mentése'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="hub-empty-state">
          <strong>
            Adatkapcsolatok betöltése…
          </strong>
        </div>
      ) : connections.length === 0 ? (
        <div className="hub-empty-state">
          <strong>
            Még nincs adatkapcsolat
          </strong>

          <p>
            Elsőként egy Google Sheets
            készletforrást köthetsz be.
          </p>
        </div>
      ) : (
        <>
          {PURPOSE_SECTIONS.filter(
            (section) =>
              section.group !== 'OTHER' ||
              connections.some(
                (row) =>
                  getPurposeGroup(
                    row.connection.purpose,
                  ) === 'OTHER',
              ),
          ).map((section) => {
            const rows = connections.filter(
              (row) =>
                getPurposeGroup(
                  row.connection.purpose,
                ) === section.group,
            )

            return (
              <div
                className="data-connection-purpose"
                key={section.group}
              >
                <div className="data-connection-purpose-heading">
                  <div>
                    <h4>
                      {section.title}
                    </h4>
                    <p>
                      {section.description}
                    </p>
                  </div>

                  {section.canCreate && (
                    <button
                      className="hub-primary-button"
                      type="button"
                      onClick={() =>
                        setShowCreate(
                          (current) =>
                            !current,
                        )
                      }
                    >
                      {showCreate
                        ? 'Bezárás'
                        : '+ Készletforrás hozzáadása'}
                    </button>
                  )}
                </div>

                {section.group ===
                  'PRICING' &&
                  rows.length > 0 &&
                  renderPriceKitOverview(rows)}

                {rows.length === 0 ? (
                  <p className="hub-muted-line">
                    {section.emptyLabel}
                  </p>
                ) : (
                  <div className="data-connection-list">
                    {rows.map(
                      ({
                        connection,
                        config,
                      }) => {
                        const metric =
                          metrics[
                            connection.id
                          ] ?? {
                            itemCount: 0,
                            normalizedCount: 0,
                          }

                        const testing =
                          busy?.connectionId ===
                            connection.id &&
                          busy.action ===
                            'test'

                        const importing =
                          busy?.connectionId ===
                            connection.id &&
                          busy.action ===
                            'import'

                        return (
                          <article
                            className={`data-connection-card${connection.isActive ? ' data-connection-card-active' : ''}`}
                            key={
                              connection.id
                            }
                          >
                            <div className="data-connection-card-top">
                              <div className="data-connection-identity">
                                <div className="connection-source-mark connection-source-mark-google-sheets">
                                  GS
                                </div>

                                <div>
                                  <div className="connection-card-title-line">
                                    <h4>
                                      {
                                        connection.name
                                      }
                                    </h4>

                                    <span
                                      className={`connection-status status-${getStatusClass(
                                        connection.status,
                                      )}`}
                                    >
                                      <span />

                                      {getStatusLabel(
                                        connection.status,
                                      )}
                                    </span>

                                    {connection.isActive && (
                                      <span className="active-source-badge">
                                        {`Aktív ${getPurposeLabel(
                                          connection.purpose,
                                        ).toLowerCase()}`}
                                      </span>
                                    )}
                                  </div>

                                  <p>
                                    {getSourceLabel(
                                      connection.sourceType,
                                    )}{' '}
                                    ·{' '}
                                    {getPurposeLabel(
                                      connection.purpose,
                                    )}
                                  </p>
                                </div>
                              </div>

                              {config
                                ?.spreadsheetUrl && (
                                <a
                                  className="connection-source-link"
                                  href={
                                    config.spreadsheetUrl
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Forrás megnyitása ↗
                                </a>
                              )}
                            </div>

                            <div className="connection-visual-flow">
                              <div className="connection-flow-node">
                                <span className="connection-flow-node-icon connection-flow-node-icon-google-sheets">
                                  GS
                                </span>

                                <div>
                                  <strong>
                                    Google Sheets
                                  </strong>

                                  <small>
                                    {config
                                      ?.sheetName ??
                                      'Nincs munkalap'}
                                  </small>
                                </div>
                              </div>

                              <div className="connection-flow-line">
                                <span />
                                <b>›</b>
                              </div>

                              <div className="connection-flow-node connection-flow-node-hub">
                                <span className="connection-flow-node-icon">
                                  CH
                                </span>

                                <div>
                                  <strong>
                                    Commerce Hub
                                  </strong>

                                  <small>
                                    SKU + készlet
                                  </small>
                                </div>
                              </div>
                            </div>

                            <div className="connection-metrics-grid">
                              <div>
                                <span>
                                  Importált tételek
                                </span>

                                <strong>
                                  {
                                    metric.itemCount
                                  }
                                </strong>
                              </div>

                              <div>
                                <span>
                                  0-ra normalizálva
                                </span>

                                <strong>
                                  {
                                    metric.normalizedCount
                                  }
                                </strong>
                              </div>

                              <div>
                                <span>
                                  Utolsó sikeres beolvasás
                                </span>

                                <strong className="connection-date-value">
                                  {formatDate(
                                    connection
                                      .lastSuccessfulAt,
                                  )}
                                </strong>
                              </div>
                            </div>

                            {config && (
                              <div className="connection-config-grid">
                                <div>
                                  <span>
                                    Munkalap
                                  </span>

                                  <strong>
                                    {
                                      config.sheetName
                                    }
                                  </strong>
                                </div>

                                <div>
                                  <span>
                                    Cikkszám
                                  </span>

                                  <strong>
                                    {
                                      config.skuSourceField
                                    }
                                  </strong>
                                </div>

                                <div>
                                  <span>
                                    Készlet
                                  </span>

                                  <strong>
                                    {
                                      config.stockSourceField
                                    }
                                  </strong>
                                </div>
                              </div>
                            )}

                            {connection.lastError && (
                              <div className="connection-inline-error">
                                {
                                  connection.lastError
                                }
                              </div>
                            )}

                            <DataConnectionSchedulePanel
                              connectionId={
                                connection.id
                              }
                              isActive={
                                connection.isActive
                              }
                            />

                            <div className="connection-card-actions">
                              {!connection.isActive && (
                                <button
                                  className="hub-secondary-button"
                                  type="button"
                                  disabled={
                                    busy !== null ||
                                    (
                                      connection.status !== 'READY' &&
                                      connection.status !== 'ACTIVE'
                                    )
                                  }
                                  onClick={() =>
                                    void handleActivate(
                                      connection.id,
                                    )
                                  }
                                >
                                  {busy?.connectionId ===
                                    connection.id &&
                                  busy.action ===
                                    'activate'
                                    ? 'Beállítás…'
                                    : 'Aktív készletforrásként'}
                                </button>
                              )}

                              <button
                                className="hub-secondary-button"
                                type="button"
                                disabled={
                                  busy !== null
                                }
                                onClick={() =>
                                  void handleTest(
                                    connection.id,
                                  )
                                }
                              >
                                {testing
                                  ? 'Tesztelés…'
                                  : 'Kapcsolat tesztelése'}
                              </button>

                              <button
                                className="hub-primary-button"
                                type="button"
                                disabled={
                                  busy !== null
                                }
                                onClick={() =>
                                  void handleImport(
                                    connection.id,
                                  )
                                }
                              >
                                {importing
                                  ? 'Beolvasás…'
                                  : 'Adatok beolvasása most'}
                              </button>
                            </div>
                          </article>
                        )
                      },
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </section>
  )
}

export default DataConnectionsSettings
