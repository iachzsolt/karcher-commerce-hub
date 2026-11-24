# Publication ownership – operator visibility and resolution (design)

Status: design only, nothing implemented. Builds on commit `03067ee`
(durable publication intent, evidence-based auto-pause ownership).

## Goal

Make the listings that automation deliberately leaves undecided visible in
Commerce Hub, explain them in plain language, and let an administrator
resolve them one at a time without ever replaying an Allegro command or
weakening the ownership guarantees.

## States to surface

All states are derived from the database at read time (desired state,
latest `PUBLICATION_OPERATION` journal entry, remote observation). No new
stored status column, so the view cannot drift from what automation sees.

| Attention state | Detection | Meaning | Risk |
|---|---|---|---|
| `COMMAND_IN_FLIGHT` | pending automatic END, latest command of this intent unresolved, younger than 15 min | Allegro is processing our END | info |
| `PUBLICATION_COMMAND_UNRESOLVED` | latest command unresolved and older than 15 min; sub-reason from `diagnostic.taskState` (`TASK_NOT_FOUND`, `DISPATCH_AMBIGUOUS`, `RATE_LIMITED`, …) | the command's outcome is unknown; automation will not send anything for this listing | high if the offer is ACTIVE at zero target (oversell), otherwise medium |
| `REMOTE_STATE_ONLY` | pending automatic END, latest command of this intent SUCCESS with `commandEvidence = REMOTE_STATE_ONLY` | the offer is ended, but Allegro did not confirm that our command ended it | medium if stock is back (lost sales), else low |
| `OWNERSHIP_UNRESOLVED` (no evidence) | pending automatic END, remote ENDED/INACTIVE, no command of this intent (or FAILED) | ended by someone or something else | medium if stock is back |
| `END_FAILED` | pending automatic END, latest command FAILED, remote ACTIVE | Allegro refused the END | high at zero target |
| `UNRESOLVED_INACTIVE` (legacy) | desired INACTIVE, not auto-paused, no intent | pre-0029 or cleared by an unaware writer; treated as manual | low (backlog) |

Priority order in the UI: zero target with ACTIVE offer > positive stock with
ended offer > the rest by age.

## Read-only API (phase 1)

`GET /allegro/publication-attention` (session account and environment only)

- One SQL query like postflight B2 with, per listing: SKU, offer id, product
  name, attention state, risk, intent (source, id, time), latest command
  (id, action, status, `intentId` match, `commandEvidence`, `taskState`, age,
  sanitized Allegro errors), remote status and observation time, desired
  stock, latest inventory target stock, lock / duplicate / campaign flags,
  and the allowed actions (see the matrix below).
- `GET /allegro/publication-attention/summary` returns counts per state and
  risk for a header badge.
- Inventory SYNC events additionally store the skip `reason`
  (`NO_AUTOMATIC_END_EVIDENCE`, …) in their metadata; today only the status
  is kept.

## UI (phase 1)

- Header badge "Publikációs döntés szükséges (N)", red when a high-risk item
  exists.
- A "Publikációs ellenőrzés" panel (or a filter on the listings page):
  one row per listing with state, risk, offer status and age, sorted by
  priority.
- Detail drawer with a timeline from the journal: intent changes (who, when,
  MANUAL/AUTOMATIC), each command with its id, task diagnostics and
  evidence, ownership events, remote observations. A Hungarian explanation of
  the state and of what automation will and will not do next.
- Labels in `AllegroHistoryPage` for the new statuses
  (`OWNERSHIP_UNRESOLVED`, `PUBLICATION_COMMAND_UNRESOLVED`,
  `PUBLICATION_INTENT_CHANGED`) and for `commandEvidence`.

## Operator actions (phases 2–4)

| # | Action | What it does | Allegro effect |
|---|---|---|---|
| A1 | Re-check (`Állapot újraellenőrzése`) | GET offer + GET task for the latest command; persists the observation and a `PUBLICATION_CHECK` event | read-only |
| A2 | Keep inactive (`Kézi döntés: maradjon inaktív`) | existing `savePublicationIntent(INACTIVE)`: new MANUAL intent; automation never reactivates it | none |
| A3 | Activate (`Kézi döntés: legyen aktív`) | `savePublicationIntent(ACTIVE)`, then the existing guarded push-status | one ACTIVATE through the guarded executor |
| A4 | Accept as automatic pause (`Automatikus szünetként elfogadom`) | new CAS: sets `stock_auto_paused` for the current AUTOMATIC intent; OWNERSHIP audit `OPERATOR_ATTESTED` with operator and reason; automation may reactivate it when stock returns | none |
| A5 | Close unresolved command (`Lezáratlan parancs lezárása`) | journals terminal `ABANDONED_BY_OPERATOR` for exactly that command id; the command is never resent; afterwards normal operations may create a new command | none |

Allowed actions per state:

| State | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|
| `COMMAND_IN_FLIGHT` | ✓ | – | – | – | – |
| `PUBLICATION_COMMAND_UNRESOLVED` | ✓ | ✓ | – (blocked while unresolved) | – | ✓ (conditions below) |
| `REMOTE_STATE_ONLY` | ✓ | ✓ | ✓ | ✓ | – |
| `OWNERSHIP_UNRESOLVED` | ✓ | ✓ | ✓ | ✓ | – |
| `END_FAILED` | ✓ | ✓ | ✓ | – | – |
| `UNRESOLVED_INACTIVE` | ✓ | ✓ | ✓ | – | – |

## Safety rules for every write action

1. Administrators only (`COMMERCE_HUB_ADMIN_EMAILS`), and the operator's
   identity is stored in the audit event. This depends on the open item
   "Add user identity to write audit events" in DEPLOYMENT.md.
2. Optimistic concurrency: the request carries the `publication_intent_id`
   and the latest command id the operator saw. The server applies the
   change as one CAS statement; on mismatch it returns 409 with the current
   state ("Az állapot közben megváltozott").
3. A4 and A5 require a remote observation no older than 15 minutes; the
   dialog runs A1 first.
4. A5 additionally requires: command age ≥ 60 minutes, at least two task
   lookups at least 15 minutes apart returning `TASK_NOT_FOUND` (or an
   ambiguous dispatch that Allegro never registered), and the listing's
   publication lease not held. Rationale: a command Allegro never received
   cannot execute later; one it did receive could, so A5 is not offered for
   `TASK_PENDING`.
5. Mandatory reason text; the dialog states exactly what happens and that
   no command is sent (A2, A4, A5) or which single command is sent (A3).
6. Single listing per action; no bulk operations in the first version
   (bulk A2 could follow later).
7. Stock lock, duplicate SKU, campaign and write-safety guards
   (`assertAllegroWriteSafety`) stay in force; A3 goes through the existing
   guarded executor only.
8. Never replay a command id; never generate a replacement command for an
   unresolved one.
9. Every action writes one audit event (`OPERATOR_DECISION`) with the state
   before and after.

## Phases

1. Read-only: status labels, SYNC `reason` metadata, attention endpoint,
   badge, panel, timeline. No writes.
2. A1 re-check (read-only Allegro GETs; local observation only).
3. A2 and A3 surfaced in the panel (existing writers).
4. A4 and A5: new writers with PGlite tests and real two-session
   concurrency tests (see 0029-concurrency-analysis.md). Separate approval.

## Open questions

- Should A4 exist at all, or should a `REMOTE_STATE_ONLY` listing always
  become a manual decision (A2/A3)?
- A5 thresholds: how long does Allegro keep publication command tasks, and
  how quickly is an accepted command processed in practice?
- Should `UNRESOLVED_INACTIVE` legacy listings be reviewed once in bulk
  (as manual decisions) to empty the backlog?
