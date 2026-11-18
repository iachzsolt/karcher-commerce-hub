import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractPostgresError,
  logInventoryImportError,
  logInventoryImportFinalizationError,
  type PostgresErrorInfo,
} from '../src/inventory-import-diagnostics.js'

const connectionId = '00000000-0000-0000-0000-000000000001'

describe('extractPostgresError', () => {
  void it('returns OTHER for non-Error values', () => {
    assert.deepEqual(extractPostgresError(null), { category: 'OTHER' })
    assert.deepEqual(extractPostgresError(undefined), { category: 'OTHER' })
    assert.deepEqual(extractPostgresError('raw string'), {
      category: 'OTHER',
    })
    assert.deepEqual(extractPostgresError(42), { category: 'OTHER' })
  })

  void it('falls back to Error message with OTHER category', () => {
    const result = extractPostgresError(
      new Error('unexpected database problem'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'OTHER')
    assert.equal(result.operation, 'apply_inventory_snapshot')
    assert.equal(result.code, undefined)
  })

  void it('maps lease missing/expired to LEASE_LOST', () => {
    const result = extractPostgresError(
      new Error('Inventory import lease is missing, expired, or not owned'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'LEASE_LOST')
  })

  void it('maps advisory lock contention to ADVISORY_LOCK_CONTENTION', () => {
    const result = extractPostgresError(
      new Error('Another inventory import is active for this connection'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'ADVISORY_LOCK_CONTENTION')
  })

  void it('maps another run active to ANOTHER_RUN_ACTIVE', () => {
    const result = extractPostgresError(
      new Error('Another inventory import run is still active'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'ANOTHER_RUN_ACTIVE')
  })

  void it('maps run not active to RUN_NOT_ACTIVE', () => {
    const result = extractPostgresError(
      new Error('Inventory import run is not active'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'RUN_NOT_ACTIVE')
  })

  void it('maps newer completed run to NEWER_COMPLETED_RUN', () => {
    const result = extractPostgresError(
      new Error('A newer inventory import has already completed'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'NEWER_COMPLETED_RUN')
  })

  void it('maps invalid items to INVALID_ITEMS', () => {
    const result = extractPostgresError(
      new Error('Inventory snapshot contains invalid items'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'INVALID_ITEMS')
  })

  void it('maps duplicate SKUs to DUPLICATE_SKUS', () => {
    const result = extractPostgresError(
      new Error('Inventory snapshot contains duplicate SKUs'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'DUPLICATE_SKUS')
  })

  void it('maps invalid lease name to INVALID_LEASE_NAME', () => {
    const result = extractPostgresError(
      new Error('Invalid inventory lease name'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'INVALID_LEASE_NAME')
  })

  void it('maps empty snapshot to EMPTY_SNAPSHOT', () => {
    const result = extractPostgresError(
      new Error('Inventory snapshot cannot be empty'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'EMPTY_SNAPSHOT')
  })

  void it('maps not array to NOT_ARRAY', () => {
    const result = extractPostgresError(
      new Error('Inventory snapshot must be a JSON array'),
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'NOT_ARRAY')
  })

  void it('extracts validated SQLSTATE code from error.cause', () => {
    const result = extractPostgresError(
      {
        cause: {
          code: '40001',
          message: 'some message',
          detail: 'secret detail',
          hint: 'secret hint',
          stack: 'secret stack',
        },
      },
      'fail_inventory_import',
    )
    assert.equal(result.category, 'OTHER')
    assert.equal(result.code, '40001')
    assert.equal(result.operation, 'fail_inventory_import')
  })

  void it('ignores non-SQLSTATE codes on cause', () => {
    const result = extractPostgresError(
      { cause: { code: 'not-a-code', message: 'msg' } },
      'apply_inventory_snapshot',
    )
    assert.equal(result.code, undefined)
    assert.equal(result.category, 'OTHER')
  })

  void it('does not read raw message from malformed cause object', () => {
    const result = extractPostgresError(
      { cause: { detail: 'only detail' } },
      'apply_inventory_snapshot',
    )
    assert.equal(result.category, 'OTHER')
    assert.equal(result.code, undefined)
  })

  void it('never throws on malformed error', () => {
    assert.doesNotThrow(() =>
      extractPostgresError({ cause: { toString: () => { throw new Error('boom') } } } as never),
    )
  })

  /* ---------------------------------------------------------------- *
   * Regression: nested Error causes
   * ---------------------------------------------------------------- */

  void it('traverses nested Error causes to find SQLSTATE', () => {
    const inner = new Error('Inventory import lease is missing, expired, or not owned')
    ;(inner as { code?: string }).code = '40P01'
    const middle = new Error('wrapped')
    ;(middle as { cause?: unknown }).cause = inner
    const outer = new Error('outer wrapper')
    ;(outer as { cause?: unknown }).cause = middle

    const result = extractPostgresError(outer, 'apply_inventory_snapshot')
    assert.equal(result.category, 'LEASE_LOST')
    assert.equal(result.code, '40P01')
    assert.equal(result.operation, 'apply_inventory_snapshot')
  })

  void it('prefers inner cause message for categorization over outer message', () => {
    const inner = new Error('Inventory import run is not active')
    const outer = new Error('unexpected wrapper error')
    ;(outer as { cause?: unknown }).cause = inner

    const result = extractPostgresError(outer, 'apply_inventory_snapshot')
    assert.equal(result.category, 'RUN_NOT_ACTIVE')
  })

  void it('stops at MAX_CAUSE_DEPTH without throwing', () => {
    let current: unknown = new Error('leaf')
    for (let i = 0; i < 20; i++) {
      const wrapper = new Error(`level-${i}`)
      ;(wrapper as { cause?: unknown }).cause = current
      current = wrapper
    }
    assert.doesNotThrow(() => extractPostgresError(current, 'apply_inventory_snapshot'))
  })

  /* ---------------------------------------------------------------- *
   * Regression: plain-object causes
   * ---------------------------------------------------------------- */

  void it('extracts SQLSTATE from plain-object cause chain', () => {
    const result = extractPostgresError(
      {
        cause: {
          cause: {
            code: '23505',
            message: 'duplicate key',
          },
        },
      },
      'apply_inventory_snapshot',
    )
    assert.equal(result.code, '23505')
    assert.equal(result.category, 'OTHER')
  })

  void it('handles mixed Error and plain-object cause chain', () => {
    const innerObj = { code: '40001', message: 'serialization failure' }
    const outer = new Error('wrapper')
    ;(outer as { cause?: unknown }).cause = innerObj

    const result = extractPostgresError(outer, 'apply_inventory_snapshot')
    assert.equal(result.code, '40001')
    assert.equal(result.category, 'OTHER')
  })

  /* ---------------------------------------------------------------- *
   * Regression: circular references
   * ---------------------------------------------------------------- */

  void it('handles circular Error cause chain without infinite loop', () => {
    const a = new Error('first')
    const b = new Error('second')
    ;(a as { cause?: unknown }).cause = b
    ;(b as { cause?: unknown }).cause = a

    assert.doesNotThrow(() => extractPostgresError(a, 'apply_inventory_snapshot'))
    const result = extractPostgresError(a, 'apply_inventory_snapshot')
    assert.equal(result.category, 'OTHER')
  })

  void it('handles circular plain-object cause chain', () => {
    const a: { cause?: unknown } = {}
    const b: { cause?: unknown } = {}
    a.cause = b
    b.cause = a

    assert.doesNotThrow(() => extractPostgresError(a, 'apply_inventory_snapshot'))
  })

  /* ---------------------------------------------------------------- *
   * Regression: malformed getters
   * ---------------------------------------------------------------- */

  void it('handles throwing message getter on Error', () => {
    const throwing = {} as Error
    Object.defineProperty(throwing, 'message', {
      get() {
        throw new Error('getter threw')
      },
    })
    assert.doesNotThrow(() => extractPostgresError(throwing, 'apply_inventory_snapshot'))
    const result = extractPostgresError(throwing, 'apply_inventory_snapshot')
    assert.equal(result.category, 'OTHER')
  })

  void it('handles throwing cause getter', () => {
    const base = new Error('base message')
    Object.defineProperty(base, 'cause', {
      get() {
        throw new Error('cause getter threw')
      },
    })
    assert.doesNotThrow(() => extractPostgresError(base, 'apply_inventory_snapshot'))
    const result = extractPostgresError(base, 'apply_inventory_snapshot')
    // Should still categorize from base message
    assert.equal(result.category, 'OTHER')
  })

  void it('handles throwing code property', () => {
    const base = new Error('base message')
    Object.defineProperty(base, 'code', {
      get() {
        throw new Error('code getter threw')
      },
    })
    assert.doesNotThrow(() => extractPostgresError(base, 'apply_inventory_snapshot'))
  })

  /* ---------------------------------------------------------------- *
   * Regression: operation allowlist
   * ---------------------------------------------------------------- */

  void it('drops non-allowlisted operation names', () => {
    const result = extractPostgresError(
      new Error('some error'),
      'not_an_allowed_operation' as never,
    )
    assert.equal(result.operation, undefined)
    assert.equal(result.category, 'OTHER')
  })

  void it('includes allowlisted operation names', () => {
    const result = extractPostgresError(
      new Error('some error'),
      'fail_inventory_import',
    )
    assert.equal(result.operation, 'fail_inventory_import')
  })
})

describe('logInventoryImportError', () => {
  void it('logs a safe string once with category and connection id', () => {
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }
    try {
      logInventoryImportError(
        connectionId,
        new Error('Inventory import lease is missing, expired, or not owned'),
        'apply_inventory_snapshot',
      )
    } finally {
      console.error = originalError
    }

    assert.equal(logged.length, 1)
    const line = logged[0]
    assert.ok(line.includes('inventory_import_error'), 'missing log prefix')
    assert.ok(line.includes(connectionId), 'missing connection id')
    assert.ok(line.includes('LEASE_LOST'), 'missing category')
    assert.ok(line.includes('apply_inventory_snapshot'), 'missing operation')
    // Must NOT contain the raw PostgreSQL message
    assert.ok(
      !line.includes('lease is missing'),
      'raw PostgreSQL message must not be logged',
    )
    // Must NOT contain stack trace
    assert.ok(!line.includes('at '), 'stack trace must not be logged')
  })

  void it('drops non-allowlisted operation from log output', () => {
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }
    try {
      logInventoryImportError(
        connectionId,
        new Error('some error'),
        'not_allowed' as never,
      )
    } finally {
      console.error = originalError
    }

    assert.equal(logged.length, 1)
    const line = logged[0]
    assert.ok(!line.includes('not_allowed'), 'non-allowlisted operation must not appear')
  })

  void it('never throws when console.error is unavailable', () => {
    const originalError = console.error
    console.error = undefined as unknown as typeof console.error
    try {
      assert.doesNotThrow(() =>
        logInventoryImportError(connectionId, new Error('x'), 'op'),
      )
    } finally {
      console.error = originalError
    }
  })

  void it('never throws on malformed error input', () => {
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }
    try {
      assert.doesNotThrow(() =>
        logInventoryImportError(connectionId, { cause: { toString: () => { throw new Error('boom') } } } as never, 'op'),
      )
    } finally {
      console.error = originalError
    }
    assert.equal(logged.length, 1)
  })
})

describe('logInventoryImportFinalizationError', () => {
  void it('logs a safe string with finalization prefix', () => {
    const logged: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }
    try {
      logInventoryImportFinalizationError(
        connectionId,
        new Error('Inventory import run is not active'),
      )
    } finally {
      console.error = originalError
    }

    assert.equal(logged.length, 1)
    const line = logged[0]
    assert.ok(
      line.includes('inventory_import_finalization_error'),
      'missing finalization log prefix',
    )
    assert.ok(line.includes(connectionId), 'missing connection id')
    assert.ok(line.includes('RUN_NOT_ACTIVE'), 'missing category')
    assert.ok(line.includes('fail_inventory_import'), 'missing operation')
    assert.ok(
      !line.includes('run is not active'),
      'raw PostgreSQL message must not be logged',
    )
  })

  void it('never throws when console.error is unavailable', () => {
    const originalError = console.error
    console.error = undefined as unknown as typeof console.error
    try {
      assert.doesNotThrow(() =>
        logInventoryImportFinalizationError(connectionId, new Error('x')),
      )
    } finally {
      console.error = originalError
    }
  })
})
