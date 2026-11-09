import {
  isTerminalInventoryRun,
  readInventoryRunNextAdvanceAt,
  type ManualInventoryAdvanceOutcome,
  type ManualInventoryRun,
} from './manualInventoryRefresh'

/** Active, user-initiated run: fast enough to feel live, still polite. */
export const INVENTORY_REFRESH_POLL_INTERVAL_MS = 3_000
/** A 429 cooldown can be a minute; wait at most this long per step. */
export const INVENTORY_REFRESH_MAX_COOLDOWN_WAIT_MS = 60_000
/** After this many failed observations stop polling but keep the run locked. */
export const INVENTORY_REFRESH_MAX_OBSERVE_FAILURES = 5

export type InventoryRefreshLoopClient = {
  readonly active: { connectionId: string; runId: string } | null
  observe: () => Promise<ManualInventoryRun | null>
  advance: () => Promise<ManualInventoryAdvanceOutcome>
}

/**
 * Drives the sliced manual refresh:
 *
 *   observe -> (cooldown?) -> advance -> observe -> ...
 *
 * Invariants:
 *  - the targeted GET is the source of truth; the loop never invents state;
 *  - an uncertain advance always observes before it may advance again;
 *  - the persisted cooldown is respected instead of firing a doomed advance;
 *  - the loop stops only on a terminal run, on a lost run id, or on repeated
 *    observation failures (which keep the run locked rather than forgetting it).
 */
export function createInventoryRefreshLoop(options: {
  client: InventoryRefreshLoopClient
  onRun: (run: ManualInventoryRun) => void
  onError: (message: string) => void
  onNotice?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  maxCooldownWaitMs?: number
  maxObserveFailures?: number
}) {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))
  const now = options.now ?? Date.now
  const pollIntervalMs =
    options.pollIntervalMs ?? INVENTORY_REFRESH_POLL_INTERVAL_MS
  const maxCooldownWaitMs =
    options.maxCooldownWaitMs ?? INVENTORY_REFRESH_MAX_COOLDOWN_WAIT_MS
  const maxObserveFailures =
    options.maxObserveFailures ?? INVENTORY_REFRESH_MAX_OBSERVE_FAILURES

  let disposed = false
  let running = false

  /**
   * Milliseconds to wait before the next slice. No cooldown means the
   * cursor allows advancing immediately; only a known future instant waits.
   */
  const cooldownWait = (nextAdvanceAt: number | null) => {
    if (nextAdvanceAt === null) return 0

    const remaining = nextAdvanceAt - now()

    if (!Number.isFinite(remaining) || remaining <= 0) return 0

    return Math.min(remaining, maxCooldownWaitMs)
  }

  const run = async () => {
    if (running || disposed) return

    running = true
    let observeFailures = 0

    try {
      while (!disposed) {
        let waitMs = 0

        try {
          const observed = await options.client.observe()
          if (disposed) return
          // No active run id (terminal already observed) -> nothing to drive.
          if (!observed) return

          options.onRun(observed)
          if (isTerminalInventoryRun(observed)) return

          observeFailures = 0

          /*
           * Pacing lives in the durable cursor. Waiting here avoids an
           * advance that the backend would only reject.
           */
          const waitForSlice = cooldownWait(
            readInventoryRunNextAdvanceAt(observed),
          )

          if (waitForSlice > 0) {
            await sleep(waitForSlice)
            continue
          }

          const outcome = await options.client.advance()
          if (disposed) return

          if (outcome.kind === 'ADVANCED') {
            options.onRun(outcome.run)
            if (isTerminalInventoryRun(outcome.run)) return
            // Observe again immediately: the GET is the source of truth.
            waitMs = 0
          } else if (outcome.kind === 'COOLDOWN') {
            if (outcome.run) options.onRun(outcome.run)
            options.onNotice?.(outcome.message)
            const waitForCooldown = cooldownWait(outcome.nextAdvanceAt)
            waitMs = waitForCooldown > 0 ? waitForCooldown : pollIntervalMs
          } else if (outcome.kind === 'NO_ACTIVE_RUN') {
            return
          } else {
            /*
             * Uncertain advance (network error, 5xx, unknown body). The
             * slice may have executed, so observe the persisted run before
             * anything else and never resend the same slice blindly.
             */
            options.onError(outcome.message)
            waitMs = pollIntervalMs
          }
        } catch (error) {
          if (disposed) return

          observeFailures += 1
          options.onError(
            error instanceof Error
              ? error.message
              : 'A futás állapota nem ellenőrizhető.',
          )

          // A 404 cleared the run id: there is nothing left to drive.
          if (options.client.active === null) return
          if (observeFailures >= maxObserveFailures) return

          waitMs = pollIntervalMs
        }

        if (waitMs > 0) await sleep(waitMs)
      }
    } finally {
      running = false
    }
  }

  return {
    get running() {
      return running
    },
    start() {
      void run()
    },
    stop() {
      disposed = true
    },
  }
}
