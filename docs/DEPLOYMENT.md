# Commerce Hub deployment

## Current deployment target

- Frontend and API proxy: Cloudflare Pages
- User authentication: Google Identity Services
- API and scheduled jobs: Deno Deploy
- Database: Neon PostgreSQL

Cloudflare Zero Trust is intentionally not required. Its free-plan activation
requested payment details and authorization for overage charges, so the
application uses card-free Google sign-in instead.

## Google sign-in

Create a Google OAuth 2.0 **Web application** client. Add the final Cloudflare
Pages production origin to **Authorized JavaScript origins**, for example:

```text
https://commerce-hub.pages.dev
```

Google Identity Services returns an ID token directly to the frontend; it does
not use an OAuth redirect URI for Commerce Hub sign-in. The same client ID must
be configured in the frontend build and the Deno API runtime.

The frontend keeps the short-lived Google ID token in `sessionStorage`, sends
it only to the configured Commerce Hub API origin, and clears it when the user
signs out or the API returns HTTP 401. The API verifies the Google signature,
issuer, audience, verified-email claim, and the Commerce Hub email allowlist.

## Frontend configuration

Set these build-time variables in Cloudflare Pages:

```text
VITE_API_BASE_URL=/api
VITE_COMMERCE_HUB_AUTH_PROVIDER=google
VITE_GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Set this Pages Functions runtime variable to the HTTPS origin of the Deno
deployment. Do not include `/api`; the proxy removes that prefix:

```text
COMMERCE_HUB_API_ORIGIN=https://your-deno-api.example
```

The proxy is implemented by `apps/web/functions/api/[[path]].ts`. It requires
a bearer token for protected API requests, requires same-origin browser
requests for changing methods, forwards the token for full verification by the
API, and disables response caching. Only `/health` and the state/PKCE-protected
Allegro OAuth callback are public. Configure the Pages project to fail closed
if the Functions quota is exhausted.

Only `/api/*` invokes Pages Functions. Static assets remain on the unlimited
static Pages path. The SPA fallback is defined in `public/_redirects`.

## API configuration

Required production values:

```text
NODE_ENV=production
COMMERCE_HUB_WEB_ORIGINS=https://commerce-hub.pages.dev
COMMERCE_HUB_AUTH_PROVIDER=google
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
COMMERCE_HUB_ALLOWED_EMAILS=viewer@example.com
COMMERCE_HUB_ADMIN_EMAILS=admin@example.com
COMMERCE_HUB_ALLEGRO_SESSION_RESTORE_ENABLED=false
COMMERCE_HUB_SCHEDULERS_ENABLED=false
COMMERCE_HUB_DENO_CRON_ENABLED=false
COMMERCE_HUB_DATA_CONNECTION_SCHEDULES_ENABLED=false
COMMERCE_HUB_CATALOG_SYNC_ENABLED=false
COMMERCE_HUB_PRICE_SCHEDULES_ENABLED=false
COMMERCE_HUB_CAMPAIGN_AUTOMATION_ENABLED=false
```

Multiple origins and email addresses are comma-separated. Email matching is
case-insensitive. Production startup fails when the Google client ID is
missing or both email lists are empty. Only `/health` and the Allegro OAuth
callback remain public.

Authenticated users are read-only by default. Only addresses listed in
`COMMERCE_HUB_ADMIN_EMAILS` can call non-GET API routes. For the first pilot,
put every colleague in `COMMERCE_HUB_ALLOWED_EMAILS` and keep
`COMMERCE_HUB_ADMIN_EMAILS` empty. Add an administrator only after the
read-only smoke test passes.

The Allegro OAuth callback must use the public Pages proxy URL:

```text
ALLEGRO_REDIRECT_URI=https://commerce-hub.pages.dev/api/auth/allegro/callback
```

The callback remains protected by Allegro state and PKCE validation. Starting
a new Allegro authorization requires a signed-in Commerce Hub user.

The repository root `deno.json` is the source-controlled Deno Deploy app
configuration. Use the repository root as the application directory. It
installs all workspace build dependencies, builds the database package and
API, then starts `apps/api/dist/deno.js` as a dynamic application. There is
intentionally no pre-deploy command, so database migrations cannot run as a
deployment side effect.

Use `apps/api/.env.deno.example` as the runtime checklist. Enter credentials as
Deno Deploy secrets in the Production context. Keep
`COMMERCE_HUB_ADMIN_EMAILS` empty and both scheduler switches `false` for the
first deployment. Keep `COMMERCE_HUB_ALLEGRO_SESSION_RESTORE_ENABLED=false`
as well so startup cannot restore or refresh the Allegro session during the
initial read-only smoke test.

## Deno entry point and scheduled jobs

The Deno entry point is `apps/api/src/deno.ts`. It registers cron jobs at
module scope, as required by Deno Deploy, and serves the same Hono application
as the local Node entry point. Cron schedules are expressed in UTC so the
intended local times hold regardless of timezone support:

- Daily scheduler crons — registered dynamically at startup from the enabled
  data connection schedule (`daily_times_json` of the INVENTORY connection).
  Every configured local time (e.g. `15:40` Europe/Budapest) maps to two UTC
  cron rules, one for the summer and one for the winter offset (CEST +2 / CET
  +1), because Deno Deploy evaluates cron rules in UTC and ignores the
  timezone option. The database due-check (`next_run_at`, computed in the
  schedule's timezone) decides which firing actually runs; the other firing
  is a no-op. This keeps imports aligned with every configured refresh time:
  sheet import → Allegro catalog sync (offers, listings, stock/status) →
  platform automation (stock refresh). The catalog sync runs only when the
  import succeeded and `COMMERCE_HUB_CATALOG_SYNC_ENABLED=true`; running it
  before the automation ensures newly imported offers receive their stock in
  the same run. Changing the configured times takes effect on the next
  deploy. If the schedule cannot be read at startup, a fallback rule
  (15:40 Europe/Budapest) is registered.
- `0 2 * * *` — daily maintenance (Allegro history cleanup), 02:00 UTC.

The former minute poll, six-hour cron, and standalone catalog-sync cron were
removed. The minute poll kept the Neon database compute active 24/7 (free-tier
compute hours), the six-hour sync is a no-op in production, and the catalog
sync now runs only when the automatic data connection sync is configured.
Between the scheduled runs the database compute can suspend.

Keep `COMMERCE_HUB_DENO_CRON_ENABLED=false` during the first deployment. Deno
cron executions have at-least-once delivery semantics, so the Allegro jobs
must remain disabled until migration `0020_scheduler_leases.sql` has been
reviewed and applied. The scheduler fails closed when the lease table is
missing or a lease cannot be acquired.

`COMMERCE_HUB_SCHEDULERS_ENABLED` controls only the persistent Node timers. It
is disabled unless its value is explicitly `true`. Keep it `false` in Deno and
in read-only smoke-test environments.

## Remaining work before deployment

1. Create the Google OAuth web client and configure the final Pages origin.
2. Create the Cloudflare Pages project and configure its build/runtime values.
3. Configure Deno with Google authentication, an explicit viewer allowlist,
   no administrator addresses, and both scheduler switches set to `false`.
4. Perform a read-only production smoke test before any Allegro write.
5. Review and apply the scheduler lease migration only after the read-only
   deployment is stable.
6. Persist Allegro OAuth authorization state so it survives runtime restarts.
7. Add user identity to write audit events.
