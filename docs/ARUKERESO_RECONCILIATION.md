# Pricing Cockpit reconciliation before launch

`POST /arukereso/pricing/reconcile` accepts the same `{ items: [...] }`
JSON body and dedicated Bearer token as `/arukereso/pricing/sync`.
It executes SELECT queries only. It does not apply a pricing snapshot,
remove stale rows, create products, change settings, or generate a feed.
The endpoint must be deployed before using it on the deployed API.

## Verified 502-row reconciliation (2026-09-10)

The authoritative 502-row Cockpit payload was reconciled through this
endpoint against live Hub state using production matching semantics:

```text
502 payload rows, 502 valid, 0 duplicates, 0 invalid
436 Hub product matches + 66 unmatched
435 already stored + 1 matched-but-not-stored (1.081-410.0)
426 HAS_COMPETITOR / 76 NO_COMPETITOR / 0 partial
0 value mismatches across all stored rows
```

Breakdown:

```text
502 = 436 matched + 66 unmatched
436 matched = 429 CMS-covered + 7 Hub products outside current CMS
66 unmatched = no Hub product, no CMS row, no identifier/alias evidence
```

The single pending row `1.081-410.0` already has a correct Hub product,
current CMS row (`Identifier 10814100`), and EAN `4066529172433`; it only
lacks a pricing row and is imported automatically by the next genuinely new
sync. The 66 out-of-scope SKUs must never be auto-created; they need catalog
ownership review. The old "67 missing rows" figure is therefore fully
decomposed into 66 out-of-catalog-scope rows plus 1 pending-sync row.

## Real-sync validation (2026-09-10 23:49)

The real `syncCommerceHubPricingSnapshot` sender was executed manually:

```text
Report ID: RPT-E64421AA4E00F53D
Payload SKU: 502
STATUS: SKIPPED_ALREADY_SYNCED
```

This is idempotency success, not a failure: the same report plus the same
payload was already accepted, so no duplicate sync was performed and no
data was rewritten. Current V4 population therefore remains 428 until the
next new PriceKit report. On the next genuinely new snapshot, expect
pricing rows 435 -> 436, CMS-covered pricing / V4 population 428 -> 429,
including `1.081-410.0`. Do not claim 436 pricing rows exist before that
sync, do not bypass idempotency, and do not insert the row manually.

## MANUAL COMMAND REQUIRED: submit new payloads

In the existing Apps Script sender, immediately after it constructs the
current full payload and before its normal `UrlFetchApp.fetch` sync call,
call this helper with the existing sync URL, token, and payload variables.
For this diagnostic execution, return afterward so the normal sync is not
also invoked. Do not change the payload builder or filter out null metrics.

```javascript
function reconcileCockpitPayload(syncUrl, syncToken, currentPayload) {
  const url = syncUrl.replace(/\/pricing\/sync\/?$/, '/pricing/reconcile');
  if (url === syncUrl) throw new Error('Expected a /pricing/sync URL');
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + syncToken },
    payload: typeof currentPayload === 'string'
      ? currentPayload
      : JSON.stringify(currentPayload),
    muteHttpExceptions: true,
  });
  const report = JSON.parse(response.getContentText());
  console.log(JSON.stringify({ httpStatus: response.getResponseCode(), summary: report.summary }));
  // Log individually to avoid a single large log entry truncating the list.
  ['unmatched', 'invalidRows', 'duplicateRows', 'valueMismatches'].forEach(key => {
    (report[key] || []).forEach(row => console.log(key + ': ' + JSON.stringify(row)));
  });
  return report;
}
```

Retain the full outbound JSON and returned report privately for the audit.
Do not log or commit the token. Optional `name`/`productName` and
`ean`/`eanCode` fields enrich diagnostics but do not alter sync matching.

## Interpretation

- Real sync matches trimmed, case-sensitive `products.sku` exactly.
- Diagnostic candidate normalization never automatically links or imports.
- All duplicate occurrences are classified as duplicates and excluded from
  matching; invalid nonduplicate rows form the separate invalid partition.
- `validRows = matchedRows + unmatchedRows`.
- `payloadRows = validRows + invalidRows + duplicateRows`.
- `alreadyStoredPricingRows` counts matched rows already stored by SKU.
- `missingStoredPricingRows` counts valid submitted SKUs absent from storage.
- `missingStoredMatched` lists importable SKUs absent from storage.
- `storedRowsPendingRemoval` lists all stored SKUs absent from the valid
  matched input set. Nothing is removed by reconciliation. If the payload
  has validation/duplicate errors, real sync rejects it wholesale instead.
- Complete metrics derive `HAS_COMPETITOR`; all-null metrics derive
  `NO_COMPETITOR`; partial metrics derive `PARTIAL_MARKET_DATA`.
- Status labels such as `NO_OWN_PRICE` are not inputs to the Hub matcher.
  Whether Cockpit excludes them must be checked in its external builder.
- Ratios convert with `Math.round(ratio * 10000)`: `1.08` becomes `10800`.
- The full `unmatched` list includes candidate evidence, classification,
  recommended action, and CMS/Hub grouping. Candidates require review;
  punctuation-only similarity is not proof of canonical ownership.

## Launch evidence status

Source observations are 502 OWN rows: 426 OK and 76 NO_MARKET_DATA.
The verified Hub snapshot has 435 rows: 368 HAS_COMPETITOR and
67 NO_COMPETITOR. The 502-row request was reconciled row-for-row (see
"Verified 502-row reconciliation" above): the difference is 66
out-of-catalog-scope SKUs plus the single pending-sync row `1.081-410.0`.
A fresh full reconcile should be re-run after each production sync when
attributing new differences; aggregate counts alone are never sufficient.
