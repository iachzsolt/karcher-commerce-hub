export type ManualInventoryAdvance = {
  done?: boolean
  nextAdvanceAt?: number | null
  stopReason?: string | null
  rateLimited?: boolean
  mutationAttempts?: number
}

export type ManualInventoryRun = {
  runId: string
  status: string
  rowsImported?: number
  changedItemCount?: number
  error?: string | null
  finishedAt?: string | null
  /**
   * Persisted diagnostics plus the durable refresh cursor. The cursor's
   * `nextAdvanceAt` is the only pacing signal the UI is allowed to read.
   */
  automationDetailsJson?: string | null
  advance?: ManualInventoryAdvance | null
}

export type ManualInventoryAdvanceOutcome =
  | { kind: 'ADVANCED'; run: ManualInventoryRun }
  | {
      kind: 'COOLDOWN'
      run: ManualInventoryRun | null
      nextAdvanceAt: number | null
      message: string
    }
  /** Network error, 5xx or unreadable body: the slice may have run. */
  | { kind: 'UNCERTAIN'; status: number | null; message: string }
  | { kind: 'NO_ACTIVE_RUN' }

export type ManualInventoryRequest = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<Response>

/**
 * Statuses that prove the backend rejected the start request before a run was
 * created, so releasing the client run id cannot hide an in-flight execution.
 *
 * Everything else is UNCERTAIN. Production showed a start `POST` answering
 * `503` while the same run id existed in the database, stayed `RUNNING` and
 * kept processing batches, so `5xx` must never release the id.
 */
export const DEFINITIVE_START_REJECTION_STATUSES = [
  400, 403, 404, 409,
] as const

export class ManualInventoryRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'ManualInventoryRefreshError'
  }
}

/**
 * Only RUNNING is non-terminal. This mirrors the backend `/advance` guard
 * (`run.status !== 'RUNNING'` is already finished) so COMPLETED, FAILED,
 * IMPORT_ONLY, INTERRUPTED and any future terminal status all stop the loop.
 */
export function isTerminalInventoryRun(
  run: { status?: string | null } | null | undefined,
): boolean {
  return Boolean(run) && run?.status !== 'RUNNING'
}

/**
 * Next allowed advance instant, from the advance response when present and
 * otherwise from the persisted cursor. Tolerant: a corrupt payload simply
 * means "no cooldown known" and the caller falls back to normal polling.
 */
export function readInventoryRunNextAdvanceAt(
  run: ManualInventoryRun | null | undefined,
): number | null {
  const fromAdvance = run?.advance?.nextAdvanceAt

  if (typeof fromAdvance === 'number' && Number.isFinite(fromAdvance)) {
    return fromAdvance
  }

  const serialized = run?.automationDetailsJson

  if (typeof serialized !== 'string' || !serialized.trim()) return null

  try {
    const parsed = JSON.parse(serialized) as {
      cursor?: { nextAdvanceAt?: unknown }
    }
    const fromCursor = parsed?.cursor?.nextAdvanceAt

    return typeof fromCursor === 'number' && Number.isFinite(fromCursor)
      ? fromCursor
      : null
  } catch {
    return null
  }
}

/**
 * Single flight, no automatic POST retries.
 *
 * `start` is called exactly once per run and never resent. `advance` is
 * single-flight by construction: two concurrent callers share one request, so
 * a duplicated loop tick can never send two slices. Unknown advance outcomes
 * are reported as UNCERTAIN and keep the run id; only a terminal run observed
 * through the targeted GET releases it.
 */
export function createManualInventoryRefreshAction(
  baseUrl: string,
  request: ManualInventoryRequest = fetch,
  newId = () => crypto.randomUUID(),
) {
  let active: { connectionId: string; runId: string } | null = null
  let advanceInFlight: Promise<ManualInventoryAdvanceOutcome> | null = null

  const accept = (run: ManualInventoryRun) => {
    if (isTerminalInventoryRun(run)) active = null
    return run
  }

  const advanceUrl = (target: { connectionId: string; runId: string }) =>
    `${baseUrl}/data-connections/${target.connectionId}/full-inventory-refresh/${target.runId}/advance`

  const performAdvance = async (
    target: { connectionId: string; runId: string },
  ): Promise<ManualInventoryAdvanceOutcome> => {
    let response: Response

    try {
      response = await request(advanceUrl(target), { method: 'POST' })
    } catch (error) {
      /*
       * The request may have reached the backend and run a slice. Never
       * resend it: the caller must observe the persisted run first.
       */
      return {
        kind: 'UNCERTAIN',
        status: null,
        message: `${error instanceof Error ? error.message : 'A szelet kérése nem jutott el a szerverig.'} Előbb a futás állapotát ellenőrizzük.`,
      }
    }

    const body = (await response.json().catch(() => null)) as
      | { run?: ManualInventoryRun | null; message?: string }
      | null

    if (response.status === 409) {
      /*
       * Cooldown or a run that is no longer running. Not an error: the
       * persisted state decides what happens next.
       */
      return {
        kind: 'COOLDOWN',
        run: body?.run ? accept(body.run) : null,
        nextAdvanceAt: readInventoryRunNextAdvanceAt(body?.run ?? null),
        message:
          body?.message ??
          'A futás még nem léphet tovább; a következő szelet később indul.',
      }
    }

    if (response.ok && body?.run) {
      return { kind: 'ADVANCED', run: accept(body.run) }
    }

    return {
      kind: 'UNCERTAIN',
      status: response.status,
      message:
        body?.message ??
        `A szelet eredménye nem ismert (${response.status}).`,
    }
  }

  return {
    get active() {
      return active
    },

    async start(connectionId: string, started: (runId: string) => void) {
      if (active) return null

      const runId = newId()
      active = { connectionId, runId }
      started(runId)

      let response: Response

      try {
        response = await request(
          `${baseUrl}/data-connections/${connectionId}/full-inventory-refresh`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, runId }),
          },
        )
      } catch (error) {
        /*
         * Transport failure: the request may have reached the backend and
         * created the run. Keep the id, never resend the POST, and let the
         * targeted GET decide.
         */
        throw new ManualInventoryRefreshError(
          `${error instanceof Error ? error.message : 'A kérés eredménye nem ismert.'} Ne indíts új futást; előbb ellenőrizzük a futás állapotát.`,
          null,
        )
      }

      if (!response.ok) {
        /*
         * Only a definitive rejection proves no run was created. A 5xx,
         * gateway timeout or unreadable body is UNCERTAIN: the id stays so
         * the targeted GET can observe the same run.
         */
        if (
          (DEFINITIVE_START_REJECTION_STATUSES as readonly number[]).includes(
            response.status,
          )
        ) {
          active = null
        }

        const body = (await response.json().catch(() => null)) as {
          message?: string
        } | null

        throw new ManualInventoryRefreshError(
          body?.message ?? `A kérés eredménye nem ismert (${response.status}).`,
          response.status,
        )
      }

      const body = (await response.json().catch(() => null)) as {
        run?: ManualInventoryRun | null
      } | null

      if (!body?.run) {
        /*
         * A 2xx with an unreadable or unexpected body says nothing about
         * whether the run was created, so keep the id and observe.
         */
        throw new ManualInventoryRefreshError(
          'A kérés eredménye nem ismert. Ne indíts új futást; előbb ellenőrizzük a futás állapotát.',
          response.status,
        )
      }

      return accept(body.run)
    },

    async observe() {
      const target = active
      if (!target) return null

      let response: Response

      try {
        response = await request(
          `${baseUrl}/data-connections/${target.connectionId}/full-inventory-refresh/${target.runId}`,
        )
      } catch (error) {
        throw new ManualInventoryRefreshError(
          `${error instanceof Error ? error.message : 'A futás állapota nem ellenőrizhető.'} Ne indíts új futást; előbb ellenőrizd az előzményeket.`,
          null,
        )
      }

      if (response.status === 404) {
        /*
         * The run row genuinely does not exist. Holding the id would lock
         * the UI forever, and no remote work can still be attributed to it.
         */
        active = null
        throw new ManualInventoryRefreshError(
          'A futás nem található. Indíthatsz új futást.',
          404,
        )
      }

      if (!response.ok) {
        /*
         * Transient (503, 500, ...): keep the run id. The persisted run is
         * the source of truth and must be observed again later.
         */
        throw new ManualInventoryRefreshError(
          'A futás állapota nem ellenőrizhető. Ne indíts új futást; ellenőrizd az előzményeket.',
          response.status,
        )
      }

      const body = (await response.json()) as { run: ManualInventoryRun }
      return accept(body.run)
    },

    /**
     * Run one bounded slice. Only one request can be in flight at a time;
     * concurrent callers receive the same outcome instead of a second write.
     */
    advance(): Promise<ManualInventoryAdvanceOutcome> {
      const target = active
      if (!target) {
        return Promise.resolve<ManualInventoryAdvanceOutcome>({
          kind: 'NO_ACTIVE_RUN',
        })
      }

      if (advanceInFlight) return advanceInFlight

      const pending = performAdvance(target).finally(() => {
        if (advanceInFlight === pending) advanceInFlight = null
      })

      advanceInFlight = pending
      return pending
    },
  }
}
