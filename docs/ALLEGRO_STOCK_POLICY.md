# Allegro stock equality and pause ownership

## Before this change: paths and inputs

| Path | Stock / lifecycle inputs and previous semantics |
|---|---|
| `allegroMismatch.ts`, HomePage | Desired stock versus synthetic effective stock: ENDED/INACTIVE **or auto-paused** became zero. Desired INACTIVE + remote ENDED/INACTIVE suppressed quantity comparison. Locks/automation did not suppress real differences. |
| Bulk `/sync-selected` | Desired stock versus raw persisted remote quantity, with intentional-INACTIVE suppression. No source stock input. |
| Single `/push-stock/:listingId` | Explicitly pushed desired stock; selected lock but did not overwrite it. No source-stock or sellability transform. |
| `resolveAllegroInventoryRows` | Source stock by SKU; missing source becomes zero; locked target is desired stock. Reads raw remote stock, desired publication and auto-pause. Counts all offers for the SKU/account/marketplace. |
| `applyAllegroDesiredStock` | Skips locked and duplicate rows; otherwise applies source target to desired stock, with missing-SKU zero and unknown-remote safeguards. |
| `syncAllegroInventoryRows` | Raw remote versus target stock. Lock/duplicate guards precede lifecycle; zero target ENDs publication; positive stock can reactivate only after ownership logic. `autoStockSync` previously filtered upstream only. |
| Stock lock / manual desired stock | Desired-stock edit locks it; positive edit of an auto-paused listing explicitly takes control, sets desired ACTIVE and clears pause. Lock toggle itself does not clear ownership. |
| Manual desired status | Sets ACTIVE/INACTIVE and clears pause: explicit user takeover. |
| Targeted reconciliation | GETs exact managed offers; upserts remote observations only. Did not inspect pause ownership. |
| Discard | Locked desired stock preserved. Unlocked stock comes from active source (missing SKU zero), otherwise auto-pause zero or remote/desired fallback. Does not clear pause. |
| Listing sync/import | Upserts raw remote fields. Initializes desired state only if absent; initial pause defaults false, auto-stock true. Remote ENDED alone is not proof of why it ended. |
| Accepted state | Separate accepted observation baseline; not the desired stock target or an ownership claim. |

Core files: `apps/api/src/allegro-inventory-sync.ts`, `allegro-auth.ts`,
`platform-automation.ts`, `index.ts`, `allegro-discard.ts`, and
`apps/web/src/{utils/allegroMismatch.ts,pages/HomePage.tsx}`.

## Canonical concepts

`apps/api/src/allegro-stock-policy.ts` separates:

1. **Observed quantity:** what Allegro reports, including positive quantities on
   ENDED listings. Never rewritten as zero for comparison.
2. **Desired quantity:** existing user/system intent. Source data is not an input
   to mismatch evaluation; inventory automation remains its separate owner.
3. **Sellable quantity:** observed quantity for ACTIVE; zero for ENDED/INACTIVE/
   ACTIVATING; unknown for unknown publication. Auto-pause does not zero it.
4. **Pause ownership:** a lifecycle flag and evidence, not quantity or sellability.

The listing API exposes `stockPolicy`. UI and bulk comparison use desired versus
raw observed quantity. Inventory/single push use the same raw-equality helper.
Intentional INACTIVE + remote ENDED/INACTIVE suppresses quantity action because
publication has intentionally removed sellability; retained remote quantity is
neither a request to reactivate nor a reason to push zero. The raw value remains
visible. Desired ACTIVE + ENDED + equal quantity yields publication mismatch only.
If both quantity and publication are wrong, both reasons are retained.

Locks, disabled auto-stock and duplicate SKUs annotate mismatches; they do not
hide genuine quantity differences or authorize automatic correction.

## Ownership writers and cleanup

Inventory END still claims `stockAutoPaused=true` on accepted 202 or successful
completion. Manual desired-status edits clear it; a deliberate positive manual
stock edit takes over an existing pause. Lock toggles and generic discard preserve
it. Ordinary import never claims ownership from ENDED alone.

Two old legacy branches that adopted unowned ENDED/INACTIVE offers are removed.
Explicit desired INACTIVE without ownership remains protected even while its
remote publication is still ACTIVE. Other unowned ended offers are unresolved,
not automatically adopted/reactivated.

Automatic cleanup no longer clears from cached ACTIVE or ACTIVATE task success
alone. Task success retains the flag until observation-based verification.
The ACTIVE inventory pass delegates to the same targeted reconciliation path.

### Guarded reconciliation exception

`POST /auth/allegro/reconcile-listings` still performs only Allegro GETs.
It captures an exact desired-state snapshot **before** the GET, persists the
observation, and separately checks `allegro-stock-ownership.ts`.

Clearing requires all of:

- flag already true (never adoption);
- fresh authoritative publication ACTIVE;
- desired publication ACTIVE, positive desired stock, observed quantity equal;
- no stock lock, auto-stock enabled, exactly one offer for the SKU scope;
- latest relevant inventory SYNC event is SUCCESS for ACTIVATE or a completed
  reactivation confirmation; PENDING/in-progress, failure, missing or unknown
  evidence blocks cleanup;
- completion evidence is at least as recent as the desired-state intent stamp,
  so an old successful activation cannot authorize cleanup of a newer transition;
- same complete desired-state snapshot at write time;
- same latest evidence event and fresh persisted observation at write time;
- duplicate/lock/automation guards still hold;
- no RUNNING wrapper for the active inventory connection.

One atomic SQL statement clears **only `stock_auto_paused`** and inserts an
`OWNERSHIP` audit event with evidence-event ID and observation timestamp. Desired
targets, locks, publication intent, prices and campaign fields are not updated.
No audit event is inserted if the compare-and-set fails. Existing desired audit
stamps are preserved; ownership has its own event.

Informational OWNERSHIP_UNRESOLVED/OWNERSHIP_RECONCILIATION_REQUIRED results do not
supersede transition evidence. Unknown event statuses do block cleanup. A cleanup
error does not invalidate an otherwise successful observation; it returns an
unresolved ownership result and retains the flag.

The RUNNING guard deliberately defers cleanup during scheduled inventory work.
After that run ends, a targeted/manual or foreground freshness pass can clean it.
Pending history is closed by the existing inventory pending-event reconciler;
this observer does not manufacture terminal command success.

## UI and bounded freshness

The main quantity field and mismatch tooltip show actual observed Allegro stock.
Sellable stock is separate. STOCK reasons include lock, auto-stock, duplicate and
pause metadata. Unresolved ownership is shown separately even when quantity is
matching; it does not manufacture a STOCK mismatch.

Existing foreground limits remain: five stale candidates/minute, per-listing
five-minute cooldown, sequential targeted batches of at most ten. ACTIVE or
ACTIVATING auto-paused rows are now candidates even without a quantity mismatch.
There is no full-catalog polling job. Manual refresh is also available for paused
rows. Desired-stock/lock/status edits reload the derived contract.

## Safety and remaining ambiguity

`autoStockSync=false` is now checked inside both apply and sync in addition to the
existing upstream selection. Lock and duplicate guards remain. Explicit manual
stock pushing remains separate from inventory automation; equality is a NO-OP
and unavailable observation blocks a quantity command.

No migration or production repair is included. Deploy API and web. The read-only
production investigation found no currently persisted ACTIVE/ACTIVATING offers
with `stockAutoPaused=true`; there is no evidence for a blanket one-time reset.

Missing/expired history, externally changed publication, failed END before the
ownership claim, disabled/locked/duplicate listings, running jobs and concurrent
intent changes remain unresolved rather than guessed. In particular, a remote
`endedBy=USER` cannot distinguish Commerce Hub's END from human action. Explicit
manual takeover remains the existing separate user action.
