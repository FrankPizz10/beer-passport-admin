### Image fetch rate limit: configurable limit + 429 retry guidance

Workstream 3 (images and rate limits) of the fast-review program.
Server + docs only. No client changes, no production setting is
changed by this PR, no AWS, no migrations.

#### Current behavior, as found in the code

`server/src/routes/discoveryImages.ts` enforced a hard-coded
`IMAGE_FETCH_RATE_LIMIT = 30` per reviewer per rolling hour
(`IMAGE_FETCH_RATE_WINDOW_MS`, 60 minutes). Mechanics, verified by
reading the handler:

- The check counts `discovery_image_fetches` rows for the reviewer
  (`fetched_by`, or `fetched_by_uid` when no user row is resolved)
  with `fetched_at` inside the window, and refuses at >= 30.
- The check runs BEFORE the fetch. A refused attempt reaches
  neither the fetcher nor the table.
- Every attempt that passes the check and reaches the fetcher
  writes exactly one fetches row, on success AND on failure
  (the outcome field carries the failure class). So fetch-level
  failures consume budget; that part of the standing description
  is accurate.
- Pre-flight refusals do NOT consume budget: the 503s (write path
  unconfigured, `DISCOVERY_IMAGE_STORE` unset), the 404 (unknown
  candidate), and the 422s (no staged URL, credentialed URL) are
  all thrown before the count query and write no row. In
  particular, the production episode where every fetch failed
  with "DISCOVERY_IMAGE_STORE is unset" burned zero reviewer
  budget; reviewers were blocked by the missing store, not by
  the limiter.
- The old 429 carried only a prose message ("Try again later"):
  no machine-readable retry guidance.

#### What changed

1. **Configurable limit** (`discoveryImages.ts`).
   `DISCOVERY_IMAGE_FETCH_RATE_LIMIT` is parsed once at module
   load (= server start) by the exported
   `parseImageFetchRateLimit`:
   - unset or empty: the default 30 (identical behavior to today);
   - a positive integer: honored;
   - above the hard maximum of 600: clamped to 600, with a
     one-time startup `console.warn`;
   - non-numeric, fractional, zero, or negative: invalid, falls
     back to the default 30, with a one-time startup warning
     (never a silent change);
   - a valid env value logs the effective limit once at startup.
   Changing the value requires an API process restart, which the
   runbook now states. `IMAGE_FETCH_RATE_LIMIT` remains exported
   and now holds the effective limit; enforcement, window, and
   per-reviewer scope are untouched.
2. **429 retry guidance.** When the limit is hit, the handler
   reads the oldest counted attempt and computes
   `retry_after_seconds` = time until that attempt leaves the
   rolling window (minimum 1; a full-window fallback covers the
   practically impossible no-row case). `errors.ts` gained an
   optional `details` bag on `ApiError`: the 429 body is now
   `{error: {code: 'too_many_requests', message,
   retry_after_seconds}}` and `sendError` mirrors the value in
   the standard `Retry-After` header. The message text is
   unchanged, and errors without details serialize exactly as
   before, so the existing error shape stays compatible. The
   parallel UI workstream renders `retry_after_seconds`; the
   field is documented in
   `docs/DISCOVERY_REVIEW_API_CONTRACT.md`.
3. **Docs.** The contract doc's rate-limit paragraph and the
   runbook's rate-limit bullet now describe the counting rules,
   the env var, the clamp/warning behavior, and the recommended
   production value below.

#### Failure-counting analysis (no semantic change made)

The one arguably-wrong case, a server-configuration failure
burning reviewer budget, does not exist in this code: the
store-unset 503 precedes the count and writes no row (above).
Fetch-level failures (dns_blocked, unreachable, timeout,
not_image, too_large, magic_mismatch, redirect_blocked,
downgrade_blocked) do count, and this PR deliberately preserves
that:

- Those outcomes are properties of the origin URL and are
  deterministic per candidate in the common case; not counting
  them would let a reviewer (or a buggy client loop) hammer the
  restricted fetcher, which is a privileged network egress path,
  at unlimited rate against third-party origins.
- The audit invariant "fetches rows = attempts" stays trivially
  true, which the hash-bound decision flow relies on.
- The throughput problem is real but is a limit-size problem,
  not a semantics problem; the configurable limit fixes it
  without weakening the anti-abuse bound.

Related edge, noted and NOT fixed here (pre-existing, out of
scope): if `store.put` throws after a successful fetch (e.g.
disk failure), the request 500s and no fetches row is written,
so that attempt is neither counted nor audited. Flagged for a
future hardening pass.

#### Queued fetching: evaluated, not implemented

A server-side queue (POST accepts a job, a drainer fetches
within budget, the UI polls for previews) was the alternative
considered. It would smooth bulk passes and centralize retries,
but:

- A durable queue needs storage. A jobs table means a
  server-repository Prisma migration plus admin-mirror
  coordination, the heavyweight path this program avoids
  without need. An in-memory queue loses jobs on restart and
  breaks if the API ever runs more than one instance.
- It adds an always-on worker to a deliberately simple API,
  plus a new UI contract (job states, polling) in the parallel
  workstream, plus murkier failure semantics (job failure vs
  fetch outcome), and the reviewer-to-fetch audit link would
  hold by design effort instead of by construction as today.
- The actual bottleneck is a fixed, known, small number (216
  image-bearing candidates, below). A configuration bump
  removes it with zero new moving parts.

Verdict: not now. Revisit if image-bearing batches grow by an
order of magnitude or several reviewers fetch concurrently.

#### Recommended production configuration

The domestic batch has 6,817 candidates but only **216 have
image URLs** (staging analysis); the other 6,601 never consume
fetch budget, and image decisions themselves are not
rate-limited. Stored previews are reused, so the expected total
fetch attempts for the whole batch is ~216 plus genuine
refetches (failed origins, missing stored objects).

- At 30/hour: 216 attempts need 7.2 rolling windows, so a
  dedicated image pass is spread over 7+ hours of window time
  before the last fetch is even allowed. Fetching is the
  bottleneck.
- At 120/hour: ~1.8 windows; still pacing a focused session.
- At **300/hour (recommended)**: the full 216 fit in ONE window
  with 84 spare attempts (~39% headroom) for refetches. Past
  ~216 the limiter stops binding and human decision time is
  the bottleneck, which is the goal.
- 600 (the max) would work but buys nothing for this batch
  size and only widens the burst a single reviewer can send at
  third-party origin hosts.

Exact deployment step (operator, outside this PR): after this
PR is merged and the API is deployed as usual, set
`DISCOVERY_IMAGE_FETCH_RATE_LIMIT=300` in the admin API
service environment (the same configuration that carries
`DATABASE_URL_DISCOVERY_WRITE` and `DISCOVERY_IMAGE_STORE`)
and restart the API process; confirm the one-time startup log
line "[discovery-images] Image fetch rate limit configured to
300 per reviewer per hour via
DISCOVERY_IMAGE_FETCH_RATE_LIMIT." This PR by itself changes
no production setting: with the variable unset, behavior is
identical to today.

#### Safeguards preserved

SSRF restrictions, DNS validation and address pinning, redirect
rules, byte caps, timeouts, the fetches-row audit, hash-bound
decisions, and the per-reviewer scope are all untouched code
paths; the only edits in the fetch handler are the limit source
and the 429 payload. The existing discoveryImages suite (which
covers those paths) is green.

#### Files

- `server/src/routes/discoveryImages.ts`: config parsing
  (exported for tests), effective-limit constant, startup
  logging, `retry_after_seconds` on the 429.
- `server/src/errors.ts`: optional `ApiError.details`, merged
  into the error body; `Retry-After` header when
  `retry_after_seconds` is present.
- `server/src/routes/discoveryImagesRateLimit.test.ts` (new):
  parser unit tests (unset, empty, valid, whitespace, at-max,
  over-max clamp, garbage, fractional, zero, negative) and
  enforcement tests at a configured limit of 3 (three attempts
  proceed, the fourth is 429 with a sane
  `retry_after_seconds` and matching header; failure outcomes
  consume budget).
- `server/src/routes/discoveryImages.test.ts`: the Prisma stub
  gained `findFirst` (the real client has it; the 429 path now
  reads the oldest counted row), and the existing 429 test now
  also asserts the guidance field and header.
- `docs/DISCOVERY_REVIEW_API_CONTRACT.md`,
  `docs/DISCOVERY_HUB_RUNBOOK.md`: contract and operator docs.

#### Test report

- `npx jest src/routes/discoveryImagesRateLimit.test.ts
  src/routes/discoveryImages.test.ts`: 29 passed.
- Bare `npx jest` from `server/`: exit 0, 283 passed / 32
  skipped / 0 failed (21 suites passed, 5 skipped).
- `npx tsc --noEmit`: clean.
