export type ManualInventoryRun = {
  runId: string
  status: string
  rowsImported?: number
  changedItemCount?: number
  error?: string | null
  finishedAt?: string | null
}

/** Single flight, no automatic POST retries. Unknown outcomes stay locked until
 * a targeted GET observes a terminal run. The client ID also deduplicates server requests.
 */
export function createManualInventoryRefreshAction(baseUrl: string, request = fetch, newId = () => crypto.randomUUID()) {
  let active: { connectionId: string; runId: string } | null = null
  const accept = (run: ManualInventoryRun) => {
    if (run.finishedAt && run.status !== 'RUNNING') active = null
    return run
  }
  return {
    get active() { return active },
    async start(connectionId: string, started: (runId: string) => void) {
      if (active) return null
      const runId = newId()
      active = { connectionId, runId }
      started(runId)
      const response = await request(`${baseUrl}/data-connections/${connectionId}/full-inventory-refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, runId }),
      })
      if (!response.ok) {
        if ([400, 403, 404, 409, 503].includes(response.status)) active = null
        const body = await response.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message ?? `A kérés eredménye nem ismert (${response.status}).`)
      }
      const body = await response.json() as { run: ManualInventoryRun }
      return accept(body.run)
    },
    async observe() {
      if (!active) return null
      const response = await request(`${baseUrl}/data-connections/${active.connectionId}/full-inventory-refresh/${active.runId}`)
      if (!response.ok) throw new Error('A futés llapota nem ellenőrizhető. Ne indts új futést; ellenőrizd az előzményeket.')
      const body = await response.json() as { run: ManualInventoryRun }
      return accept(body.run)
    },
  }
}
