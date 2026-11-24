# PR notes: discovery hub phase 3 (candidate decisions)

Stacked on discovery/phase2-staging-hub (PR #17). Local only: not
pushed, no PR created. This phase implements ONLY the first of the
program's three approval gates (candidate selection, hub decision
006 section 5). No image decisions, no manifests, no catalog writes.

## Summary

- Migration 003 adds one table, discovery_decisions: the append-only
  audit trail for review decisions. No existing table changes were
  needed; migration 002 already carries every decision column the
  endpoints write (review_status, hold_reason,
  duplicate_of_candidate_id on candidates; status, decided_by,
  decided_at on pairs).
- New restricted role beerpassport_discovery_reviewer
  (server/db/discovery-reviewer-role.sql +
  verify-discovery-reviewer.sql), mirroring the image-approval role's
  fail-closed structure. The API reaches it through
  DATABASE_URL_DISCOVERY_WRITE; unset, the decision endpoints answer
  503 and all browsing keeps working.
- Decision API (server/src/routes/discoveryDecisions.ts): candidate
  decide, pair decide, candidate decision history, batch decision
  audit. Every decision writes the status change and the audit row in
  one transaction through the reviewer client, with a status
  predicate on the update as the concurrency guard.
- Client: decision controls + decision history on the candidate
  detail page, a side-by-side pair review page, and a batch decision
  audit view.

## Decision vocabulary (where the docs name it)

- Candidate decisions: select, hold, reject, unhold (issues/001
  section 2 state machine and section 4 endpoints; decision 006
  section 5). Hold reasons: missing_brewery, origin_uncertain,
  market_fit_uncertain, duplicate_unresolved, image_unverified,
  metadata_incomplete, out_of_scope, other (issues/001 section 2);
  hold and reject require a reason, 'other' requires a note.
- Pair decisions: the endpoint accepts same / distinct; the audit row
  records the issues/001 section 2 action vocabulary mark_duplicate /
  mark_distinct. A 'same' decision supersedes the flagged candidate
  and sets its duplicate_of_candidate_id in the same transaction
  (NULL when the rival is external).
- Route shape: POST /admin-api/v1/discovery/candidates/:id/decide and
  POST /admin-api/v1/discovery/pairs/:id/decide with {decision, ...}
  in the body, carrying the docs' action strings above. The initial
  candidate state is 'pending' (the value Phase 2's migration 002
  actually uses; issues/001 calls it 'staged').
- Selection integrity per the tasking: hold is allowed with an
  unresolved pair; select is refused (409) while any pair involving
  the candidate is still pending, and a held candidate cannot be
  selected (unhold first). Rejected and superseded are final (409).

## Files changed

New:
- server/db/migrations/003-discovery-decisions.sql
- server/db/discovery-reviewer-role.sql
- server/db/verify-discovery-reviewer.sql
- server/scripts/test-discovery-roles.sh
- server/src/discoveryWriteDb.ts
- server/src/routes/discoveryDecisions.ts
- server/src/routes/discoveryDecisions.test.ts
- server/test/discoveryDecisions.integration.test.ts
- src/pages/DiscoveryPairPage.tsx (+ .test.tsx)
- src/pages/DiscoveryBatchDecisionsPage.tsx (+ .test.tsx)
- PR_NOTES_PHASE3.md

Modified:
- server/prisma/schema.prisma (discovery_decisions model + relations)
- server/src/routes/discovery.ts (review_status vocabulary extended
  to selected/held/rejected/superseded; richer pair rivals; new
  GET /discovery/pairs/:id)
- server/src/app.ts (discoveryWritePrisma dep + decisions router)
- server/src/readOnlyGuard.test.ts (allowed mutation files now
  exactly four: writeDb.ts, routes/imageApprovals.ts,
  discoveryWriteDb.ts, routes/discoveryDecisions.ts)
- src/api/types.ts (DiscoveryDecision, DiscoveryPairDetail,
  DiscoveryPairSide; DiscoveryPair gains decider fields)
- src/pages/DiscoveryCandidateDetailPage.tsx (+ .test.tsx rewritten
  for the decision controls and history)
- src/pages/DiscoveryBatchesPage.tsx ("Decision audit" link)
- src/App.tsx (pair + batch-decisions routes)
- src/viewer.css (decision + pair-compare styles, 44px coarse
  targets, single-column pair grid under 700px)
- docs/DISCOVERY_HUB_RUNBOOK.md (Phase 3 sections: application
  order, DATABASE_URL_DISCOVERY_WRITE, kill switch, verification,
  rollback)

## Verification (exact commands and results)

- Server types: `cd server && npx tsc --noEmit` — clean.
- Server unit tests: `cd server && npx jest` — 11 suites passed, 2
  live suites skipped; 96 tests passed, 7 skipped. The new
  discoveryDecisions.test.ts covers success paths, 404, both 409
  classes (already-final; select blocked by an unresolved pair),
  400/422 validation, 503 unconfigured, atomic transaction
  assertions, and UID absence from every payload.
- Disposable-DB role + flow test: `bash
  server/scripts/test-discovery-roles.sh` — exit 0. Disposable
  socket-only PG16; base schema + migrations 001, 002, 003 + role
  scripts; verify-discovery.sql AS the viewer: 8 PASS notices;
  verify-discovery-reviewer.sql AS the reviewer: 24 PASS notices;
  the RUN_DB_TESTS-guarded integration suite
  (server/test/discoveryDecisions.integration.test.ts): 4/4 passed
  (select persists with its audit row and the UID stays out of the
  response; hold validation 422 and held-select 409; select blocked
  by a pending pair, pair 'same' supersedes the flagged candidate,
  re-decide 409; batch audit lists decider names, never UIDs).
- Client tests: `CI=true npm test -- --watchAll=false` — 17 suites,
  43 tests, all passed (includes the new pair and batch-decisions
  suites and the rewritten candidate-detail suite).
- Client build: `CI=true npm run build` — compiles clean.
- Screenshots (CRA dev server + stubbed auth/API seeded with
  fixture-shaped discovery data; scaffolding in /tmp only), saved
  under qa-screenshots-discovery-phase3/ (not committed):
  desktop-candidate-detail.png, desktop-pair-review.png,
  desktop-batch-decisions.png, iphone-candidate-detail.png,
  iphone-pair-review.png, iphone-batch-decisions.png (1280x800 and
  390x844). All six visually checked: decision controls with the
  select-blocked explanation, side-by-side pair cards (stacked on
  mobile), and the audit table all render correctly.

## Deviations and notes

- Reviewer SELECT grants are table-level on the discovery tables
  plus beers and breweries (per the tasking); issues/001 section 3
  sketches a column-scoped SELECT for candidates. The UPDATE grants
  match section 3 exactly. Table-level SELECT exposes nothing the
  read-only viewer does not already expose.
- Candidate decisions do not write discovery_candidates.hold_note:
  that column is outside the section 3 UPDATE grant. The decision
  note is stored on the audit row, which is where the UI reads it.
- verify-readonly-role.sql is unmodified; after migration 003 its
  whitelist check reports exactly 4 "unexpected" privileges (the
  four discovery SELECT grants). Documented in the runbook as the
  expected result.
- The Phase 2 candidate-detail test asserting "no decision controls"
  was updated: this phase adds the controls.
- One cosmetic React act() warning in the pair page test (async
  continuation after a mocked post); non-failing and consistent with
  the existing suite's behavior.
- Nothing was pushed, merged, deployed, or applied to production or
  AWS. Production application order, the kill switch, verification,
  and rollback are in docs/DISCOVERY_HUB_RUNBOOK.md.
