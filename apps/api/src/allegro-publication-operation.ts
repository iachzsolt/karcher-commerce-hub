import { randomUUID } from 'node:crypto'

export const PUBLICATION_FRESH_MS = 15 * 60 * 1000
export const PUBLICATION_LEASE_MS = 120_000
export type PublicationTarget = { listingId: string; offerId: string; accountId: string }
export type PublicationAction = 'END' | 'ACTIVATE'
export type PublicationSnapshot = PublicationTarget & {
  desiredPublication: string | null
  intentVersion: string
  cachedPublication: string | null
  observedAt: Date | null
  duplicateCount: number
  productActive: boolean
  campaignBlocked: boolean
  freshManualIntent?: boolean
  legacyPublicationPending?: boolean
}
export type PublicationObservation = { status: string; observedAt: Date }
export type PublicationCommand = { commandId: string; action: PublicationAction; status: string }
export type PublicationOutcome = 'FIXED' | 'ALREADY_FIXED' | 'PENDING_TIMEOUT' | 'FAILED' | 'SKIPPED_SAFETY' | 'REMOTE_UNAVAILABLE'
export type PublicationResult = { outcome: PublicationOutcome; reason?: string; commandId?: string; publicationStatus?: string }
export type PublicationAudit = {
  status: string
  action: PublicationAction
  commandId?: string
  reason?: string
  publicationStatus?: string
  observedAt?: string
}
export type PublicationLeaseStore = {
  acquire: (name: string, owner: string) => Promise<boolean>
  renew: (name: string, owner: string) => Promise<boolean>
  release: (name: string, owner: string) => Promise<void>
}
export function publicationLeaseName(target: PublicationTarget) {
  return `allegro-publication:${target.accountId}:${target.listingId}:${target.offerId}`
}

export async function withPublicationLease<T>(store: PublicationLeaseStore, target: PublicationTarget,
  action: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T | null> {
  const name = publicationLeaseName(target)
  const owner = randomUUID()
  if (!await store.acquire(name, owner)) return null
  try {
    return await action(async () => {
      // Renew only a still-live lease owned by this operation. Every bounded
      // external call is preceded by this assertion; an expired holder stops.
      if (!await store.renew(name, owner)) throw new Error('PUBLICATION_LEASE_LOST')
    })
  } finally {
    // Owner-qualified release cannot delete a successor's recovered lease.
    // If DB release fails, expiry is the recovery mechanism.
    await store.release(name, owner).catch(() => {
      console.warn('Publication lease release failed; bounded expiry will recover it.')
    })
  }
}

const inactive = (status: string | null) => status === 'INACTIVE' || status === 'ENDED'
export function publicationMatches(action: PublicationAction, status: string | null) {
  return action === 'END' ? inactive(status) : status === 'ACTIVE'
}
export function publicationObservationIsFresh(observedAt: Date | null, now = new Date()) {
  if (!observedAt) return false
  const age = now.getTime() - observedAt.getTime()
  return age >= 0 && age < PUBLICATION_FRESH_MS
}
export function publicationSafetyReason(target: PublicationTarget, snapshot: PublicationSnapshot | null,
  action: PublicationAction, version: string, strict: boolean) {
  if (!snapshot || snapshot.listingId !== target.listingId || snapshot.offerId !== target.offerId || snapshot.accountId !== target.accountId) return 'MAPPING_OR_SCOPE_CHANGED'
  if (snapshot.desiredPublication !== (action === 'END' ? 'INACTIVE' : 'ACTIVE') || snapshot.intentVersion !== version) return 'DESIRED_INTENT_CHANGED'
  if (strict && !snapshot.productActive) return 'PRODUCT_INACTIVE'
  if (strict && snapshot.duplicateCount !== 1) return 'DUPLICATE_SKU'
  if (strict && snapshot.campaignBlocked) return 'CAMPAIGN_OWNERSHIP'
  if (strict && snapshot.freshManualIntent) return 'FRESH_MANUAL_INTENT'
  return null
}

export type PublicationAdapter = {
  leases: PublicationLeaseStore
  readLocal: () => Promise<PublicationSnapshot | null>
  readRemote: () => Promise<PublicationObservation>
  persistObservation: (observation: PublicationObservation) => Promise<void>
  latestCommand: () => Promise<PublicationCommand | null>
  audit: (event: PublicationAudit) => Promise<void>
  campaignSafe: () => Promise<boolean>
  send: (action: PublicationAction, commandId: string) => Promise<{ accepted: boolean; reason?: string }>
  task: (commandId: string) => Promise<'PENDING' | 'SUCCESS' | 'FAILED'>
  wait: () => Promise<void>
}

/** Only this executor dispatches a publication command. No quantity/price/badge ports exist. */
export async function executePublicationOperation(target: PublicationTarget, adapter: PublicationAdapter,
  options: { action: PublicationAction; intentVersion: string; remediation?: boolean; attempts?: number; now?: Date }): Promise<PublicationResult> {
  const action = options.action
  if (options.remediation && action !== 'END') return { outcome: 'SKIPPED_SAFETY', reason: 'REMEDIATION_END_ONLY' }
  const attempts = Math.min(6, Math.max(1, options.attempts ?? 6))
  let activeCommand: PublicationCommand | null = null
  let dispatchMayHaveStarted = false
  const run = await withPublicationLease<PublicationResult>(adapter.leases, target, async assertOwned => {
    const check = async () => {
      const snapshot = await adapter.readLocal()
      return publicationSafetyReason(target, snapshot, action, options.intentVersion, options.remediation === true) ??
        (snapshot?.legacyPublicationPending && !dispatchMayHaveStarted ? 'LEGACY_PUBLICATION_PENDING' : null)
    }
    const skip = async (reason: string): Promise<PublicationResult> => {
      await adapter.audit({ action, status: 'SKIPPED_SAFETY', reason })
      return { outcome: 'SKIPPED_SAFETY', reason }
    }
    const observe = async () => {
      await assertOwned()
      const observation = await adapter.readRemote()
      await assertOwned()
      const reason = await check()
      if (reason) throw new Error(reason)
      await adapter.persistObservation(observation)
      return observation
    }
    const verify = async (command: PublicationCommand | null): Promise<PublicationResult> => {
      let last: PublicationObservation | null = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt) await adapter.wait()
        const changed = await check()
        if (changed) return skip(changed)
        last = await observe()
        if (publicationMatches(action, last.status) && (!command || command.action === action)) {
          await adapter.audit({ action, status: 'SUCCESS', commandId: command?.commandId,
            publicationStatus: last.status, observedAt: last.observedAt.toISOString() })
          return { outcome: 'FIXED', commandId: command?.commandId, publicationStatus: last.status }
        }
        if (command) {
          await assertOwned()
          const state = await adapter.task(command.commandId)
          if (state === 'FAILED') {
            await adapter.audit({ action: command.action, status: 'FAILED', commandId: command.commandId, reason: 'ALLEGRO_TASK_FAILED' })
            return { outcome: 'FAILED', commandId: command.commandId, reason: 'ALLEGRO_TASK_FAILED' }
          }
          if (state === 'SUCCESS' && command.action !== action) {
            await adapter.audit({ action: command.action, status: 'SUCCESS', commandId: command.commandId, reason: 'PREVIOUS_OPERATION_COMPLETED' })
            return skip('PREVIOUS_OPERATION_COMPLETED_RECHECK_INTENT')
          }
        }
      }
      await adapter.audit({ action: command?.action ?? action, status: 'PENDING', commandId: command?.commandId,
        reason: 'BOUNDED_VERIFICATION_TIMEOUT', publicationStatus: last?.status })
      return { outcome: 'PENDING_TIMEOUT', commandId: command?.commandId, publicationStatus: last?.status }
    }

    try {
      await assertOwned()
      const local = await adapter.readLocal()
      const reason = publicationSafetyReason(target, local, action, options.intentVersion, options.remediation === true)
      if (reason || !local) return skip(reason ?? 'LISTING_MISSING')
      const previous = await adapter.latestCommand()
      if (previous && !['SUCCESS', 'FAILED', 'CANCELLED_BEFORE_SEND'].includes(previous.status)) {
        activeCommand = previous
        dispatchMayHaveStarted = true
        // Even after runtime death/lease expiry, do not create a second command.
        return await verify(previous)
      }
      if (local.legacyPublicationPending) return skip('LEGACY_PUBLICATION_PENDING')
      if (!options.remediation && publicationMatches(action, local.cachedPublication) && publicationObservationIsFresh(local.observedAt, options.now)) {
        await adapter.audit({ action, status: 'CACHED_MATCH', publicationStatus: local.cachedPublication!, observedAt: local.observedAt!.toISOString() })
        return { outcome: 'ALREADY_FIXED', publicationStatus: local.cachedPublication! }
      }
      const observation = await observe()
      if (publicationMatches(action, observation.status)) {
        await adapter.audit({ action, status: 'AUTHORITATIVE_MATCH', publicationStatus: observation.status, observedAt: observation.observedAt.toISOString() })
        return { outcome: 'ALREADY_FIXED', publicationStatus: observation.status }
      }
      if (observation.status === 'ACTIVATING' && action === 'ACTIVATE') return await verify(null)
      if (action === 'END' && observation.status !== 'ACTIVE') return skip('UNEXPECTED_PUBLICATION_STATE')
      if (action === 'ACTIVATE' && !inactive(observation.status)) return skip('UNEXPECTED_PUBLICATION_STATE')
      if (options.remediation && !await adapter.campaignSafe()) return skip('CAMPAIGN_OWNERSHIP')
      if (options.remediation) {
        const prewrite = await observe()
        if (publicationMatches(action, prewrite.status)) {
          await adapter.audit({ action, status: 'AUTHORITATIVE_MATCH', publicationStatus: prewrite.status, observedAt: prewrite.observedAt.toISOString() })
          return { outcome: 'ALREADY_FIXED', publicationStatus: prewrite.status }
        }
        if (prewrite.status !== 'ACTIVE') return skip('UNEXPECTED_PUBLICATION_STATE')
      }
      await assertOwned()
      const changed = await check()
      if (changed) return skip(changed)
      const commandId = randomUUID()
      activeCommand = { commandId, action, status: 'ATTEMPTED' }
      // Persist before dispatch: a crash or network timeout leaves an unresolved
      // command ID for read-only recovery, never a reason for blind resubmission.
      await adapter.audit({ action, status: 'ATTEMPTED', commandId })
      await assertOwned()
      const changedBeforeSend = await check()
      if (changedBeforeSend) {
        await adapter.audit({ action, status: 'CANCELLED_BEFORE_SEND', commandId, reason: changedBeforeSend })
        return skip(changedBeforeSend)
      }
      let sent: { accepted: boolean; reason?: string }
      try {
        dispatchMayHaveStarted = true
        sent = await adapter.send(action, commandId)
      }
      catch {
        await adapter.audit({ action, status: 'PENDING', commandId, reason: 'DISPATCH_RESULT_UNKNOWN' })
        return await verify(activeCommand)
      }
      if (!sent.accepted) {
        await adapter.audit({ action, status: 'FAILED', commandId, reason: sent.reason })
        return { outcome: 'FAILED', commandId, reason: sent.reason }
      }
      await adapter.audit({ action, status: 'PENDING', commandId, reason: 'COMMAND_ACCEPTED' })
      return await verify(activeCommand)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'PUBLICATION_CHECK_FAILED'
      const safety = ['PUBLICATION_LEASE_LOST', 'MAPPING_OR_SCOPE_CHANGED', 'DESIRED_INTENT_CHANGED', 'DUPLICATE_SKU', 'CAMPAIGN_OWNERSHIP', 'PRODUCT_INACTIVE', 'FRESH_MANUAL_INTENT', 'LEGACY_PUBLICATION_PENDING'].includes(reason)
      await adapter.audit({ action: activeCommand?.action ?? action, status: activeCommand ? dispatchMayHaveStarted ? 'PENDING' : 'CANCELLED_BEFORE_SEND' : safety ? 'SKIPPED_SAFETY' : 'REMOTE_UNAVAILABLE',
        commandId: activeCommand?.commandId, reason }).catch(() => undefined)
      return { outcome: safety ? 'SKIPPED_SAFETY' : 'REMOTE_UNAVAILABLE', reason, commandId: activeCommand?.commandId }
    }
  })
  if (run) return run
  await adapter.audit({ action, status: 'SKIPPED_SAFETY', reason: 'PUBLICATION_OPERATION_BUSY' }).catch(() => undefined)
  return { outcome: 'SKIPPED_SAFETY', reason: 'PUBLICATION_OPERATION_BUSY' }
}
