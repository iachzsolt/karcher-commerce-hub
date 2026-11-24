/**
 * Read-only classification of Allegro publication command task lookups.
 *
 * The publication operation only ever learns PENDING / SUCCESS / FAILED.
 * Everything that is not a definite task result (404, 429, 401/403, 5xx,
 * timeouts, transport errors) stays PENDING: the command is neither closed
 * nor resent. The finer classification is kept for diagnostics only.
 */
import { sanitizeAllegroErrorList } from './allegro-remote-verification.js'
import type {
  PublicationAction,
  PublicationCommand,
  PublicationCommandDiagnostic,
  PublicationTaskState,
} from './allegro-publication-operation.js'

export type PublicationTaskLookup = {
  state: 'PENDING' | 'SUCCESS' | 'FAILED'
  taskState: PublicationTaskState
  upstreamStatus: number | null
  allegroErrors: PublicationCommandDiagnostic['allegroErrors']
}

function isTimeout(error: unknown) {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : null
  return name === 'TimeoutError' || name === 'AbortError'
}

export async function lookupPublicationTask(
  fetchTask: () => Promise<Response>,
  offerId: string,
): Promise<PublicationTaskLookup> {
  let response: Response
  try {
    response = await fetchTask()
  } catch (error) {
    return { state: 'PENDING', taskState: isTimeout(error) ? 'TIMEOUT' : 'REQUEST_FAILED', upstreamStatus: null, allegroErrors: [] }
  }

  const errorsOf = async () => {
    try {
      return sanitizeAllegroErrorList((await response.json() as { errors?: unknown })?.errors)
    } catch {
      return []
    }
  }

  if (!response.ok) {
    const taskState: PublicationTaskState =
      response.status === 404 ? 'TASK_NOT_FOUND'
        : response.status === 429 ? 'RATE_LIMITED'
          : response.status === 401 || response.status === 403 ? 'AUTH_FAILED'
            : 'UPSTREAM_ERROR'
    return { state: 'PENDING', taskState, upstreamStatus: response.status, allegroErrors: await errorsOf() }
  }

  try {
    const data = await response.json() as { tasks?: Array<{ offer?: { id?: string }; status?: string; errors?: unknown }> }
    const task = data.tasks?.find(item => item.offer?.id === offerId)
    if (task?.status === 'SUCCESS') return { state: 'SUCCESS', taskState: 'TASK_PENDING', upstreamStatus: response.status, allegroErrors: [] }
    if (task?.status === 'FAIL' || task?.status === 'FAILED') {
      return { state: 'FAILED', taskState: 'TASK_PENDING', upstreamStatus: response.status, allegroErrors: sanitizeAllegroErrorList(task.errors) }
    }
    return { state: 'PENDING', taskState: 'TASK_PENDING', upstreamStatus: response.status, allegroErrors: [] }
  } catch (error) {
    return { state: 'PENDING', taskState: isTimeout(error) ? 'TIMEOUT' : 'UPSTREAM_ERROR', upstreamStatus: response.status, allegroErrors: [] }
  }
}

const HINTS: Record<PublicationTaskState, string> = {
  TASK_NOT_FOUND:
    'Allegro has no task for this command id. It may never have been accepted. The command is kept unresolved and is not resent; verify the offer and the command manually before any action.',
  TASK_PENDING: 'Allegro is still processing the command. It will be checked again on the next run.',
  RATE_LIMITED: 'Allegro rate limit while reading the task. It will be checked again later.',
  AUTH_FAILED: 'Allegro rejected the session while reading the task. Check the Allegro connection.',
  UPSTREAM_ERROR: 'Transient Allegro error while reading the task. It will be checked again later.',
  TIMEOUT: 'The task lookup timed out. It will be checked again later.',
  REQUEST_FAILED: 'The task lookup failed before reaching Allegro. It will be checked again later.',
  DISPATCH_AMBIGUOUS:
    'The command result was not received. It is kept unresolved and is not resent; it is read back on the next run.',
}

export function publicationCommandDiagnostic(input: {
  command: PublicationCommand
  lastLookup: PublicationTaskLookup | null
  ambiguousDispatch: boolean
  attemptedAt: Date | null
  now?: Date
}): PublicationCommandDiagnostic {
  const taskState: PublicationTaskState =
    input.lastLookup && input.lastLookup.taskState !== 'TASK_PENDING'
      ? input.lastLookup.taskState
      : input.ambiguousDispatch ? 'DISPATCH_AMBIGUOUS' : input.lastLookup?.taskState ?? 'TASK_PENDING'
  const now = (input.now ?? new Date()).getTime()
  return {
    commandId: input.command.commandId,
    intentId: input.command.intentId ?? null,
    action: input.command.action as PublicationAction,
    taskState,
    upstreamStatus: input.lastLookup?.upstreamStatus ?? null,
    commandAgeMs: input.attemptedAt ? Math.max(0, now - input.attemptedAt.getTime()) : null,
    allegroErrors: input.lastLookup?.allegroErrors ?? [],
    action_hint: HINTS[taskState],
  }
}
