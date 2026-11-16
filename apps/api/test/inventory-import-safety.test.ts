import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canSkipInventoryImport } from '../src/inventory-import-safety.js'

const fingerprint = 'test-fingerprint-123'

test('skips when latest import succeeded with matching fingerprint', () => {
  assert.equal(
    canSkipInventoryImport({
      latestRun: {
        status: 'SUCCESS',
        sourceFingerprint: fingerprint,
      },
      currentFingerprint: fingerprint,
    }),
    true,
  )
})

test('skips when latest import is NO_CHANGE with matching fingerprint', () => {
  assert.equal(
    canSkipInventoryImport({
      latestRun: {
        status: 'NO_CHANGE',
        sourceFingerprint: fingerprint,
      },
      currentFingerprint: fingerprint,
    }),
    true,
  )
})

test('does not skip after a failed import', () => {
  assert.equal(
    canSkipInventoryImport({
      latestRun: {
        status: 'FAILED',
        sourceFingerprint: fingerprint,
      },
      currentFingerprint: fingerprint,
    }),
    false,
  )
})

test('does not skip while an import is running', () => {
  assert.equal(
    canSkipInventoryImport({
      latestRun: {
        status: 'RUNNING',
        sourceFingerprint: fingerprint,
      },
      currentFingerprint: fingerprint,
    }),
    false,
  )
})

test('does not skip when fingerprint changed', () => {
  assert.equal(
    canSkipInventoryImport({
      latestRun: {
        status: 'SUCCESS',
        sourceFingerprint: 'old-fingerprint',
      },
      currentFingerprint: fingerprint,
    }),
    false,
  )
})
