import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { campaignRejection, reconciledBadgeStatus, refreshCampaignListingPublication } from '../src/allegro-campaign-reconciliation.js'
import { isAlreadyFinishedAllegroCampaignResponse } from '../src/allegro-auth.js'

test('only Allegro 422 BB42 errors mean the campaign is already finished', () => {
  const bb42 = { errors: [{ code: 'BB42', message: 'Campaign already finished' }] }
  assert.equal(isAlreadyFinishedAllegroCampaignResponse(422, bb42), true)
  assert.equal(isAlreadyFinishedAllegroCampaignResponse(422, { errors: [{ code: 'OTHER' }] }), false)
  assert.equal(isAlreadyFinishedAllegroCampaignResponse(400, bb42), false)
  assert.equal(isAlreadyFinishedAllegroCampaignResponse(422, { code: 'BB42' }), false)
})

test('known terminal applications follow authoritative badges without reopening on missing/unknown evidence', () => {
  for (const status of ['WAITING_FOR_PUBLICATION', 'FINISHED', 'ACTIVE', 'IN_VERIFICATION', 'DECLINED']) {
    assert.equal(reconciledBadgeStatus('FINISHED', status), status)
  }
  assert.equal(reconciledBadgeStatus('FINISHED', undefined), 'FINISHED')
  assert.equal(reconciledBadgeStatus('FINISHED', 'UNRECOGNIZED'), 'FINISHED')
})

test('remote rejection details survive reconciliation', () => {
  const reasons = [{ code: 'BA104', message: 'Campaign conditions not met' }]
  assert.equal(reconciledBadgeStatus('FINISHED', 'DECLINED'), 'DECLINED')
  assert.deepEqual(JSON.parse(campaignRejection('DECLINED', reasons)!), reasons)
  assert.ok(campaignRejection('DECLINED', []))
  assert.equal(campaignRejection('WAITING_FOR_PUBLICATION', []), null)
})

for (const sku of ['1.629-731.0', '1.628-018.0', '1.081-533.0', '1.513-500.0', '1.198-353.0', '1.064-915.0']) {
  test(`${sku}: reconcile existing badge and publication while preserving manual stock override`, async () => {
    const state = { stockLocked: true, desiredStock: 50, stockAvailable: 50, publicationStatus: sku === '1.628-018.0' ? 'ENDED' : 'ACTIVE' }
    const before = { ...state }
    let reads = 0
    await refreshCampaignListingPublication('known-offer', state.publicationStatus, async id => {
      assert.equal(id, 'known-offer')
      reads++
      return { publication: { status: 'ACTIVE' } }
    }, async () => { state.publicationStatus = 'ACTIVE' })
    assert.deepEqual(state, { ...before, publicationStatus: 'ACTIVE' })
    assert.equal(reads, sku === '1.628-018.0' ? 1 : 0)
    const remote = sku === '1.064-915.0' ? 'FINISHED' : 'WAITING_FOR_PUBLICATION'
    assert.equal(reconciledBadgeStatus('FINISHED', remote), remote)
  })
}

test('missing, inactive, and failed remote reads never activate locally', async () => {
  for (const status of [undefined, 'ENDED', 'INACTIVE', 'ACTIVATING']) {
    await refreshCampaignListingPublication('offer', 'INACTIVE', async () => ({ publication: { status } }), async () => assert.fail('unexpected persistence'))
  }
  await assert.rejects(refreshCampaignListingPublication('offer', 'ENDED', async () => { throw new Error('404') }, async () => assert.fail('unexpected persistence')), /404/)
})

test('production reconciliation has no submission, stock, desired-state, or publication-command writes', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const processor = source.slice(source.indexOf('async function processPendingCampaignApplications('), source.indexOf('let campaignFinishProcessorRunning'))
  for (const forbidden of ['submitOfferToAllegroCampaign', '/sale/badges', '/push-stock', '/push-status', 'update(listingDesiredStates)', 'stockLocked:', 'desiredStock:', 'stockAvailable:']) {
    assert.equal(processor.includes(forbidden), false, forbidden)
  }
  assert.ok(processor.includes("{ method: 'GET' }"))
  assert.ok(processor.includes('gte(listingCampaigns.validTo'))
  assert.ok(processor.includes('isNotNull(listingCampaigns.externalApplicationId)'))
  assert.match(processor, /applicationError:\s+badgeRejectionText/)
})

test('both campaign finish callers reconcile BB42 without requiring an operation ID', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.equal(source.match(/if \(result\.ok && result\.alreadyFinished\)/g)?.length, 2)
  assert.equal(source.match(/finishOperationId: null,\s+campaignStatus: 'FINISHED',\s+finishError: null,\s+finishRetryAfter: null/g)?.length, 2)
})
