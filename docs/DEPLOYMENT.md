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

Set this Pages Functions runtime variable to the HTTPS origin of the Deno
deployment. Do not include `/api`; the proxy removes that prefix:

```text
COMMERCE_HUB_API_ORIGIN=https://your-deno-api.example
```

The `/api` route is handled by an authenticated Cloudflare proxy.
Local development keeps using `http://localhost:3000` when the variable is not
set.

The proxy is implemented by `apps/web/functions/api/[[path]].ts`. It refuses
requests without the `Cf-Access-Jwt-Assertion` header, requires same-origin
browser requests for changing methods, forwards the assertion for full JWT
verification by the API, and disables response caching. Configure the Pages
project to fail closed if the Functions quota is exhausted.

Only `/api/*` invokes Pages Functions. Static assets remain on the unlimited
static Pages path. The SPA fallback is defined in `public/_redirects`.

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

1. Create the Cloudflare Pages project and Access application.
2. Configure the Pages and API environment variables with both scheduler
   switches set to `false` and no administrator email addresses.
3. Review and apply the scheduler lease migration.
4. Verify the monorepo dependency build in a Deno runtime.
5. Persist OAuth authorization state so it survives runtime restarts.
6. Add user identity to write audit events.
7. Perform a read-only production smoke test before any Allegro write.
