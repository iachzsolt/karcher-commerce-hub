export type OverrideEdit<T> = { value: T; status: 'saving' | 'saved' | 'failed'; error?: string }
export const OVERRIDE_PREVIEW_QUIET_MS = 2000
export const OVERRIDE_PREVIEW_MAX_WAIT_MS = 5000

/** Writes start immediately through the existing endpoint. Only expensive
 * post-save reads are coalesced. No deferred mutation can be lost on navigation.
 */
export function createOverrideEditCoordinator<T>(options: {
  write: (id: string, value: T) => Promise<void>
  refresh: () => Promise<boolean>
  changed: (edits: Record<string, OverrideEdit<T>>) => void
  refreshFailed: () => void
  schedule: (callback: () => void, delay: number) => number
  cancel: (timer: number) => void
  now: () => number
}) {
  let edits: Record<string, OverrideEdit<T>> = {}
  let revision = 0
  let pending = 0
  let disposed = false
  let dirty = false
  let refreshing = false
  let firstDirtyAt: number | null = null
  let timer: number | null = null
  const publish = () => { if (!disposed) options.changed({ ...edits }) }
  const clearTimer = () => { if (timer !== null) options.cancel(timer); timer = null }
  const acceptPreview = (readRevision: number) => {
    if (disposed || pending || readRevision !== revision) return false
    clearTimer()
    dirty = false
    firstDirtyAt = null
    edits = Object.fromEntries(Object.entries(edits).filter(([,edit]) => edit.status !== 'saved'))
    publish()
    return true
  }
  const schedule = () => {
    clearTimer()
    if (disposed || pending || refreshing || !dirty) return
    const elapsed = options.now() - (firstDirtyAt ?? options.now())
    timer = options.schedule(() => { timer = null; void refresh() },
      Math.max(0, Math.min(OVERRIDE_PREVIEW_QUIET_MS, OVERRIDE_PREVIEW_MAX_WAIT_MS - elapsed)))
  }
  const refresh = async () => {
    if (disposed || pending || refreshing || !dirty) return
    refreshing = true
    const readRevision = revision
    let applied = false
    try { applied = await options.refresh() } catch { /* Explicit retry, no read storm. */ }
    refreshing = false
    if (disposed || !dirty) return
    if (readRevision !== revision) { schedule(); return }
    if (applied) acceptPreview(readRevision)
    else options.refreshFailed()
  }
  return {
    get revision() { return revision },
    get pending() { return pending },
    acceptPreview,
    async save(id: string, value: T) {
      if (disposed || edits[id]?.status === 'saving') return
      clearTimer()
      pending++
      revision++
      dirty = true
      firstDirtyAt ??= options.now()
      edits[id] = { value, status: 'saving' }
      publish()
      try {
        await options.write(id, value)
        edits[id] = { value, status: 'saved' }
        dirty = true
        firstDirtyAt ??= options.now()
      } catch (error) {
        edits[id] = { value, status: 'failed', error: error instanceof Error ? error.message : 'A mentés sikertelen.' }
      } finally {
        pending--
        revision++
        publish()
        schedule()
      }
    },
    dispose() { disposed = true; clearTimer() },
  }
}
