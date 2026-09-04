import {
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

type CatalogPreviewSummary = {
  rows: number
  validRows: number
  invalidRows: number
  matchedBySku: number
  matchedByEan: number
  unmatched: number
  matchConflicts: number
}

type CatalogPreviewRow = {
  rowNumber: number
  identifier: string | null
  eanCode: string | null
  name: string | null
  priceRaw: string | null
  deliveryTimeRaw: string | null
  normalizedSku: string | null
  matchStatus:
    | 'MATCHED'
    | 'UNMATCHED'
    | 'CONFLICT'
  errors: string[]
}

type CatalogInvalidRow = {
  rowNumber: number
  identifier: string | null
  eanCode: string | null
  name: string | null
  priceRaw: string | null
  deliveryTimeRaw: string | null
  errors: string[]
}

type CatalogPreviewResult = {
  status: string
  fileName?: string
  summary: CatalogPreviewSummary
  data: CatalogPreviewRow[]
  invalidRows?: CatalogInvalidRow[]
}

type CatalogImportSummary = {
  rows?: number
  validRows?: number
  invalidRows?: number
  matchedBySku?: number
  matchedByEan?: number
  unmatched?: number
  matchConflicts?: number
  upserted?: number
  staleRemoved?: number
}

type CatalogImportResult = {
  status: string
  importRunId?: string
  summary?: CatalogImportSummary
  message?: string
}

type PromotionSummary = {
  unmatchedCatalogItems: number
  inventoryCovered: number
  safeNewProducts: number
  existingSku: number
  eanConflicts: number
  skuEanConflicts: number
  duplicateCatalogSku: number
  duplicateCatalogEan: number
  missingRequiredData: number
  inventoryMissing: number
}

type PromotionResult = {
  status: string
  summary: PromotionSummary
  message?: string
}

const CATALOG_ERROR_LABELS: Record<
  string,
  string
> = {
  MISSING_IDENTIFIER:
    'Hiányzó azonosító',
  MISSING_EAN: 'Hiányzó EAN',
  MISSING_NAME: 'Hiányzó terméknév',
  MISSING_PRODUCT_URL:
    'Hiányzó termék-URL',
  MISSING_IMAGE: 'Hiányzó kép',
  INVALID_PRICE: 'Érvénytelen ár',
  INVALID_DELIVERY_TIME:
    'Érvénytelen szállítási idő',
}

function formatCatalogError(
  code: string,
) {
  const label =
    CATALOG_ERROR_LABELS[code]

  return label
    ? `${label} (${code})`
    : code
}

function formatMatchStatus(
  status: CatalogPreviewRow['matchStatus'],
) {
  if (status === 'MATCHED')
    return 'Egyezik'
  if (status === 'CONFLICT')
    return 'Konfliktus'
  return 'Nem egyezik'
}

function fileIdentity(
  file: File,
) {
  return `${file.name}|${file.size}|${file.lastModified}`
}

const PREVIEW_VISIBLE_ROWS = 15

function ArukeresoCatalogPage() {
  const [selectedFile, setSelectedFile] =
    useState<File | null>(null)

  const [previewFileKey, setPreviewFileKey] =
    useState<string | null>(null)

  const [preview, setPreview] =
    useState<CatalogPreviewResult | null>(
      null,
    )

  const [previewLoading, setPreviewLoading] =
    useState(false)

  const [previewMessage, setPreviewMessage] =
    useState<string | null>(null)

  const [
    showAllPreviewRows,
    setShowAllPreviewRows,
  ] = useState(false)

  const [importLoading, setImportLoading] =
    useState(false)

  const [importResult, setImportResult] =
    useState<CatalogImportResult | null>(
      null,
    )

  const [importMessage, setImportMessage] =
    useState<string | null>(null)

  const [promotion, setPromotion] =
    useState<PromotionResult | null>(
      null,
    )

  const [promotionLoading, setPromotionLoading] =
    useState(false)

  const [promotionMessage, setPromotionMessage] =
    useState<string | null>(null)

  const [promoting, setPromoting] =
    useState(false)

  async function runPreview(
    file: File,
  ): Promise<boolean> {
    setPreviewLoading(true)
    setPreviewMessage(null)
    setImportResult(null)
    setImportMessage(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(
        `${API_BASE_URL}/arukereso/catalog/preview`,
        {
          method: 'POST',
          body: formData,
        },
      )

      const result =
        (await response.json()) as
          | CatalogPreviewResult
          | { message?: string }

      if (!response.ok) {
        throw new Error(
          (result as { message?: string })
            .message ??
            'Az előnézet készítése sikertelen.',
        )
      }

      const previewResult =
        result as CatalogPreviewResult

      setPreview(previewResult)
      setPreviewFileKey(
        fileIdentity(file),
      )
      setShowAllPreviewRows(false)
      setPreviewMessage(
        `${previewResult.summary.validRows} érvényes sor / ${previewResult.summary.rows} összes sor.`,
      )

      return true
    } catch (previewError) {
      console.error(
        'Catalog preview failed:',
        previewError,
      )

      setPreview(null)
      setPreviewFileKey(null)
      setPreviewMessage(
        previewError instanceof Error
          ? previewError.message
          : 'Az előnézet készítése sikertelen.',
      )

      return false
    } finally {
      setPreviewLoading(false)
    }
  }

  async function loadPromotion() {
    setPromotionLoading(true)
    setPromotionMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/catalog/promotion-preview?limit=100&offset=0`,
      )

      const result =
        (await response.json()) as
          | PromotionResult
          | { message?: string }

      if (!response.ok) {
        throw new Error(
          (result as { message?: string })
            .message ??
            'A promóciós előnézet betöltése sikertelen.',
        )
      }

      setPromotion(
        result as PromotionResult,
      )
    } catch (promotionError) {
      console.error(
        'Promotion preview failed:',
        promotionError,
      )

      setPromotionMessage(
        promotionError instanceof Error
          ? promotionError.message
          : 'A promóciós előnézet betöltése sikertelen.',
      )
    } finally {
      setPromotionLoading(false)
    }
  }

  useEffect(() => {
    void loadPromotion()
  }, [])

  const currentFileKey = selectedFile
    ? fileIdentity(selectedFile)
    : null

  const canImport =
    preview !== null &&
    previewFileKey !== null &&
    currentFileKey !== null &&
    previewFileKey === currentFileKey &&
    !previewLoading &&
    !importLoading

  const visiblePreviewRows =
    showAllPreviewRows
      ? (preview?.data ?? [])
      : (preview?.data ?? []).slice(
          0,
          PREVIEW_VISIBLE_ROWS,
        )

  async function runImport() {
    if (!selectedFile || !canImport) {
      return
    }

    const validCount =
      preview?.summary.validRows ?? 0

    const invalidCount =
      preview?.summary.invalidRows ?? 0

    const confirmed = window.confirm(
      `Biztosan importálod a katalógust?\n\n` +
        `${validCount} érvényes sor importálásra kerül.\n` +
        `${invalidCount} hibás sor kimarad.\n` +
        `A pillanatképben nem szereplő régi katalógussorok törlődhetnek, mert ez teljes snapshot import.`,
    )

    if (!confirmed) {
      return
    }

    setImportLoading(true)
    setImportMessage(null)

    try {
      const formData = new FormData()
      formData.append(
        'file',
        selectedFile,
      )
      formData.append(
        'confirm',
        'true',
      )

      const response = await fetch(
        `${API_BASE_URL}/arukereso/catalog/import`,
        {
          method: 'POST',
          body: formData,
        },
      )

      const result =
        (await response.json()) as CatalogImportResult

      if (!response.ok) {
        throw new Error(
          result.message ??
            'A katalógus importálása sikertelen.',
        )
      }

      setImportResult(result)
      setImportMessage(
        `Import kész: ${result.summary?.upserted ?? 0} sor importálva, ` +
          `${result.summary?.invalidRows ?? 0} hibás sor kihagyva, ` +
          `${result.summary?.staleRemoved ?? 0} elavult sor törölve.`,
      )

      await loadPromotion()
    } catch (importError) {
      console.error(
        'Catalog import failed:',
        importError,
      )

      setImportMessage(
        importError instanceof Error
          ? importError.message
          : 'A katalógus importálása sikertelen.',
      )
    } finally {
      setImportLoading(false)
    }
  }

  const promotionSummary =
    promotion?.summary ?? null

  const promotionBlockers =
    promotionSummary
      ? [
          promotionSummary.existingSku,
          promotionSummary.eanConflicts,
          promotionSummary.skuEanConflicts,
          promotionSummary.duplicateCatalogSku,
          promotionSummary.duplicateCatalogEan,
          promotionSummary.missingRequiredData,
          promotionSummary.inventoryMissing,
        ].reduce(
          (total, count) => total + count,
          0,
        )
      : 0

  const canPromote =
    promotionSummary !== null &&
    promotionSummary.safeNewProducts >
      0 &&
    promotionBlockers === 0 &&
    !promoting &&
    !promotionLoading

  async function runPromote() {
    if (!promotionSummary || !canPromote) {
      return
    }

    const confirmed = window.confirm(
      `Biztosan felveszed ${promotionSummary.safeNewProducts} új terméket a Hub terméktörzsébe?\n\n` +
        `Ez csak termékeket és EAN-azonosítókat hoz létre, az Allegro-kínálatot és a készletet nem módosítja.`,
    )

    if (!confirmed) {
      return
    }

    setPromoting(true)
    setPromotionMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/catalog/promote`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            confirm: true,
            expectedSafeCount:
              promotionSummary.safeNewProducts,
          }),
        },
      )

      const result =
        (await response.json()) as
          | {
              status: string
              promoted?: number
              productsCreated?: number
              eanIdentifiersCreated?: number
              catalogItemsLinked?: number
              message?: string
              summary?: PromotionSummary
            }
          | { message?: string }

      if (!response.ok) {
        throw new Error(
          (
            result as {
              message?: string
            }
          ).message ??
            'A termékek felvétele sikertelen.',
        )
      }

      const successResult = result as {
        promoted?: number
        productsCreated?: number
      }

      setPromotionMessage(
        `Siker: ${successResult.productsCreated ?? successResult.promoted ?? 0} új termék felvéve a Hubba.`,
      )

      await loadPromotion()

      if (selectedFile) {
        await runPreview(selectedFile)
      }
    } catch (promoteError) {
      console.error(
        'Catalog promotion failed:',
        promoteError,
      )

      setPromotionMessage(
        promoteError instanceof Error
          ? promoteError.message
          : 'A termékek felvétele sikertelen.',
      )
    } finally {
      setPromoting(false)
    }
  }

  return (
    <section className="campaigns-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">
            ÁRUKERESŐ
          </p>

          <h2>Katalógus import</h2>

          <p className="campaigns-page-description">
            CMS CSV előnézet, teljes
            snapshot import és
            terméktörzs-bővítés. Csak
            manuális műveletek, ütemezés
            nélkül.
          </p>
        </div>
      </div>

      <div className="campaign-offers-panel">
        <div className="campaign-offers-heading">
          <div>
            <p className="section-label">
              1. LÉPÉS
            </p>

            <h4>CSV kiválasztása</h4>
          </div>
        </div>

        <div className="campaign-submit-bar">
          <div className="catalog-file-picker">
            <label
              htmlFor="arukereso-catalog-file"
              className="secondary-button catalog-file-button"
            >
              Fájl kiválasztása
            </label>

            <input
              id="arukereso-catalog-file"
              className="catalog-file-input"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file =
                  event.target.files?.[0] ??
                  null

              setSelectedFile(file)
              setPreview(null)
              setPreviewFileKey(null)
              setPreviewMessage(null)
              setImportResult(null)
              setImportMessage(null)
              setShowAllPreviewRows(false)
              }}
            />

            <span className="catalog-file-name">
              {selectedFile
                ? selectedFile.name
                : 'Nincs fájl kiválasztva'}
            </span>
          </div>

          <div className="campaign-submit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={
                !selectedFile ||
                previewLoading
              }
              onClick={() => {
                if (selectedFile) {
                  void runPreview(
                    selectedFile,
                  )
                }
              }}
            >
              {previewLoading
                ? 'Előnézet…'
                : 'Előnézet'}
            </button>
          </div>
        </div>

        {previewMessage && (
          <div className="campaign-preparation-message">
            {previewMessage}
          </div>
        )}
      </div>

      {preview && (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-heading">
            <div>
              <p className="section-label">
                2. LÉPÉS
              </p>

              <h4>
                Előnézet összesítés
              </h4>
            </div>
          </div>

          <div className="catalog-kpi-grid">
            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {preview.summary.rows}
              </span>

              <span className="catalog-kpi-label">
                Összes sor
              </span>
            </div>

            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {preview.summary.validRows}
              </span>

              <span className="catalog-kpi-label">
                Érvényes
              </span>
            </div>

            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {
                  preview.summary
                    .invalidRows
                }
              </span>

              <span className="catalog-kpi-label">
                Hibás
              </span>
            </div>

            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {
                  preview.summary
                    .matchedBySku
                }
              </span>

              <span className="catalog-kpi-label">
                SKU alapján egyező
              </span>
            </div>

            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {preview.summary.unmatched}
              </span>

              <span className="catalog-kpi-label">
                Nem egyező
              </span>
            </div>

            <div className="catalog-kpi">
              <span className="catalog-kpi-value">
                {
                  preview.summary
                    .matchConflicts
                }
              </span>

              <span className="catalog-kpi-label">
                Konfliktus
              </span>
            </div>
          </div>

          <p className="catalog-kpi-secondary">
            EAN alapján egyező:{' '}
            {preview.summary.matchedByEan}
          </p>

          {(preview.invalidRows ?? [])
            .length > 0 && (
            <div>
              <div className="campaign-submit-warning">
                {
                  (
                    preview.invalidRows ??
                    []
                  ).length
                }{' '}
                hibás sor kimarad az
                importból.
              </div>

              <div className="campaign-offers-table-wrapper">
                <table className="campaign-offers-table">
                  <thead>
                    <tr>
                      <th>Sor</th>
                      <th>Identifier</th>
                      <th>Terméknév</th>
                      <th>Ár</th>
                      <th>Szállítási idő</th>
                      <th>Hibák</th>
                    </tr>
                  </thead>

                  <tbody>
                    {(
                      preview.invalidRows ??
                      []
                    ).map((row) => (
                      <tr
                        key={row.rowNumber}
                      >
                        <td>
                          {row.rowNumber}
                        </td>

                        <td>
                          {row.identifier ??
                            '–'}
                        </td>

                        <td>
                          {row.name ?? '–'}
                        </td>

                        <td>
                          {row.priceRaw ??
                            '–'}
                        </td>

                        <td>
                          {row.deliveryTimeRaw ??
                            '–'}
                        </td>

                        <td>
                          {row.errors
                            .map(
                              formatCatalogError,
                            )
                            .join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="campaign-submit-bar">
            <span>
              {preview.summary.validRows}{' '}
              érvényes sor importálható
            </span>

            <div className="campaign-submit-actions">
              <button
                type="button"
                className="campaign-primary-button"
                disabled={
                  !canImport ||
                  importLoading
                }
                onClick={() =>
                  void runImport()
                }
              >
                {importLoading
                  ? 'Importálás…'
                  : 'Importálás'}
              </button>
            </div>
          </div>

          {importMessage && (
            <div className="campaign-preparation-message">
              {importMessage}
            </div>
          )}

          {importResult?.importRunId && (
            <div className="campaign-preparation-message">
              Import run:{' '}
              {importResult.importRunId}
            </div>
          )}

          <div className="campaign-offers-heading">
            <div>
              <h4>
                {showAllPreviewRows
                  ? `Katalógus előnézet – összesen ${preview.data.length} sor`
                  : `Katalógus előnézet – első ${Math.min(PREVIEW_VISIBLE_ROWS, preview.data.length)} sor`}
              </h4>
            </div>
          </div>

          <div
            className={
              showAllPreviewRows
                ? 'campaign-offers-table-wrapper catalog-preview-scroll'
                : 'campaign-offers-table-wrapper'
            }
          >
            <table className="campaign-offers-table">
              <thead>
                <tr>
                  <th>Identifier</th>
                  <th>SKU</th>
                  <th>EAN</th>
                  <th>Név</th>
                  <th>Ár</th>
                  <th>Szállítás</th>
                  <th>Match státusz</th>
                </tr>
              </thead>

              <tbody>
                {visiblePreviewRows.map(
                  (row) => (
                    <tr
                      key={row.rowNumber}
                    >
                      <td>
                        {row.identifier ??
                          '–'}
                      </td>

                      <td>
                        {row.normalizedSku ??
                          '–'}
                      </td>

                      <td>
                        {row.eanCode ?? '–'}
                      </td>

                      <td>
                        {row.name ?? '–'}
                      </td>

                      <td>
                        {row.priceRaw ?? '–'}
                      </td>

                      <td>
                        {row.deliveryTimeRaw ??
                          '–'}
                      </td>

                      <td>
                        {formatMatchStatus(
                          row.matchStatus,
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          {preview.data.length >
            PREVIEW_VISIBLE_ROWS && (
            <div className="catalog-preview-toggle">
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setShowAllPreviewRows(
                    (current) => !current,
                  )
                }
              >
                {showAllPreviewRows
                  ? 'Kevesebb sor'
                  : 'További sorok megjelenítése'}
              </button>
            </div>
          )}
        </div>
      )}

      {importResult?.status === 'ok' && (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-heading">
            <div>
              <p className="section-label">
                3. LÉPÉS
              </p>

            <h4>Terméktörzs-bővítés</h4>

            <p>
              A katalógus import után itt
              vehetők fel az új termékek
              a Hub terméktörzsébe.
            </p>
          </div>

          <div className="campaign-selection-count">
            {promotionSummary
              ? `${promotionSummary.safeNewProducts} biztonságosan felvehető`
              : '–'}
          </div>
        </div>

        <div className="campaign-submit-bar">
          <span>
            Promóciós állapot
          </span>

          <div className="campaign-submit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={promotionLoading}
              onClick={() =>
                void loadPromotion()
              }
            >
              {promotionLoading
                ? 'Frissítés…'
                : 'Frissítés'}
            </button>

            <button
              type="button"
              className={
                canPromote
                  ? 'campaign-primary-button'
                  : 'secondary-button'
              }
              disabled={!canPromote}
              onClick={() =>
                void runPromote()
              }
            >
              {promoting
                ? 'Felvétel…'
                : 'Új termékek felvétele a Hubba'}
            </button>
          </div>
        </div>

        {promotionMessage && (
          <div className="campaign-preparation-message">
            {promotionMessage}
          </div>
        )}

        {promotionSummary && (
          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table">
              <tbody>
                <tr>
                  <td>
                    Nem egyező katalógustétel
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.unmatchedCatalogItems
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Készletben lefedett
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.inventoryCovered
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Biztonságosan felvehető
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.safeNewProducts
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>Meglévő SKU</td>
                  <td>
                    <strong>
                      {
                        promotionSummary.existingSku
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>EAN-konfliktus</td>
                  <td>
                    <strong>
                      {
                        promotionSummary.eanConflicts
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    SKU/EAN-konfliktus
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.skuEanConflicts
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Duplikált katalógus-SKU
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.duplicateCatalogSku
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Duplikált katalógus-EAN
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.duplicateCatalogEan
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Hiányzó kötelező adat
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.missingRequiredData
                      }
                    </strong>
                  </td>
                </tr>

                <tr>
                  <td>
                    Készletből hiányzik
                  </td>
                  <td>
                    <strong>
                      {
                        promotionSummary.inventoryMissing
                      }
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {promotionSummary &&
          promotionSummary.safeNewProducts ===
            0 && (
            <div className="campaign-preparation-message">
              Jelenleg nincs új,
              biztonságosan felvehető
              termék.
            </div>
          )}

        {promotionSummary &&
          promotionBlockers > 0 && (
            <div className="campaign-submit-warning">
              A promóció le van tiltva,
              mert {promotionBlockers}{' '}
              tétel konfliktusos vagy
              hibás. Részleteket a fenti
              összesítés mutat.
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default ArukeresoCatalogPage
