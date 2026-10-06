export type BulkPhase = 'write' | 'check'

export type BulkProgress = {
  done: number
  total: number
  phase: BulkPhase
}

export function chunkIds(
  ids: string[],
  size: number,
): string[][] {
  const chunks: string[][] = []

  for (
    let offset = 0;
    offset < ids.length;
    offset += size
  ) {
    chunks.push(ids.slice(offset, offset + size))
  }

  return chunks
}

export function formatBulkProgress(
  progress: BulkProgress,
): string {
  if (progress.phase === 'check') {
    return 'Allegro állapotok ellenőrzése…'
  }

  return `Szinkronizálás folyamatban… ${progress.done} / ${progress.total}`
}

/**
 * Background freshness may only touch listings that no
 * explicit bulk operation currently owns. Unrelated
 * listings stay refreshable while a bulk run owns its
 * own target set.
 */
export function isBackgroundRefreshAllowed(
  id: string,
  ownedIds: ReadonlySet<string>,
): boolean {
  return !ownedIds.has(id)
}

export type BulkFinishInput = {
  succeeded: number
  skipped: number
  failed: number
  pending: number
  errors: string[]
  refreshWarning: string
  campaignBlocked: boolean
  saved: boolean
}

export function buildBulkFinishMessage(
  input: BulkFinishInput,
): string {
  const savedPrefix = input.saved ? 'Mentve. ' : ''
  const errorDetails =
    input.errors.length > 0
      ? `

Hibák:
${input.errors.slice(0, 5).join('\n')}${
          input.errors.length > 5
            ? `\n+${input.errors.length - 5} további hiba`
            : ''
        }`
      : ''

  if (input.failed > 0) {
    return input.saved
      ? `Mentve, de az Allegro szinkronizálás sikertelen.${errorDetails}${input.refreshWarning}`
      : `Szinkronizálás befejezve. ${input.succeeded} sikeres, ${input.failed} sikertelen.${errorDetails}${input.refreshWarning}`
  }

  if (input.campaignBlocked) {
    return `Mentve, de aktív kampány miatt az ár nem módosítható az Allegro-n.${errorDetails}${input.refreshWarning}`
  }

  if (input.pending > 0) {
    return `${savedPrefix}Szinkronizálás befejezve. ${input.succeeded} ajánlat frissült, ${input.pending} Allegro-frissítés még folyamatban.${input.refreshWarning}`
  }

  if (input.refreshWarning) {
    return input.saved
      ? `Szinkronizálva, de eltérés maradt.${input.refreshWarning}`
      : `Szinkronizálás befejezve, de eltérés maradt.${input.refreshWarning}`
  }

  if (input.succeeded === 0) {
    return input.saved
      ? 'Mentve, de nem szinkronizálható: nincs végrehajtható módosítás.'
      : 'Szinkronizálás befejezve: nincs végrehajtható módosítás.'
  }

  return input.saved
    ? 'Mentve és szinkronizálva.'
    : `Szinkronizálás befejezve. ${input.succeeded} sikeres.`
}
