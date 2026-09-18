# Allegro → email notification bridge (V1) — setup

One Allegro event = one email, via a Google Apps Script relay.
Steady state: ONE Deno cron (`commerce-hub-allegro-notify`, every
10 minutes), zero Neon queries, all technical state in Deno KV.

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
- `ALLEGRO_NOTIFY_RELAY_URL` — Apps Script Web App URL
- `ALLEGRO_NOTIFY_RELAY_SECRET` — random 32+ bytes, also stored
  in Apps Script Script Properties as `RELAY_SECRET`
- `ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY` — base64, exactly
  32 bytes, dedicated to the notification session
- `ALLEGRO_NOTIFY_ORDER_EMAIL` — order mailbox
- `ALLEGRO_NOTIFY_MESSAGE_EMAIL` — customer service mailbox
- `ALLEGRO_NOTIFY_CANCELLATION_EMAIL` — order mailbox
  (future: `ALLEGRO_NOTIFY_ISSUE_EMAIL`)

Existing `ALLEGRO_API_URL`, `ALLEGRO_AUTH_URL`,
`ALLEGRO_TOKEN_URL`, `ALLEGRO_CLIENT_ID`,
`ALLEGRO_CLIENT_SECRET`, `ALLEGRO_USER_AGENT` are reused.

Generate secrets, e.g. `openssl rand -base64 32`.

## 3. Apps Script relay

1. Create the script on the Workspace sending account from
   `apps-scripts/allegro-notify-relay/Code.gs` (copy/paste,
   no auto-deploy exists).
2. Set Script Property `RELAY_SECRET` to the same value as
   `ALLEGRO_NOTIFY_RELAY_SECRET`.
3. Run `testNoReplySupport("your-own-address")` once and
   verify the test mail arrives non-replyable.
4. Deploy as Web App: Execute as *me*, access *anyone*
   (requests are authenticated by HMAC signature inside).
5. Copy the Web App URL to `ALLEGRO_NOTIFY_RELAY_URL`.

## 4. OAuth bootstrap (one time)

With the secrets deployed, visit (logged in):

`https://<hub-host>/api/auth/allegro/notify-connect`

Approve the Allegro consent screen (orders + messaging +
profile read). The callback encrypts the tokens into Deno KV
(`['allegro-notify','oauth']`). No Neon writes happen.

## 5. Enable and verify

1. Set `ALLEGRO_NOTIFY_ENABLED=true` and redeploy.
2. Confirm `commerce-hub-allegro-notify` appears in the Deno
   Deploy Cron dashboard (expected total: 7 crons).
3. Trigger a test order/message; confirm exactly one email
   per event with the no-reply footer.
4. Deno logs contain only event types and technical IDs —
   never customer data.

## 6. Operational notes

- Deno KV holds only: encrypted OAuth blob, order/message
  cursors, delivered IDs (60-day TTL), cron lease, timestamps.
- Failed relay delivery retries on the next tick; the cursor
  never advances past an undelivered event, and later events
  still proceed via their own dedupe keys.
- Crash between mail send and KV mark can duplicate one
  email (at-least-once); events are never lost to avoid that
  duplicate window.
- If the stored refresh token is rejected (e.g. rotation
  interrupted mid-write), the tick logs `NEEDS_BOOTSTRAP`
  and skips work — repeat step 4.
- First enablement seeds cursors silently (no historic
  email flood).
