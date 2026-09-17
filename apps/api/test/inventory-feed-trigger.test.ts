import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createKeyedSerialExecutor,
  hasFeedSourceRevisionChanged,
  resolveFeedFreshness,
  shouldDeduplicateFeedGeneration,
} from '../src/arukereso.ts'
import {
  runPostInventoryImportFeedHook,
  shouldRequestInventoryFeedGeneration,
} from '../src/data-connections.ts'

void describe('inventory feed regeneration', () => {
  void it('requests exactly one generation for changed inventory', async () => {
    const triggers: string[] = []

    await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 4 },
      async (triggerType) => {
        triggers.push(triggerType)
        return { status: 'ok' }
      },
      true,
    )

    assert.deepEqual(triggers, ['INVENTORY_SYNC'])
  })

  void it('does not generate for NO_CHANGE', async () => {
    let calls = 0

    await runPostInventoryImportFeedHook(
      { status: 'NO_CHANGE', changedItemCount: 8 },
      async () => {
        calls += 1
      },
      true,
    )

    assert.equal(calls, 0)
  })

  void it('does not generate when changedItemCount is zero', () => {
    assert.equal(
      shouldRequestInventoryFeedGeneration({
        status: 'SUCCESS',
        changedItemCount: 0,
      }),
      false,
    )
  })

  void it('respects the automatic feed generation switch', async () => {
    let calls = 0

    const result = await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 1 },
      async () => {
        calls += 1
      },
      false,
    )

    assert.equal(calls, 0)
    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'AUTOMATIC_GENERATION_DISABLED',
    })
  })

  void it('uses the same hook for manual and scheduled callers', async () => {
    const triggers: string[] = []
    const request = async (triggerType: 'INVENTORY_SYNC') => {
      triggers.push(triggerType)
    }

    await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 1 },
      request,
      true,
    )
    await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 2 },
      request,
      true,
    )

    assert.deepEqual(triggers, [
      'INVENTORY_SYNC',
      'INVENTORY_SYNC',
    ])
  })

  void it('persists inventory requests with INVENTORY_SYNC semantics', async () => {
    let trigger: string | null = null

    await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 1 },
      async (triggerType) => {
        trigger = triggerType
      },
      true,
    )

    assert.equal(trigger, 'INVENTORY_SYNC')
  })

  void it('isolates feed failure from inventory success', async (context) => {
    context.mock.method(console, 'error', () => undefined)

    const result = await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 1 },
      async () => {
        throw new Error('generation failed')
      },
      true,
    )

    assert.deepEqual(result, {
      status: 'error',
      message: 'generation failed',
    })
  })

  void it('leaves the previous public run unchanged after failure', async (context) => {
    context.mock.method(console, 'error', () => undefined)
    const publicRunId = 'completed-run'

    await runPostInventoryImportFeedHook(
      { status: 'SUCCESS', changedItemCount: 1 },
      async () => {
        throw new Error('generation failed')
      },
      true,
    )

    assert.equal(publicRunId, 'completed-run')
  })

  void it('serializes overlapping generation for one channel', async () => {
    const runSerial = createKeyedSerialExecutor()
    const events: string[] = []
    let releaseFirst = () => undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = runSerial('channel-a', async () => {
      events.push('first-start')
      await firstGate
      events.push('first-end')
    })
    const second = runSerial('channel-a', async () => {
      events.push('second-start')
    })

    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    assert.deepEqual(events, ['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(events, [
      'first-start',
      'first-end',
      'second-start',
    ])
  })

  void it('deduplicates identical automatic source revisions', () => {
    assert.equal(
      shouldDeduplicateFeedGeneration({
        triggerType: 'INVENTORY_SYNC',
        currentSourceRevision: 'revision-a',
        completedSourceRevision: 'revision-a',
      }),
      true,
    )
    assert.equal(
      shouldDeduplicateFeedGeneration({
        triggerType: 'INVENTORY_SYNC',
        currentSourceRevision: 'revision-b',
        completedSourceRevision: 'revision-a',
      }),
      false,
    )
  })

  void it('rejects a superseded source revision before completion', () => {
    assert.equal(
      hasFeedSourceRevisionChanged('revision-a', {
        fingerprint: 'revision-b',
        inventoryImportRunning: false,
      }),
      true,
    )
  })
})

void describe('feed freshness diagnostics', () => {
  const base = {
    feedFinishedAt: '2026-09-17T09:22:17.107Z',
    feedSourceRevisionFingerprint: 'source-a',
    feedInventoryFingerprint: 'inventory-a',
    feedPricingFingerprint: 'pricing-a',
    currentSourceRevisionFingerprint: 'source-a',
    currentInventoryFingerprint: 'inventory-a',
    currentPricingFingerprint: 'pricing-a',
    inventoryUpdatedAt: '2026-09-17T10:00:00.000Z',
    pricingUpdatedAt: '2026-09-17T09:22:14.702Z',
  }

  void it('detects inventory newer than the feed', () => {
    const result = resolveFeedFreshness({
      ...base,
      currentInventoryFingerprint: 'inventory-b',
    })

    assert.equal(result.inventoryStale, true)
    assert.equal(result.feedCurrent, false)
  })

  void it('detects pricing newer than the feed', () => {
    const result = resolveFeedFreshness({
      ...base,
      currentPricingFingerprint: 'pricing-b',
    })

    assert.equal(result.pricingStale, true)
    assert.equal(result.feedCurrent, false)
  })

  void it('reports current when both revisions match', () => {
    const result = resolveFeedFreshness(base)

    assert.equal(result.inventoryStale, false)
    assert.equal(result.pricingStale, false)
    assert.equal(result.feedCurrent, true)
  })

  void it('reports the feed stale when another source revision changes', () => {
    const result = resolveFeedFreshness({
      ...base,
      currentSourceRevisionFingerprint: 'source-b',
    })

    assert.equal(result.sourceRevisionStale, true)
    assert.equal(result.feedCurrent, false)
  })
})
