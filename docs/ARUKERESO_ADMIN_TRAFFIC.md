# Árukereső admin edit traffic

## Traced call graph

### Per-product include/exclude/global-rule inheritance

`ArukeresoProductsPage.changeOverride(productId, inclusionMode)`
→ `PATCH /arukereso/feed/products/:productId/override`
→ SELECT channel + SELECT product ID
→ FORCE_INCLUDE/FORCE_EXCLUDE: upsert one `feed_product_overrides` row
→ INHERIT: delete that product's override (global rules apply again)
→ **previously, every successful save immediately called `loadProducts()`**
→ `GET /arukereso/feed/preview`
→ read all active Hub product ID/SKU/names, active source connections, overrides,
  pricing projection (~458), inventory SKU/stock (~5,900), catalog projection (~3,400)
→ evaluate rules, summarize, filter and paginate in memory.

This product-preview endpoint does **not** read raw catalog JSON. It is different
from the heavier output-preview endpoint below. The mutation itself does not read
full source tables and does **not** request feed generation. DELETE of an override
has the same small write scope; the current dropdown uses PATCH with INHERIT.

### Global settings

`ArukeresoSettingsPage.saveSettings()` uses an existing explicit Save:
→ `PATCH /arukereso/feed/settings`
→ read channel/settings, compare values, update channel settings/rule version
→ return authoritative settings directly (no full source read for ordinary rule edits).
Activating an inactive channel is different: the same endpoint calls
`coordinateCatalogFeedGeneration(... CHANNEL_ACTIVATION ...)` and must retain that
generation. Ordinary per-product overrides and global rule edits do not call it.

### Output preview and manual generation

`ArukeresoFeedPreviewPage.loadPreview()` on mount/filter/page/explicit refresh
→ `GET /arukereso/feed/output-preview`
→ `buildCatalogFeedOutput()` reads full catalog including `rawDataJson`, pricing,
  inventory and overrides; validates/evaluates the full model
→ filters, computes totals and slices the requested page.

`generateFeed()` → `POST /arukereso/feed/generate` → coordinated generation
→ explicit preview/latest-run/access-status reload. These are not timer loops.
Product-list save state is not a dependency of its load effect, so the repeated
read was the explicit per-save `loadProducts()`, not a duplicate effect.

## Implemented optimization

Writes remain immediate through the exact existing PATCH endpoint. Expensive
post-save product-preview reads are coalesced with a **2-second quiet period**
and **5-second maximum wait** while writes are settled. Reads wait for in-flight
writes; a slow request can therefore exceed the five-second bound. No mutation
is silently queued for later execution or cancelled on navigation.

- Each product shows saving / saved-awaiting-refresh / failed state.
- A failed choice remains visible and has an explicit per-product retry.
- Derived eligibility, summaries and counts remain the previous authoritative
  result until the shared preview refresh; the UI labels that interval explicitly.
- Per-product in-flight protection avoids out-of-order writes to the same product.
- Request/revision guards prevent older previews from overwriting newer edit state.
- A user-requested authoritative preview consumes a scheduled automatic reload.
- Preview failure does not retry mutations or launch an endless read loop.
- Cleanup cancels deferred reads only; accepted writes are not rolled back.

This is **refresh batching, not a bulk mutation API**. Distinct product writes
remain one PATCH each. No API implementation, rules, source matching, fingerprint,
generation timing, recipient, or Allegro workflow changed.

## Why full-scope pagination was not moved into SQL

Filtering by resulting feed state, reason, or PriceKit status happens after rule
evaluation. Summaries/counts span the full candidate population. Pagination before
evaluation would change membership, totals, or order. Output preview additionally
uses raw source fields and whole-output safety/uniqueness checks. A narrower
projection plus a second page-only raw-data fetch could be a separate optimization,
but requires preserving those checks and source-snapshot consistency. It was not
forced into this frontend change.

## Revision/generation model

`loadFeedSourceRevision()` hashes catalog, pricing, inventory and override inputs
plus channel settings. Automatic source-triggered generation checks an existing
completed matching revision before building the full output. Those revision reads
still cost traffic, but existing fingerprint/lease correctness is unchanged.
No admin generation calls were removed: per-product saves had **zero** before and
have **zero** afterward. Explicit Generate and channel activation remain intact.

## Typical-session estimate (not billing bytes)

Assume 20 include/exclude changes + 5 per-product inheritance/override changes,
in five rapid bursts, plus five output-preview interactions:

| Read/action | Before | After |
|---|---:|---:|
| Small per-product PATCH requests | 25 | 25 |
| Edit-triggered product previews/full projection evaluations | 25 | 5 |
| Output-preview raw source builds | 5 | 5 |
| Catalog full-scope reads (both previews) | 30 | 10 |
| Inventory full-scope projections | 30 | 10 |
| Pricing full-scope projections | 30 | 10 |
| Feed-item reads / generation coordination caused by these saves | 0 | 0 |

Excludes initial loads and any explicit Generate clicks. Edit-driven projection
reads fall **80%** in this example; raw-heavy output-preview reads do not shrink.
If C is a product-preview DB payload and O an output-preview payload, the estimate
is `25*C + 5*O` → `5*C + 5*O`. Overall byte reduction depends on C/O. Edits spaced
more than two seconds apart may not coalesce at all; no fixed billing reduction
is promised. Known row counts are reused; this task ran no production queries.

## Public feed follow-up

Public GET resolves the latest completed run and reads all persisted
`feed_run_items.resolved_item_json` (recent observation: ~446 rows / ~756 KB JSON),
then serializes CSV. It does not regenerate decisions from current sources.
The run stores artifact name/type/fingerprint, not a CSV body. No existing blob
artifact can simply be served in its place. A future immutable-run-keyed artifact
cache must respect channel deactivation, retention and cache size limits; it is
a separate worthwhile optimization, not implemented here.
