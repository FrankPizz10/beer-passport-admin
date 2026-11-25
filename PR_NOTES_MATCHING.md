### WS1 Matching: ranked catalog match suggestions for discovery candidates

New read-only endpoint, server only, no schema changes, no new
migrations, no client changes:

`GET /admin-api/v1/discovery/candidates/:id/match-suggestions`
(same auth and read-only viewer posture as the other discovery
reads) returns `{ candidate_id, suggestions: [{ beer_id, name,
brewery_name, abv, barcode, score, evidence }], exhaustive,
scanned }`. 404 when the candidate does not exist (sibling
`not_found` shape); 503 when no read client is configured. The
endpoint is advisory: it records nothing, selects nothing, and
never returns a chosen target. Accepting a suggestion remains the
reviewer's explicit audited review-intent action.

#### Design

- Pure scoring in `server/src/discoveryMatchCore.ts`; the route
  (`server/src/routes/discoveryMatch.ts`) is a thin adapter wired
  into app.ts alongside the other discovery routers.
- Evidence vocabulary (the fixed contract): `barcode_exact`,
  `name_exact`, `name_normalized`, `brewery_match`, `name_similar`,
  `token_overlap`. Brewery evidence alone never produces a
  suggestion (every product of a large brewery would otherwise
  "match" every staged candidate from it); each suggestion carries
  at least one name-side or barcode signal.
- Scoring (integer 0-100, deterministic, ties by beer_id):
  barcode_exact 95 (+3 name exact/normalized, +2 brewery);
  name_exact 86 (+10 brewery); name_normalized 80 (+10 brewery);
  name_similar 58 + 22 x similarity (+8 brewery); token_overlap
  (Jaccard >= 0.5 over name+brewery tokens) 34 + 26 x Jaccard
  (+8 brewery). Floor 45; at most 10 suggestions returned.
- Similarity is the max of the Levenshtein ratio (gate 0.8) and
  the character-bigram Dice coefficient (gate 0.6), or normalized
  containment. Levenshtein alone is too harsh on short names:
  "bud lite" -> "bud light" is 3 edits on 9 chars (0.67) although
  a human reads them as the same product; Dice scores that pair
  0.67 while the genuinely different "coors light" vs "bud light"
  stays at 0.56, below the gate (unit-tested both ways).
- Normalization: NFKD, diacritics stripped, lowercase,
  non-alphanumerics collapsed. Beer names drop ONE trailing
  generic token "beer"; style words (ale, lager, ipa) are never
  dropped. Brewery names drop trailing corporate tokens (brewing,
  brewery, company, co, inc, llc, corp, corporation, ltd)
  repeatedly. Nothing else is rewritten: staged "Budweiser" does
  NOT become "Anheuser-Busch", so the staged Bud Light earns
  name evidence only and no brewery_match is fabricated
  (unit-tested).

#### Bounds and cost

Staged queries, never an unbounded catalog load: (1) barcode
equality on `beers.upc` (the catalog barcode column; candidates
carry `barcode`), take 50; (2) case-insensitive exact name,
take 50; (3) one similarity scan: OR of `contains` predicates for
up to 6 distinctive tokens (>= 3 chars, longest first; 4 from the
name, 2 from the brewery) over beer and brewery names, ordered by
id, `take scanCap + 1`. Truncation (or no distinctive token to
scan with) sets `exhaustive=false`; `scanned` counts the distinct
beers actually scored. Default cap 500, overridable via
`DISCOVERY_MATCH_SCAN_CAP` (1-5000) and injectable in tests. At
the current ~5,894-beer catalog at most ~550 rows are scored per
request; at 10x the catalog the same bound holds (the cap binds
more often and `exhaustive=false` is reported more often; cost
grows with token-matching rows visited before the LIMIT, not with
catalog size alone). No new indexes: the equality stages use
existing access paths and the scan is LIMIT-bounded; a trigram
index is the documented follow-up only if this is ever measured
to be a bottleneck.

Benchmark (one-off local script, disposable socket-only PG16
seeded with 6,003 generated catalog beers, 30 timed iterations
after warmup, endpoint logic end to end):

| Case | p50 | p95 | scanned | exhaustive |
| --- | --- | --- | --- | --- |
| barcode exact | 9.4 ms | 18.2 ms | 1 | true |
| exact name (Bud Light) | 8.2 ms | 10.8 ms | 3 | true |
| fuzzy name (Bud Lite) | 7.2 ms | 8.0 ms | 3 | true |
| generic token (Pale Ale, ~1,450 token matches) | 23.9 ms | 27.3 ms | 500 (cap) | false |
| no match | 7.9 ms | 11.2 ms | 0 | true |

#### Tests

- `server/src/discoveryMatchCore.test.ts` (14 tests):
  normalization rules; Bud Light staged under "Budweiser" ranks
  catalog Bud Light (Anheuser-Busch) first with name_exact and NO
  brewery_match; "Bud Lite" / "Budlight" surface Bud Light via
  name_similar; Coors Light does not surface Bud Light; same name
  from two breweries both appear ordered by brewery evidence;
  barcode_exact beats a name-only match; name_normalized for
  punctuation/spacing variants; no-match yields empty; staged
  access honors the cap (exhaustive=false), barcode stage works
  without token support, missing candidate returns null.
- `server/src/routes/discoveryMatch.test.ts` (5 tests): response
  shape and ranking through the real app wiring, sibling 404
  shape, 401 without a token, exhaustive=false with a forced-low
  cap (router mounted directly), 503 with no read client.
- `server/test/discoveryMatch.integration.test.ts` +
  `server/scripts/test-discovery-match.sh`: disposable PG16,
  base schema + migrations 001-005 + viewer role; the suite seeds
  its own catalog and batch through the owner identity and drives
  the endpoint through the app on the read-only viewer client.
  ALL DISCOVERY MATCH CHECKS PASSED (5/5): Bud Light ranking,
  barcode-first, empty + exhaustive=true, 404, forced-cap
  exhaustive=false.
- Full verification on this tree: bare `npx jest` from server/
  exits 0 (295 passed, 37 skipped, 0 failed; DB suites skip
  without RUN_DB_TESTS), `npx tsc --noEmit` clean.

#### Docs

- `docs/DISCOVERY_REVIEW_API_CONTRACT.md`: new section A3 with
  the endpoint, response shape, evidence vocabulary, refusal
  codes, and the not-exhaustive semantics, marked PROPOSED until
  this PR merges.
- `docs/DISCOVERY_HUB_RUNBOOK.md`: the endpoint added to the
  read-only hub API inventory with its bounds.

#### Deviations and blockers

- The catalog barcode column is `beers.upc` (candidates carry
  `barcode`); the response reports it as `barcode`, per the fixed
  contract.
- No schema changes and no new indexes were needed; none made.
- No blockers. The parallel UI workstream can build against the
  contract in A3 as-is.
