/** Config validation is synchronous; primary-session I/O is deferred and awaited. */
export function createRuntimeInitializer(validate: () => void, restore: () => Promise<boolean>) {
  let ready = false
  let inFlight: Promise<void> | null = null
  return () => {
    validate()
    if (ready) return Promise.resolve()
    if (!inFlight) {
      inFlight = Promise.resolve().then(restore).then(restored => { ready = restored }).finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }
}

export function needsPrimaryAllegroSession(path: string): boolean {
  if (path.startsWith('/auth/allegro/notify-')) return false
  return path === '/auth/allegro' || path.startsWith('/auth/allegro/') || path.startsWith('/allegro/')
}
