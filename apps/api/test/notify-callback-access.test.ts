import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import {
  accessAuthMiddleware,
  type AccessVariables,
} from '../src/access-auth.ts'
import { allegroAuth } from '../src/allegro-auth.ts'
import {
  createMemoryNotifyKv,
  setNotifyKvStore,
} from '../src/allegro-notify.ts'
import { onRequest } from '../../web/functions/api/[[path]].ts'

/*
 * Regression tests for the production OAuth callback
 * blocker: the Cloudflare Pages /api proxy rejected
 * /api/auth/allegro/notify-callback with
 * "Commerce Hub authentication is required" because its
 * own PUBLIC_PROXY_PATHS allowlist was missing the path,
 * even though the Deno API layer already treated it as
 * public. Allegro cannot present Commerce Hub credentials
 * on the browser redirect, so the callback must be public
 * at BOTH layers while /notify-connect stays protected.
 */

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
)

function readSource(relativePath: string) {
  return readFileSync(
    join(repoRoot, relativePath),
    'utf8',
  )
}

function setBlock(
  source: string,
  marker: string,
) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `missing block: ${marker}`)
  const end = source.indexOf('])', start)
  assert.ok(end > start, `unterminated block: ${marker}`)

  return source.slice(start, end)
}

type ProxyContextInit = {
  authorization?: string
  query?: string
}

function proxyContext(
  segments: string[],
  init: ProxyContextInit = {},
) {
  const url =
    `https://hub.test/api/${segments.join('/')}` +
    (init.query ?? '')
  const headers = new Headers()

  if (init.authorization) {
    headers.set(
      'Authorization',
      init.authorization,
    )
  }

  return {
    params: { path: segments },
    request: new Request(url, {
      method: 'GET',
      headers,
    }),
    env: {
      COMMERCE_HUB_API_ORIGIN:
        'https://api.test/',
    },
  }
}

const AUTH_ENV_KEYS = [
  'COMMERCE_HUB_AUTH_PROVIDER',
  'COMMERCE_HUB_ACCESS_TEAM_DOMAIN',
  'COMMERCE_HUB_ACCESS_AUDIENCE',
  'GOOGLE_OAUTH_CLIENT_ID',
]

const NOTIFY_ENV_KEYS = [
  'ALLEGRO_API_URL',
  'ALLEGRO_AUTH_URL',
  'ALLEGRO_TOKEN_URL',
  'ALLEGRO_CLIENT_ID',
  'ALLEGRO_CLIENT_SECRET',
  'ALLEGRO_NOTIFY_REDIRECT_URI',
  'ALLEGRO_USER_AGENT',
  'ALLEGRO_NOTIFY_RELAY_URL',
  'ALLEGRO_NOTIFY_RELAY_SECRET',
  'ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY',
  'ALLEGRO_NOTIFY_ORDER_EMAIL',
  'ALLEGRO_NOTIFY_MESSAGE_EMAIL',
  'ALLEGRO_NOTIFY_CANCELLATION_EMAIL',
]

function snapshotEnv(keys: string[]) {
  return new Map(
    keys.map((key) => [
      key,
      process.env[key],
    ]),
  )
}

function restoreEnv(
  snapshot: Map<string, string | undefined>,
) {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

void describe('notification callback proxy access', () => {
  const realFetch = globalThis.fetch
  const upstreamCalls: string[] = []

  afterEach(() => {
    globalThis.fetch = realFetch
    upstreamCalls.length = 0
  })

  function stubUpstream() {
    globalThis.fetch = (async (
      input: string | URL | Request,
    ) => {
      upstreamCalls.push(String(input))
      return new Response(
        JSON.stringify({ status: 'ok' }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as typeof fetch
  }

  void it('lets the primary Allegro callback through without a Bearer token', async () => {
    stubUpstream()
    const response = await onRequest(
      proxyContext([
        'auth',
        'allegro',
        'callback',
      ]) as never,
    )

    assert.equal(response.status, 200)
    assert.deepEqual(upstreamCalls, [
      'https://api.test/auth/allegro/callback',
    ])
  })

  void it('lets the notification callback through without a Bearer token and preserves code/state', async () => {
    stubUpstream()
    const response = await onRequest(
      proxyContext(
        ['auth', 'allegro', 'notify-callback'],
        { query: '?code=abc&state=xyz' },
      ) as never,
    )

    assert.equal(response.status, 200)
    assert.deepEqual(upstreamCalls, [
      'https://api.test/auth/allegro/notify-callback?code=abc&state=xyz',
    ])
  })

  void it('still requires a Bearer token for notify-connect', async () => {
    stubUpstream()
    const response = await onRequest(
      proxyContext([
        'auth',
        'allegro',
        'notify-connect',
      ]) as never,
    )

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {
      status: 'error',
      message:
        'Commerce Hub authentication is required',
    })
    assert.deepEqual(upstreamCalls, [])
  })

  void it('still requires a Bearer token for unrelated auth routes', async () => {
    stubUpstream()
    const response = await onRequest(
      proxyContext([
        'auth',
        'allegro',
        'status',
      ]) as never,
    )

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {
      status: 'error',
      message:
        'Commerce Hub authentication is required',
    })
    assert.deepEqual(upstreamCalls, [])
  })

  void it('lets an authenticated notify-connect through the proxy gate', async () => {
    stubUpstream()
    const response = await onRequest(
      proxyContext(['auth', 'allegro', 'notify-connect'], {
        authorization: 'Bearer hub-token',
      }) as never,
    )

    assert.equal(response.status, 200)
    assert.deepEqual(upstreamCalls, [
      'https://api.test/auth/allegro/notify-connect',
    ])
  })
})

void describe('notification callback API access', () => {
  void it('keeps both callbacks public and connect protected in the API allowlist', () => {
    const block = setBlock(
      readSource('apps/api/src/access-auth.ts'),
      'const PUBLIC_PATHS = new Set([',
    )

    assert.ok(
      block.includes("'/auth/allegro/callback'"),
    )
    assert.ok(
      block.includes(
        "'/auth/allegro/notify-callback'",
      ),
    )
    assert.ok(
      !block.includes('notify-connect'),
    )
  })

  void it('keeps the proxy allowlist mirrored without wildcards or connect', () => {
    const block = setBlock(
      readSource(
        'apps/web/functions/api/[[path]].ts',
      ),
      'const PUBLIC_PROXY_PATHS = new Set([',
    )

    assert.ok(block.includes("'health'"))
    assert.ok(
      block.includes("'auth/allegro/callback'"),
    )
    assert.ok(
      block.includes(
        "'auth/allegro/notify-callback'",
      ),
    )
    assert.ok(
      !block.includes('notify-connect'),
    )
    assert.ok(!block.includes('*'))
  })

  void it('bypasses Commerce Hub auth for both callbacks but not for connect', async () => {
    const snapshot = snapshotEnv(AUTH_ENV_KEYS)

    for (const key of AUTH_ENV_KEYS) {
      delete process.env[key]
    }

    try {
      const app = new Hono<{
        Variables: AccessVariables
      }>()
      app.use('*', accessAuthMiddleware)

      for (const route of [
        'callback',
        'notify-callback',
        'notify-connect',
        'status',
      ]) {
        app.get(
          `/auth/allegro/${route}`,
          (context) =>
            context.json({
              user:
                context.get('commerceHubUser') ??
                null,
            }),
        )
      }

      for (const route of [
        'callback',
        'notify-callback',
      ]) {
        const response = await app.request(
          `/auth/allegro/${route}`,
        )

        assert.equal(response.status, 200)
        assert.deepEqual(
          await response.json(),
          { user: null },
        )
      }

      for (const route of [
        'notify-connect',
        'status',
      ]) {
        const response = await app.request(
          `/auth/allegro/${route}`,
        )

        assert.equal(response.status, 200)
        const body = (await response.json()) as {
          user: { role: string } | null
        }
        assert.equal(body.user?.role, 'ADMIN')
      }
    } finally {
      restoreEnv(snapshot)
    }
  })

  void it('rejects anonymous notify-connect initiation with 403', async () => {
    const response = await allegroAuth.request(
      '/notify-connect',
    )

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      status: 'error',
      message:
        'Administrator permission is required.',
    })
  })

  void it('rejects a callback without code/state with 400', async () => {
    const response = await allegroAuth.request(
      '/notify-callback',
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      status: 'error',
      message:
        'Authorization code or state is missing.',
    })
  })

  void it('fails a callback with unknown state safely without calling Allegro', async () => {
    const snapshot = snapshotEnv(NOTIFY_ENV_KEYS)
    const tokenKey = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString('base64')
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error(
        'token endpoint must not be called',
      )
    }) as typeof fetch

    process.env.ALLEGRO_API_URL =
      'https://api.test'
    process.env.ALLEGRO_AUTH_URL =
      'https://auth.test'
    process.env.ALLEGRO_TOKEN_URL =
      'https://token.test'
    process.env.ALLEGRO_CLIENT_ID =
      'test-client'
    process.env.ALLEGRO_CLIENT_SECRET =
      'test-secret'
    process.env.ALLEGRO_NOTIFY_REDIRECT_URI =
      'https://hub.test/api/auth/allegro/notify-callback'
    process.env.ALLEGRO_USER_AGENT =
      'test-agent/1.0'
    process.env.ALLEGRO_NOTIFY_RELAY_URL =
      'https://relay.test/exec'
    process.env.ALLEGRO_NOTIFY_RELAY_SECRET =
      'relay-secret'
    process.env.ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY =
      tokenKey
    process.env.ALLEGRO_NOTIFY_ORDER_EMAIL =
      'orders@example.com'
    process.env.ALLEGRO_NOTIFY_MESSAGE_EMAIL =
      'customerservice@example.com'
    process.env.ALLEGRO_NOTIFY_CANCELLATION_EMAIL =
      'cancellations@example.com'

    setNotifyKvStore(createMemoryNotifyKv())

    try {
      const response =
        await allegroAuth.request(
          '/notify-callback?code=abc&state=bogus-state',
        )

      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), {
        status: 'error',
        message:
          'Notification authorization failed.',
      })
    } finally {
      setNotifyKvStore(null)
      globalThis.fetch = realFetch
      restoreEnv(snapshot)
    }
  })
})
