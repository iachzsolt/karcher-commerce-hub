# Allegro → email notification bridge (V1, pull/ack) — setup

One Allegro event = one email, via a scheduled Google Apps
Script client. Steady state: ONE Apps Script time trigger
(every 10 minutes), zero Neon queries, all technical state
in Deno KV. NO Deno cron for notifications.

Flow per trigger execution (bounded, max 20 emails/run):

```text
Apps Script --signed PULL--> Commerce Hub / Deno
  (at most ONE pending email returned)
Apps Script --GmailApp.sendEmail(noReply:true)--> mailbox
Apps Script --signed ACK--> Commerce Hub / Deno
  (delivered marker + cursor advance, only on valid ACK)
```

The old Deno → Apps Script Web App relay is retired: the
Workspace project only allows “Anyone within KÄRCHER”, so
external Deno POSTs received HTTP 401 before `doPost()`
ever ran. No Web App deployment is needed anymore, and no
admin policy change is requested. An existing Web App
deployment simply becomes unused.

## 1. Allegro application

The notification session uses its own OAuth client scope set:

- `allegro:api:orders:read`
- `allegro:api:messaging`
- `allegro:api:profile:read`

It needs its own set of OAuth credentials (or the existing
client with the messaging scope added) and a registered redirect
URI pointing at the deployed API:

`https://<hub-host>/api/auth/allegro/notify-callback`

The primary Commerce Hub Allegro session is untouched; the two
sessions never share a refresh token.

## 2. Deno Deploy secrets

Set these (values are examples, never commit real ones):

- `ALLEGRO_NOTIFY_ENABLED=false` (enable last)
- `ALLEGRO_NOTIFY_REDIRECT_URI` — redirect URI above
- `ALLEGRO_NOTIFY_RELAY_SECRET` — random 32+ bytes, also stored
  in Apps Script Script Properties as `RELAY_SECRET`
- `ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY` — base64, exactly
  32 bytes, dedicated to the notification session
- `ALLEGRO_NOTIFY_ORDER_EMAIL` — order mailbox
- `ALLEGRO_NOTIFY_MESSAGE_EMAIL` — customer service mailbox
- `ALLEGRO_NOTIFY_CANCELLATION_EMAIL` — order mailbox
  (future: `ALLEGRO_NOTIFY_ISSUE_EMAIL`)

`ALLEGRO_NOTIFY_RELAY_URL` is retired: it may remain
configured in Deno but is no longer read by any active
runtime logic. Do NOT set up a Web App URL.

Existing `ALLEGRO_API_URL`, `ALLEGRO_AUTH_URL`,
`ALLEGRO_TOKEN_URL`, `ALLEGRO_CLIENT_ID`,
`ALLEGRO_CLIENT_SECRET`, `ALLEGRO_USER_AGENT` are reused.

Generate secrets, e.g. `openssl rand -base64 32`.

## 3. Apps Script client

1. Create the script on the Workspace sending account from
   `apps-scripts/allegro-notify-relay/Code.gs` (copy/paste,
   no auto-deploy exists). NO Web App deployment.
2. Set Script Properties:
   - `RELAY_SECRET` = same value as
     `ALLEGRO_NOTIFY_RELAY_SECRET`
   - `COMMERCE_HUB_NOTIFY_BASE_URL` =
     `https://<hub-host>/api/auth/allegro`
3. Run `testHmacCompatibility()` (sends nothing).
4. Run `testBridgeConnection()` — signed PING: no Allegro
   poll, no cursor change, no email. While
   `ALLEGRO_NOTIFY_ENABLED=false` it answers `DISABLED`,
   which still proves HMAC + connectivity.
5. Run `testNoReplySupportToMe("your-own-address")` once and
   verify the test mail arrives non-replyable.
6. Do NOT create the trigger yet (see section 6).

## 4. OAuth bootstrap (one time)

With the secrets deployed, visit (logged in):

`https://<hub-host>/api/auth/allegro/notify-connect`

Approve the Allegro consent screen (orders + messaging +
profile read). The callback encrypts the tokens into Deno KV
(`['allegro-notify','oauth']`). No Neon writes happen.

## 5. Safe order recovery (run ONCE, while disabled)

A previous unsafe run left order state behind: always
reseed before enabling. As an administrator (logged in),
POST once:

```http
POST https://<hub-host>/api/auth/allegro/notify-reseed-orders
Content-Type: application/json

{ "confirm": true }
```

This works while `ALLEGRO_NOTIFY_ENABLED=false`, walks the
order journal to the current high-water mark, writes ONLY
the order cursor, drops a stale ORDER pending claim if one
exists, sends ZERO emails, creates ZERO delivered markers,
and never touches the message cursor/dedupe.

Expected response:

```json
{
  "status": "ok",
  "previousCursor": "...",
  "highWaterId": "...",
  "eventsScanned": 123,
  "pages": 2,
  "clearedOrderPending": false
}
```

The message cursor (already seeded in production) is left
untouched — never delete it.

## 6. Enable and verify

1. Deploy the API + Cloudflare proxy changes.
2. Paste/update `Code.gs`, configure the two Script
   Properties (`RELAY_SECRET` keeps its existing value).
3. Run `testHmacCompatibility()` → `PASS`.
4. Run `testBridgeConnection()` → `DISABLED` (flag off).
5. Keep `ALLEGRO_NOTIFY_ENABLED=false`.
6. Run the ADMIN reseed endpoint once (section 5), verify
   `status: ok`.
7. Set `ALLEGRO_NOTIFY_ENABLED=true` and redeploy.
8. Run one manual `runAllegroNotificationPoll()`; verify no
   historical flood (expect `NOOP`/`SEEDED`, zero emails
   unless a genuinely new event arrived).
9. Run `setupAllegroNotificationTrigger()` once (10-minute
   trigger; repeated runs do not duplicate it).
10. Monitor the first real new event: exactly one email,
    then `ACKED` in the following poll logs.

Deno Deploy Cron dashboard expected total afterwards: 6
(2 daily scheduler + 3 Arukereso source + 1 maintenance) —
the notification cron is gone.

## 7. Operational notes

- Public bridge endpoints (transport-public, HMAC-required):
  `POST /api/auth/allegro/notify-pull`,
  `POST /api/auth/allegro/notify-ack`.
- ADMIN-only, never proxied anonymously:
  `/api/auth/allegro/notify-connect`,
  `/api/auth/allegro/notify-reseed-orders`.
- Deno KV holds only: encrypted OAuth blob, order/message
  cursors, delivered IDs (60-day TTL), ONE pending claim
  (30-min TTL), bridge nonces (10-min TTL), timestamps.
- No failed email is lost: without an ACK the event stays
  pending and the next trigger re-offers the SAME event.
- Crash between Gmail send and ACK can duplicate one
  email (at-least-once); events are never lost to avoid
  that duplicate window.
- If the stored refresh token is rejected, pulls answer
  `NEEDS_BOOTSTRAP` and skip work — repeat step 4.
- First-ever order pull seeds the cursor silently at the
  true journal high-water mark (no historic email flood).
- Deno logs contain only event types and technical IDs —
  never customer data.

## 8. Troubleshooting BAD_SIGNATURE

The pull/ack HMAC is byte-identical on both sides (pinned
cross-runtime ping vector in `test/notify-bridge.test.ts`:
body `{"mode":"ping"}`, timestamp
`2026-09-19T14:00:00.000Z`, nonce
`00112233445566778899aabbccddeeff`, signature
`a64000…1bbae`). If production still answers `BAD_SIGNATURE`
after setting the same secret on both sides, do NOT rotate
again — check configuration instead:

1. Deno Deploy deployments are immutable, including their
   environment variables. Confirm the RUNNING production
   revision was created AFTER the `ALLEGRO_NOTIFY_RELAY_SECRET`
   change (dashboard → Deployments → timestamps). If it
   predates the change, redeploy/promote — no code or secret
   change is needed. The code reads `process.env` per request
   and caches nothing.
2. Compare secret LENGTH only (never values): if the Apps
   Script `RELAY_SECRET` length differs from the value saved
   in Deno, one side gained invisible characters while
   pasting (trailing newline/space). Re-paste carefully,
   then redeploy Deno per step 1.
3. Confirm the Apps Script project running
   `testBridgeConnection()` is the one holding the current
   `Code.gs` + `RELAY_SECRET` (no stale duplicate project).
