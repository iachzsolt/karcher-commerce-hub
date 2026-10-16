/*
 * Background polling gates (network-efficiency only).
 *
 * These helpers decide WHETHER a passive background tick
 * may hit the network. They never change what is fetched,
 * how mismatches are evaluated, or what manual actions do.
 * Hidden tabs must not accumulate deferred runs: a skipped
 * tick is simply dropped, and visibility restore triggers
 * at most one immediate refresh before the normal cadence
 * resumes.
 */

export const HISTORY_BACKGROUND_REFRESH_MS =
  60_000
export const HOME_BACKGROUND_REFRESH_MS =
  60_000

export function isForegroundVisible(
  visibilityState: string | undefined,
): boolean {
  return visibilityState === 'visible'
}

export function shouldHistoryBackgroundTick(input: {
  hasProcessingRows: boolean
  disposed: boolean
  visibilityState: string | undefined
}): boolean {
  return (
    input.hasProcessingRows &&
    !input.disposed &&
    isForegroundVisible(input.visibilityState)
  )
}

export function shouldRefreshOnVisible(input: {
  disposed: boolean
  visibilityState: string | undefined
}): boolean {
  return (
    !input.disposed &&
    isForegroundVisible(input.visibilityState)
  )
}

export function shouldRunHomeBackgroundFreshness(input: {
  visibilityState: string | undefined
  refreshInFlight: boolean
}): boolean {
  return (
    isForegroundVisible(input.visibilityState) &&
    !input.refreshInFlight
  )
}
