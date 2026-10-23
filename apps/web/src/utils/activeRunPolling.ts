import { isForegroundVisible } from './polling'

/** One timer and one in-flight read per mounted widget. No catch-up queue. */
export function startActiveRunPolling<T>(options: {
  read: () => Promise<T>
  publish: (value: T) => void
  isActive: (value: T) => boolean
  visibility: () => string
  subscribe: (listener: () => void) => () => void
  schedule: (callback: () => void, delay: number) => number
  cancel: (timer: number) => void
}) {
  let disposed = false
  let inFlight = false
  let active = false
  let visible = isForegroundVisible(options.visibility())
  let timer: number | null = null
  const clear = () => {
    if (timer !== null) options.cancel(timer)
    timer = null
  }
  const schedule = () => {
    clear()
    if (!disposed && visible && active) timer = options.schedule(() => {
      timer = null
      void refresh()
    }, 60_000)
  }
  const refresh = async () => {
    if (disposed || inFlight || !isForegroundVisible(options.visibility())) return
    clear()
    inFlight = true
    try {
      const value = await options.read()
      if (!disposed) {
        active = options.isActive(value)
        options.publish(value)
      }
    } catch { /* Preserve last known state; visibility restore can retry. */ }
    finally { inFlight = false; schedule() }
  }
  const unsubscribe = options.subscribe(() => {
    const next = isForegroundVisible(options.visibility())
    if (visible === next) return
    visible = next
    clear()
    if (visible) void refresh()
  })
  void refresh()
  return () => { disposed = true; clear(); unsubscribe() }
}

export function isActiveRun(status: string | undefined): boolean {
  return status === 'RUNNING' || status === 'PENDING'
}
