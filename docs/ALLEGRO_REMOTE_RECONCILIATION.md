# Targeted Allegro observation freshness

`POST /auth/allegro/reconcile-listings` accepts `{ "listingIds": ["uuid"] }`.
It is a Commerce Hub-authenticated local observation write, not an Allegro
mutation. One request accepts 1–10 explicit IDs. All IDs must belong to the
connected active Allegro account, configured environment, and `allegro-hu`;
scope validation completes before any offer GET. Partial/out-of-scope sets
are rejected rather than widened. Offers are read sequentially through the
existing Allegro fetch wrapper, with a ten-second timeout per GET.

`listing_remote_states` is upserted: publication, stock, HU marketplace
price/currency and observation timestamps. Desired targets, locks,
automation flags, accepted baselines and campaigns are not modified. A separate
guarded and atomically audited stale `stockAutoPaused` cleanup is now permitted
only with fresh ACTIVE/equal-stock observation and completed lifecycle evidence;
see `ALLEGRO_STOCK_POLICY.md`. Ambiguous ownership is retained. Unknown
fields remain unknown; failed reads (including 404) retain the previous snapshot
and return a per-listing error. No price, quantity, publication or badge command
is issued. Reconciliation does not run catalog import/adoption.

## Frontend

`utils/allegroMismatch.ts` is the central mismatch evaluator. It reports STOCK,
PRICE, PUBLICATION and REMOTE_DATA_UNAVAILABLE, with field and desired/remote
values. Listing-price resolution now consumes the canonical backend policy
described in `ALLEGRO_PRICE_POLICY.md`.
Raw observed stock is used for mismatch comparison; sellable quantity is separate.
Intentional-INACTIVE stock suppression is retained.
Locks never suppress a genuine stock mismatch. Unknown data is not presented as
a confirmed command failure. The row tooltip shows monetary values in HUF rather
than minor units; effective stock is the comparison value.

The row's **Távoli frissítés** action invokes only observation reconciliation
and a database-backed listing reload. Per-row errors remain visible until a
successful observation. The original push controls remain separate.

After a push, convergence performs a new authoritative observation before each
database reload. It checks only the originally pushed dimensions, stops on
convergence, and makes at most six attempts with five-second delays between
attempts (network time is additional). It never repeats the original mutation.
Requests are sequential chunks of at most ten listing IDs.

While the offers page is visible, background freshness checks run every minute:
at most five mismatch or ACTIVE/ACTIVATING auto-paused listings whose observation is at least five minutes old
are refreshed. Each listing is attempted at most once per five minutes, even
on failure. A page-level in-flight guard prevents overlap. The timer is removed
on unmount. There is no unattended full-catalog polling or new scheduler job.
Window focus still reloads local listing state. The freshness path covers
existing offers independently of new/renamed catalog discovery.

## Deployment and boundaries

Deploy API and web together; no database migration is required. A genuine mismatch,
manual inactive decision, stock lock, disabled automation or duplicate-SKU
automation guard is not bypassed by remote observation. Stale `stockAutoPaused`
is cleared only under the explicit ownership proof described above. Reconciliation
does not apply desired stock, price or publication commands.

## Inventory refresh: per-offer remote verification

The sliced inventory refresh decides stock and publication mutations only on a
remote state that was read from Allegro and persisted during the same
`/inventory-sync` request.

- `/inventory-sync` calls `/sync` with `partial: true`. Offers Allegro does not
  return are reported instead of failing the whole chunk, so the other offers of
  the chunk are still refreshed. Callers that omit `partial` keep the previous
  all-or-nothing `409`.
- `/sync` returns `verification: { verifiedOfferIds, unverified[] }`. An offer is
  verified only after its remote state was persisted. Reasons: `OFFER_NOT_RETURNED`,
  `MISSING_HU_MARKETPLACE`, `MISSING_SKU`; the caller adds `MISSING_OFFER_ID`,
  `SYNC_HTTP_ERROR`, `SYNC_RESPONSE_INVALID` and `NOT_VERIFIED`. A 2xx chunk
  response never implies that every requested offer was verified.
- A listing that is not verified gets no new stock or publication mutation. It is
  reported as `SKIP` / `REMOTE_UNVERIFIED` with the reason (diagnostics:
  `skipBreakdown.remoteUnverified`), never as unchanged. Its cached remote state
  is not used to close journal commands; an unresolved command stays in the
  journal and is reconciled by a later verified run with the same command id.
- Identity: `/sync` reports `verified: [{ offerId, listingId }]` with the listing
  it actually persisted. A row counts as verified only when that listing id equals
  the row's listing id. Inventory rows come from the session's platform account,
  and a listing id belongs to exactly one account and environment, so another
  listing's or account's refresh can never authorize a mutation. A missing,
  malformed or ambiguous identity is `VERIFICATION_IDENTITY_MISSING`, a different
  one `VERIFICATION_IDENTITY_MISMATCH`.
- Zero stock: an unverified listing with target stock 0 whose cached publication
  is `ACTIVE` or `ACTIVATING`, and that a verified run would end (not an explicit
  manual `INACTIVE` intent), is reported as `FAILED` (action `END`, reason
  `REMOTE_UNVERIFIED_ZERO_STOCK`, original reason in `verificationReason` and in
  the history message). Nothing is sent and no auto-pause marker changes; the
  batch and the run fail visibly. **This improves visibility only. It does not
  remove the overselling risk: the offer stays live until a later verified run
  ends it or someone acts on the failure.**
- Detail 404: in partial mode `/sync` looks up the product-offer detail before
  writing anything for an offer. An explicit HTTP 404 makes the offer
  `OFFER_NOT_FOUND` (unverified); nothing is persisted for it, so
  `last_synced_at` and the stored remote state stay untouched. This means
  "currently unavailable", never "deleted". Detail 401, 403, 429, 5xx, timeouts,
  transport errors and unreadable bodies keep the previous fallback to the status
  of the same successful bulk read and still verify the offer
  (`publicationSource: LIST`, diagnostic only): they say nothing about whether the
  offer exists, and stock comes from the bulk read. Non-partial callers keep the
  previous fallback for 404 as well.
- `listing_remote_states.last_synced_at` is refreshed for every offer `/sync`
  persists, whether or not a value changed. An old timestamp therefore means the
  offer was not persisted by `/sync`, not that nothing changed.
- LEGACY `/inventory-sync` execution performs no pre-decision refresh and is
  unchanged.

## Offer debug errors

`GET /auth/allegro/offer-debug/:offerId` answers an upstream 404 with 404
(`error: OFFER_NOT_FOUND`), an upstream 429 with 429 (validated `Retry-After`
forwarded) and any other upstream failure with 502 (`error: UPSTREAM_ERROR`).
Every error carries `upstreamStatus`, the documented Allegro error fields
(`allegroErrors`) and, for existing readers, `allegroStatus` and a bounded `body`.
The success response is unchanged.

## Stock command failures

Failed stock commands keep Allegro's own evidence in the journal metadata:
`failureKind` (`ALLEGRO_TASK_FAILED`: the PUT was accepted and the asynchronous
task failed, `httpStatus` 502 is synthetic; `ALLEGRO_COMMAND_REJECTED`: the PUT
itself was refused with the real HTTP status), `allegroTask` (task status,
message, field and error codes, bounded) or `allegroResponse` (bounded body of a
rejected PUT). Existing events keep their shape; readers ignore the new fields.

`GET /auth/allegro/stock-command-tasks/:commandId` returns the sanitized Allegro
task list for one stock command. Administrators only; the id must be a UUID and
must belong to a stock command this journal created for the connected account and
environment, otherwise `404`. It performs exactly one Allegro GET and no
mutation, retry or journal write.

OAuth note: like every Allegro route, it calls `refreshAllegroSessionIfNeeded()`.
When the access token expires within five minutes, the token is renewed; the
refresh token rotates and the new encrypted pair is written to
`platform_account_credentials`. This is the same session upkeep the schedulers
perform and the only database write the endpoint can cause.
