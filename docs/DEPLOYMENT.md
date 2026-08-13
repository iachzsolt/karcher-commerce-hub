# Commerce Hub deployment

## Current deployment target

- Frontend: Cloudflare Pages
- Access control: Cloudflare Access
- API and scheduled jobs: Deno Deploy
- Database: Neon PostgreSQL

The production deployment is not active yet. Do not publish the API before
Cloudflare Access validation is configured and verified.

## Frontend configuration

Set this build-time variable in Cloudflare Pages:

```text
VITE_API_BASE_URL=/api
```

The `/api` route will later be handled by an authenticated Cloudflare proxy.
Local development keeps using `http://localhost:3000` when the variable is not
set.

## API configuration

Required production values:

```text
NODE_ENV=production
COMMERCE_HUB_WEB_ORIGINS=https://commerce.example.com
COMMERCE_HUB_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
COMMERCE_HUB_ACCESS_AUDIENCE=your-access-application-aud
COMMERCE_HUB_ALLOWED_EMAILS=viewer@example.com
COMMERCE_HUB_ADMIN_EMAILS=admin@example.com
COMMERCE_HUB_SCHEDULERS_ENABLED=false
COMMERCE_HUB_DENO_CRON_ENABLED=false
```

Multiple origins and email addresses are comma-separated. Email matching is
case-insensitive.

Production startup fails when the Access team domain or audience is missing.
The API validates the signature, issuer, and audience of every Cloudflare
Access JWT. Only `/health` remains public for hosting health checks.

Authenticated users are read-only by default. Only addresses listed in
`COMMERCE_HUB_ADMIN_EMAILS` can call non-GET API routes. This intentionally
keeps the first colleague pilot read-only.

## Deno entry point and scheduled jobs

The Deno entry point is `apps/api/src/deno.ts`. It registers four UTC cron
jobs at module scope, as required by Deno Deploy, and serves the same Hono
application as the local Node entry point.

Keep `COMMERCE_HUB_DENO_CRON_ENABLED=false` during the first deployment. Deno
cron executions have at-least-once delivery semantics, so the Allegro jobs
must remain disabled until migration `0020_scheduler_leases.sql` has been
reviewed and applied. The scheduler fails closed when the lease table is
missing or a lease cannot be acquired. An acquired lease remains active until
the next schedule window, which also suppresses duplicate at-least-once cron
deliveries that arrive after the first invocation has already completed.

`COMMERCE_HUB_SCHEDULERS_ENABLED` controls only the persistent Node timers.
It is disabled unless its value is explicitly `true`. Keep it `false` in
Deno and in read-only smoke-test environments.

## Remaining work before deployment

1. Create the Cloudflare Access application and authenticated `/api` proxy.
2. Review and apply the scheduler lease migration.
3. Verify the monorepo dependency build in a Deno runtime.
4. Persist OAuth authorization state so it survives runtime restarts.
5. Add user identity to write audit events.
6. Perform a read-only production smoke test before any Allegro write.
