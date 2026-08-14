# Karcher Commerce Hub – agent instructions

## Scope and safety

- This monorepo is connected to a real Allegro production account. Treat every remote write as production-sensitive.
- Before any Allegro write, inspect the route and callers, verify the intended account/environment, prefer read-only checks, and keep the write targeted.
- Never remove, bypass, or weaken `getAllegroEnvironment`, `assertAllegroEnvironmentConfiguration`, `assertAllegroWriteSafety` (all in `apps/api/src/allegro-auth.ts`), confirmation requirements, targeting, pagination, or batching safeguards.
- Do not run bulk inventory, price, publication, or campaign writes unless the user explicitly requests them and the exact target set is known.
- Allegro operations are often asynchronous/eventually consistent. A timeout or HTTP `202` does not prove failure or completion; reconcile remote state before retrying.
- Preserve manual listing decisions. In particular, a manually `INACTIVE` listing must not be auto-reactivated by inventory automation.

## Working method

- Use: inspect → reason → minimal change → typecheck → diff check → targeted test.
- There is no automated test suite in this repo; "targeted test" means manual HTTP verification against a real or local stack.
- Avoid speculative refactors and unrelated edits. Preserve existing user changes in a dirty worktree.
- Do not commit automatically. Show the changed files and diff, then wait for explicit approval.
- Never stage or commit `tmp/` or `*.bak` files; both are gitignored local scratch. Do not inspect or alter them unless the user explicitly asks.
- Keep text files UTF-8 without BOM. Be careful with PowerShell rewrites, CRLF churn, and encoding-only diffs.
- Store monetary values in minor units. Example: `12 990 HUF = 1299000`.

## Repository and verification

- Monorepo: `apps/api` (Hono/TypeScript), `apps/web` (React/Vite/TypeScript), `packages/database` (Drizzle/Neon PostgreSQL).
- Local defaults: API `http://localhost:3000`, web `http://localhost:5173`.
- On Windows use `pnpm.cmd`.
- Typical checks, limited to affected packages:

```powershell
pnpm.cmd --dir ".\apps\api" exec tsc --noEmit
pnpm.cmd --dir ".\apps\web" exec tsc --noEmit
pnpm.cmd --dir ".\apps\web" exec eslint .
git diff --check
git status --short
git diff
```

- `@karcher-commerce-hub/database` exports resolve to `packages/database/dist`, so build the database package before running the API (`apps/api` `build` does this; `dev`/`start` do not).
- Migrations live in `packages/database/drizzle/`; `drizzle.config.ts` reads `DATABASE_URL` from `apps/api/.env`. Migrations are never applied automatically on deploy — apply them manually.
- Schedulers are off by default: local automation runs only when `COMMERCE_HUB_SCHEDULERS_ENABLED` is exactly `true`. Production additionally gates per-feature jobs and Deno cron (`COMMERCE_HUB_DENO_CRON_ENABLED`). See `docs/DEPLOYMENT.md`.
- Deployment: web → Cloudflare Pages (proxy in `apps/web/functions/api/[[path]].ts`), API → Deno Deploy via root `deno.json` running `apps/api/dist/deno.js` from `apps/api/src/deno.ts`. Full detail in `docs/DEPLOYMENT.md`.
- Inventory automation uses batches of **25**. Do not increase this casually: production stress testing showed timeouts at 100 and 15/15 successful batches at 25.
- Read `docs/CODEX_HANDOFF.md` before changing Allegro inventory, pricing, campaign, price-history, or automation logic.