# Canonical Allegro listing-price policy

## Two different prices

The normal **HU listing marketplace price** is read from the offer's selling-mode
price (HU base marketplace or HU additional-marketplace price). It is persisted
in `listing_remote_states.price_minor` by ordinary and targeted reconciliation.

The **badge bargain price** is sent in `/sale/badges` and later read from
`badge.prices.bargain`. Badge market/reference price is a separate campaign
field too. Neither proves that Allegro changed the offer's normal selling-mode
price. Neither is used as a normal listing-price target by this policy.

## Before this change

| Path | Existing decision |
|---|---|
| HomePage expected price/mismatch | Active schedule (latest start) then desired base; no campaign input |
| Single `push-price` | Active DISCOUNT campaign disables schedule selection, but pushes base price |
| Bulk sync | Active DISCOUNT campaign accepts observed listing price; otherwise schedule then base |
| Scheduled processor | Blocks only currently active DISCOUNT campaigns; otherwise invokes single push |
| Price lock | Manual base edit stores `priceLocked=true`; price paths selected/ignored it inconsistently |
| Campaign preparation/submission | Stores/submits separate bargain price, application ID and validity; not a listing-price resolver |
| Campaign reconciliation | Reads application/badge and stores campaign status, bargain/reference prices; not normal listing price |
| Remote reconciliation | Observes HU selling-mode price; never substitutes campaign bargain price |
| Listing-sync price history | Separate promotional effective-price calculation uses local active campaign desired price, with marketplace price as base |
| Badge price history | Uses confirmed ACTIVE/FINISHED badge bargain price; independently maintained history semantics |

Relevant code is in `HomePage.tsx`, `allegro-auth.ts` (`push-price`, bulk sync,
`process-price-schedules`, `/sync`, badge helpers), and `index.ts` (campaign
preparation/submission/reconciliation and listing responses). Campaign and
historical price calculations are intentionally not rewritten by this change.

## One source of truth

`apps/api/src/allegro-price-policy.ts` is pure and has no I/O.
`allegro-price-policy-store.ts` reads desired, observed, schedule and campaign
inputs; it performs no writes. The same adapter/resolver serves listing API
responses, single price push, bulk price decisions and scheduled processing.

`GET /allegro/listings` supplies `pricePolicy` with:

- expected and observed normal marketplace price, in minor units;
- source: BASE, SCHEDULE, CAMPAIGN_POLICY, LOCKED_PRICE or UNKNOWN;
- comparison: MATCH, MISMATCH or UNAVAILABLE;
- explicit/manual and automated write permissions;
- reason, campaign IDs, winning schedule ID, evaluation time and next transition.

The web consumes this result. It no longer independently chooses a schedule or
campaign winner. Base edits and schedule changes reload the contract. At the
next reported boundary the page re-fetches server resolution; focus and existing
remote observation refreshes also reload it.

## Policy

1. Terminal FINISHED/DECLINED campaigns and campaigns strictly past `validTo`
   release ownership. Local PREPARED/SCHEDULED plans without a remote application
   are not submitted ownership. Other ambiguous/in-flight states are protected.
2. Every existing non-terminal campaign blocks price commands, including explicit
   single and bulk pushes. This deliberately extends protection beyond the old
   ACTIVE DISCOUNT-only guard to waiting, verification and uncertain submissions.
3. A PROCESSED application with an external application ID, recorded synchronization
   and ACTIVE/WAITING_FOR_PUBLICATION badge status is accepted campaign evidence.
   With no manual price lock, its currently observed normal listing price is
   accepted under CAMPAIGN_POLICY (the old bulk no-write policy). No bargain price
   is copied to the listing target.
4. A manual price lock remains explicit numeric intent. Its base target is shown
   as LOCKED_PRICE, even with an active schedule. If it differs during a known
   campaign, the mismatch remains visible but all price writes stay blocked.
5. Uncertain campaign evidence is UNKNOWN/UNAVAILABLE, never permission to write.
6. Outside campaign ownership: locked base, otherwise active schedule, otherwise
   base. Schedule start and end are inclusive UTC instants. Latest `validFrom`
   wins; equal start timestamps use ascending schedule ID for a stable tie-break.
7. A missing/invalid expected or observed price is UNAVAILABLE and blocks writes.
   Equality is never inferred from a missing observation.
8. Matching prices are NO-OPs. An explicit single/bulk action may apply a locked
   base outside campaigns. Automated scheduling cannot override a manual lock.

The lock represents manual base-price ownership; this policy additionally
enforces it at automated write decisions. It never changes the lock or the base
value. No resolver-driven desired-price or campaign rewrite exists.

## Scheduled processing

The processor checks the same policy before dispatch. Blocked schedules remain
unapplied; unchanged block messages are not rewritten every minute. It may
re-evaluate policy each scheduler tick, but sends no blocked price commands.
The single-price endpoint re-evaluates immediately before dispatch and receives
an explicit automation marker. If ownership changes between the two checks, a
blocked NO-OP is not marked applied. Non-winning overlapping starts are skipped.
After campaign ownership ends, schedule/base resolution resumes normally.
Already matching prices avoid remote writes and synthetic applied-price history.
When another schedule wins during an end transition, recorded applied price is
the canonical actual target, not the ending schedule's base-price assumption.

## Safety and remaining ambiguity

No campaign preparation/submission/reconciliation functions, application IDs,
badge IDs, bargain prices, validity windows, publication or stock commands are
added/changed by the resolver. No database migration or retrospective campaign
repair is required. API and web deployment are required; no deployment or live
mutation is part of implementation/testing.

For an unlocked listing under proven campaign policy, this integration cannot
independently prove a different correct normal marketplace price: accepting the
observed price is a no-write ownership policy, not a guarantee of commercial
correctness. Explicit locked intent can expose a real mismatch; unknown campaign
evidence stays unresolved. Campaign reconciliation freshness remains important.
Price-history semantics remain separate and do not define the listing target.
