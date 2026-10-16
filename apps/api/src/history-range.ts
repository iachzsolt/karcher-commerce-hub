/* Optional ?since=<ISO timestamp> for lightweight
 * background polling: narrows any history listing to
 * rows created or finished at/after the instant, so a
 * 60-second tick transfers only active and recently
 * completed rows instead of the full window. Overlap
 * duplicates are expected; callers dedupe by row id.
 * The normal full-window load is unchanged when since
 * is absent. */
export function parseHistorySinceParam(
  value: string | undefined,
):
  | { ok: true; since: Date | null }
  | { ok: false; message: string } {
  if (!value) {
    return { ok: true, since: null }
  }

  const parsed = Date.parse(value)

  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      message: 'since must be an ISO timestamp',
    }
  }

  return { ok: true, since: new Date(parsed) }
}
