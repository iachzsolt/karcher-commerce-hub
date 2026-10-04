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
