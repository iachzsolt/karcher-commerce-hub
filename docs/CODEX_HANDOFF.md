# Karcher Commerce Hub – Codex technical handoff

## 1. Purpose and current scope

Karcher Commerce Hub is an internal commerce-management application for Kärcher Hungary. Its current primary integration is Allegro Hungary (`allegro-hu`), while the architecture is intended to remain extensible to other marketplaces.

The implemented scope includes:

- Allegro OAuth/account connection;
- listing and catalog synchronization;
- inventory synchronization with zero-stock deactivation and stock-return reactivation;
- manual and scheduled price changes;
- Allegro campaign discovery, preparation, scheduling, submission, reconciliation, and finish handling;
- rolling 30-day price history and a separate campaign reference minimum.

The application is connected to a real Allegro production account. Read-only investigation should precede writes, and all existing environment/write guards must remain intact.

## 2. Repository and stack

Windows repository:

```text
C:\Users\zsolt.iachmanovski\Projects\karcher-commerce-hub
```

Structure:

```text
apps/
  api/                  Hono API, Allegro integration and automation
  web/                  React/Vite UI
packages/
  database/             Drizzle schema and database package
infrastructure/
docs/
```

Main stack: Node.js 24.x, pnpm, TypeScript, React, Vite, Hono, Drizzle ORM, and Neon PostgreSQL. The repository currently declares `pnpm@10.34.1`.

Local defaults:

```text
API: http://localhost:3000
Web: http://localhost:5173
```

Important files:

```text
apps/api/src/allegro-auth.ts
apps/api/src/allegro-inventory-sync.ts
apps/api/src/platform-automation.ts
apps/api/src/index.ts
apps/web/src/pages/AllegroPage.tsx
apps/web/src/pages/AllegroSettingsPage.tsx
apps/web/src/pages/AllegroCampaignsPage.tsx
apps/web/src/CommerceHub.css
packages/database/src/schema.ts
```

## 3. Safety model and development workflow

Allegro production safety helpers live in `apps/api/src/allegro-auth.ts`:

```text
getAllegroEnvironment
assertAllegroEnvironmentConfiguration
assertAllegroWriteSafety
```

Do not remove or weaken these helpers, confirmation checks, target restrictions, pagination, or batching. Before a live write:

1. inspect the implementation and its callers;
2. identify the environment, account, marketplace, listings, and operation exactly;
3. perform read-only state checks first;
4. keep the write targeted and bounded;
5. reconcile remote state afterward, accounting for Allegro's asynchronous behavior.

A client timeout can occur while the backend/Allegro operation continues. Do not blindly replay timed-out inventory, price, publication, or campaign writes. Likewise, HTTP `202 PENDING` is not final success.

Preferred workflow:

```text
inspect → reason → minimal change → typecheck → diff check → targeted test
```

On Windows use:

```powershell
pnpm.cmd --dir ".\apps\api" exec tsc --noEmit
pnpm.cmd --dir ".\apps\web" exec tsc --noEmit
git diff --check
git status --short
git diff
```

Run only the checks relevant to the affected package, plus `git diff --check`. Keep files UTF-8 without BOM; PowerShell rewrites previously introduced BOM/line-ending noise. Never stage or commit `tmp/`; it is local scratch/output and was intentionally left untracked at handoff time. Do not commit automatically.

## 4. Database concepts

Important tables include:

```text
products
product_identifiers
platforms
platform_listings
listing_desired_states
listing_remote_states
listing_accepted_states
listing_campaigns
listing_price_schedules
listing_price_history
platform_inventory_sync_settings
```

Relevant `listing_price_history` concepts/fields:

```text
listingId
priceMinor
basePriceMinor
priceType
externalCampaignId
currency
source
observedAt
```

Money is stored in minor units:

```text
12 990 HUF = 1299000
6 990 HUF  = 699000
```

Do not mix formatted HUF values and minor-unit integers in API/database logic.

## 5. Allegro inventory source and normalization

The production inventory source is a Google Sheet. The active inventory source/connection ID used during the verified production run was:

```text
0302f4dd-5593-4b76-8008-e9ae9a48087d
```

Relevant source columns:

```text
SKU:   Cikkszám
Stock: Aktuális készlet
```

The verified managed set contained 352 unique listings. Duplicate SKUs are deliberately excluded from automatic synchronization.

Input normalization must preserve this behavior:

```text
positive number     → that number
numeric text "514" → 514
0                   → 0
negative number     → 0
"not stocked"       → 0
"not fulfilled"     → 0
missing source SKU  → temporary stock 0
```

The missing-SKU behavior is intentional and participates in the auto-pause lifecycle.

## 6. Inventory synchronization and the 25-item batch

Core implementation:

```text
apps/api/src/allegro-inventory-sync.ts
apps/api/src/platform-automation.ts
```

Manual endpoint:

```http
POST /auth/allegro/inventory-sync
```

Example body:

```json
{
  "confirm": true,
  "connectionId": "...",
  "listingIds": ["..."]
}
```

The route can accept up to 100 listings, but scheduled automation intentionally splits work into batches of **25** in `platform-automation.ts` (`index += 25`, `slice(index, index + 25)`). This is a production-tested operational constraint, not arbitrary formatting.

Stress-test history:

```text
Managed listings: 352

100-item batches:
Batch 1 OK
Batch 2 TIMEOUT
Batch 3 TIMEOUT
Batch 4 OK

Observed real changes:
DECREASED   200
ENDED        31
INCREASED    19
REACTIVATED  33

25-item batches:
15/15 OK
0 failed
0 timeout
```

Final production consistency audit:

```text
Managed                    352
Source != desired            0
ACTIVE + autoPaused          0
Positive source + ENDED      0
Zero source + ACTIVE         0
ACTIVE stock != source       0
```

Population after the run:

```text
285 positive source + ACTIVE
65  zero source + ENDED
1   manually INACTIVE
1   source-missing / auto-paused
```

Do not increase the automation batch size without a measured, production-safe reason and an explicit verification plan.

## 7. Inventory lifecycle invariants

### Zero stock

For this business flow Allegro is not treated as a simple quantity-zero system. When normalized source stock becomes zero:

```text
desiredStock = 0
desiredPublicationStatus = INACTIVE
stockAutoPaused = true
remote offer is ENDed
```

The remote `stockAvailable` value may still display an earlier positive number after the offer is `ENDED`; the lifecycle correctness comes from publication status plus desired/internal state.

### Stock returns

When source stock returns above zero for a listing previously auto-paused by stock logic:

```text
update desired/remote stock
desiredPublicationStatus = ACTIVE
send ACTIVATE
ENDED → ACTIVATING → ACTIVE
```

Allegro publication changes are asynchronous. `stockAutoPaused` may legitimately remain `true` while ACTIVATE is being processed. A later synchronization performs cleanup when it observes remote `ACTIVE`:

```ts
if (
  row.stockAutoPaused &&
  row.publicationStatus === 'ACTIVE'
) {
  // clear internal auto pause; do not send another ACTIVATE
}
```

Do not remove this second-pass cleanup. Production testing confirmed 33 reactivations, followed by `ACTIVE + stockAutoPaused = 0` after cleanup.

### Manual inactivity must win

Known verified example:

```text
SKU: 2.644-081.0
source stock: 343
publicationStatus: INACTIVE
desiredPublicationStatus: INACTIVE
stockAutoPaused: false
```

This is manually inactive and must **not** auto-reactivate.

Known source-missing example:

```text
SKU: 1.269-620.0
desiredStock: 0
publicationStatus: ENDED
desiredPublicationStatus: INACTIVE
stockAutoPaused: true
```

This is an expected auto-paused state.

## 8. Manual and scheduled price updates

Previously used production test listing:

```text
SKU:       2.643-950.0
listingId: cf696e84-4e72-4dbe-b4bb-cc04ec23dee0
offerId:   18786178818
normal:    2990 HUF
```

Relevant endpoints:

```http
PATCH /allegro/listings/:id/desired-price
PATCH /allegro/listings/:id/price-lock
POST  /auth/allegro/push-price/:listingId
```

Allegro price updates are eventually consistent. The stabilizing sequence used by the implementation/test was targeted sync → refresh → wait about four seconds → refresh again. See commit `46afacb fix: stabilize Allegro price updates`.

Scheduled-price model and routes:

```text
listing_price_schedules

GET  /allegro/listing-price-schedules
POST /allegro/listing-price-schedules
POST /auth/allegro/process-price-schedules
```

The processor runs approximately every 60 seconds. A previous defect treated Allegro HTTP `202 PENDING` as completed; commit `9249aa4 fix: handle pending scheduled price updates` corrected this. A production round trip `2990 → 2890 → 2990` passed.

## 9. Campaign discovery and eligibility

Frontend:

```text
apps/web/src/pages/AllegroCampaignsPage.tsx
```

Backend:

```text
apps/api/src/allegro-auth.ts
apps/api/src/index.ts
```

Remote campaign sources:

```http
GET /sale/badge-campaigns?marketplace.id=allegro-hu
GET /sale/alle-discount/campaigns
```

Application eligibility endpoint:

```http
GET /auth/allegro/alle-discount/:campaignId/eligible-offers
```

The frontend's `isCampaignCurrentlyNominatable()` filtering accounts for BADGE account eligibility, excludes `application = NEVER`, respects application from/to windows, and respects `publicationTo`. Campaigns that cannot be nominated should not appear as ordinary selectable targets.

Production campaign used during verification:

```text
ALLDEALS_202608_HU
Allegro Napok
23 Jul – 23 Aug 2026
```

Treat this as historical test context, not as a currently active campaign assumption.

## 10. Campaign preparation, submission, and reconciliation

Application endpoints:

```http
GET  /allegro/remote-campaigns/:campaignId/preparations
PUT  /allegro/remote-campaigns/:campaignId/preparations
POST /allegro/remote-campaigns/:campaignId/schedule
POST /allegro/remote-campaigns/:campaignId/submit
POST /allegro/remote-campaigns/:campaignId/finish
```

High-level local flow:

```text
PREPARED → SCHEDULED → REQUESTED → PROCESSED → reconciled remote status
```

Submission scheduling runs about every 60 seconds and includes recovery after API restart. A production restart test confirmed that a scheduled submission still executed after restart.

Remote badge reconciliation uses Allegro's read endpoint `GET /sale/badges`; the application also exposes a debug/read route for badge inspection by offer ID. Recognized remote statuses include:

```text
ACTIVE
IN_VERIFICATION
WAITING_FOR_PUBLICATION
FINISHED
DECLINED
```

Unknown status maps to `AWAITING_BADGE`. Critically, local `applicationStatus = PROCESSED` does **not** mean the campaign is active; actual remote badge state must be reconciled.

Remote price mapping:

```text
prices.bargain.amount → remotePriceMinor
prices.market.amount  → referencePriceMinor
```

## 11. Campaign finish and retries

Campaign finish is asynchronous and can fail temporarily. Allegro code `BB0` is treated as retryable. The implemented retry schedule is approximately:

```text
5 minutes
15 minutes
30 minutes
60 minutes
```

The lifecycle is capped at about five attempts. Relevant persisted fields:

```text
finishRetryAfter
finishRetryCount
finishError
```

Successful completion clears the scheduled retry state and resets the retry count where appropriate. Preserve idempotency and remote reconciliation when changing this path.

Observed rejection/error codes:

```text
BA101  offer product not on the campaign's eligible product list
BA104  campaign/product/price eligibility conditions not satisfied
BB0    temporary/retryable Allegro finish error
```

The frontend parses structured errors into friendlier explanations.

## 12. Campaign selection UI invariant

Loading saved preparations must not automatically select them. The old behavior populated selected IDs from every loaded preparation, which left finished or declined rows invisibly selected and disabled actions. The intended behavior is:

```ts
setSelectedListingIds([])
```

after preparation loading, while preserving preparation values/statuses.

Selection rules:

```text
new/editable  selectable
PREPARED      selectable
SCHEDULED     selectable for manual submit
ACTIVE        not selectable
DECLINED      not selectable
FINISHED      not selectable
```

Keep stale-selection cleanup aligned with preparation status.

## 13. Thirty-day price history

Campaign bargain prices used to be missed when a short campaign became active and finished between normal listing synchronizations. Commit `db02a69 fix: include campaign prices in 30-day history` records campaign prices when remote badge reconciliation confirms `ACTIVE` or `FINISHED`.

History row semantics:

```text
priceMinor          = remote bargain price
basePriceMinor      = remote market/reference price
priceType           = PROMOTION
externalCampaignId  = campaign ID
source              = ALLEGRO_CAMPAIGN
observedAt           = observation time; for FINISHED-only recovery, campaign validTo where appropriate
```

`DECLINED` campaigns must never enter price history. The duplicate guard uses approximately:

```text
listingId + externalCampaignId + priceType(PROMOTION) + priceMinor
```

Preserve idempotency if reconciliation runs repeatedly.

## 14. Rolling minimum vs campaign reference minimum

Endpoint:

```http
GET /allegro/listing-price-history-summary
GET /allegro/listing-price-history-summary?campaignId=...
```

Two values intentionally answer different business questions:

- `min30PriceMinor` is the actual rolling 30-day minimum and **includes** real campaign bargain prices.
- `campaignReferenceMin30PriceMinor` is the reference minimum for the selected campaign and excludes that same campaign's own promotional history, so its bargain price does not lower its own legal/commercial reference baseline.

Verified example:

```text
normal price:                  12 990 HUF (1299000)
campaign bargain:              6 990 HUF (699000)
rolling min30PriceMinor:        699000
campaignReferenceMin30PriceMinor for that campaign: 1299000
```

Do not merge these calculations or substitute one field for the other in the campaign UI.

## 15. Important commits

Recent verified history, newest first:

```text
61daadf fix: reduce Allegro inventory sync batch size
db02a69 fix: include campaign prices in 30-day history
b6bbbe4 feat: complete Allegro campaign lifecycle handling
9249aa4 fix: handle pending scheduled price updates
46afacb fix: stabilize Allegro price updates
1ffc65c fix: refresh Allegro stock after manual update
2a8bce8 fix: complete Allegro inventory sync lifecycle
e3edc8d feat: harden scheduled Allegro inventory sync
07fcc27 feat: finalize Allegro production inventory sync workflow
fa95d91 feat: add production Allegro inventory sync safeguards and batching
66923b1 feat: add Allegro production safety guards
```

Inspect these commits before rewriting the corresponding lifecycle logic; they encode production-learned behavior.

## 16. Tested endpoints and scenarios

The following paths/scenarios were exercised during development and production verification:

```text
GET  /allegro/listings
POST /auth/allegro/inventory-sync
PATCH /allegro/listings/:id/desired-price
PATCH /allegro/listings/:id/price-lock
POST /auth/allegro/push-price/:listingId
GET/POST /allegro/listing-price-schedules
POST /auth/allegro/process-price-schedules
GET  /auth/allegro/alle-discount/campaigns
GET  /auth/allegro/alle-discount/:campaignId/eligible-offers
GET/PUT /allegro/remote-campaigns/:campaignId/preparations
POST /allegro/remote-campaigns/:campaignId/schedule
POST /allegro/remote-campaigns/:campaignId/submit
POST /allegro/remote-campaigns/:campaignId/finish
GET  /allegro/listing-price-history-summary
```

Verified behaviors include:

- full 352-listing inventory synchronization in 25-item batches, with zero final consistency mismatches;
- zero-stock END, stock-return ACTIVATE, and second-pass auto-pause cleanup;
- preservation of manually inactive listings;
- manual price stabilization under eventual consistency;
- scheduled price round trip and correct handling of HTTP 202/PENDING;
- campaign scheduling surviving API restart;
- remote badge status reconciliation;
- retryable campaign finish handling;
- campaign bargain price insertion into history on ACTIVE/FINISHED, exclusion on DECLINED;
- distinct rolling and campaign-reference 30-day minima.

Production verification is evidence of intended behavior, not permission to rerun writes. Obtain explicit user direction before any new live test.

## 17. Handoff state

At document creation time:

- the latest relevant commit was `61daadf`;
- inventory automation used 25-item batches;
- the campaign price-history fix was committed as `db02a69`;
- the worktree had an untracked `tmp/` directory that must remain excluded from staging/commits;
- no automatic commit was requested or performed for these documentation files.

Before new work, always re-run `git status --short` and inspect recent commits because this section is a point-in-time handoff.
