import { Hono } from 'hono'
import { getCommerceHubUser } from './access-auth.js'

export class InventoryRefreshError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message) }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createInventoryRefreshApi(deps: {
  run: (connectionId: string, runId: string) => Promise<unknown>
  getRun: (connectionId: string, runId: string) => Promise<unknown | null>
}) {
  const api = new Hono()
  api.post('/:connectionId/full-inventory-refresh', async context => {
    if (getCommerceHubUser(context)?.role !== 'ADMIN') return context.json({ message: 'Administrator access required' }, 403)
    const connectionId = context.req.param('connectionId')
    const body = await context.req.json().catch(() => null)
    if (!uuid.test(connectionId) || body?.confirm !== true || typeof body?.runId !== 'string' || !uuid.test(body.runId)) {
      return context.json({ message: 'Valid connectionId, runId and confirm=true are required' }, 400)
    }
    try {
      const run = await deps.run(connectionId, body.runId)
      return context.json({ status: 'ok', run })
    } catch (error) {
      return context.json({ status: 'error', runId: body.runId,
        message: error instanceof Error ? error.message : 'Inventory refresh failed; check this run before any retry.' },
      error instanceof InventoryRefreshError ? error.status : 500)
    }
  })
  api.get('/:connectionId/full-inventory-refresh/:runId', async context => {
    if (!getCommerceHubUser(context)) return context.json({ message: 'Authentication required' }, 401)
    const { connectionId, runId } = context.req.param()
    if (!uuid.test(connectionId) || !uuid.test(runId)) return context.json({ message: 'Invalid identifier' }, 400)
    const run = await deps.getRun(connectionId, runId)
    return run ? context.json({ status: 'ok', run }) : context.json({ message: 'Run not found' }, 404)
  })
  return api
}
