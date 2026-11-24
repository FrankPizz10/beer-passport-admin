# Admin UI redesign: PR notes

Branch: `ui/admin-redesign` (from admin master 4936ee4, the merge of PR #26).
Scope: client UI, shared styles/components, docs, and UI tests only. Nothing
under `server/` was touched; no Prisma or migration changes; no new
dependencies; no production writes of any kind (all test and screenshot data
is mocked fixtures).

## Design approach

- One design-token layer appended to the existing stylesheet
  (`src/viewer.css`): `--bp-*` CSS custom properties for color, spacing,
  type scale, and radius, plus shared primitives (`.btn`, `.btn-primary`,
  `.btn-danger`, `.status-chip`, `.progress-track`, `.review-section`,
  `.field-compare`, `.callout`, `.help-tip`, `.hash-block`). No CSS
  framework, no second style system; catalog, users, and accounts pages
  inherit the shell improvements without deep restyles.
- The admin shell gains a coherent identity: dark header with an amber
  accent and a "BP" brand badge, route-derived breadcrumbs, and a sidebar
  active state with an accent bar. The existing nav toggle is kept and
  gains `aria-expanded`; the sidebar collapses compactly at phone widths
  and the shell clips horizontal overflow at 390px.
- New shared components: `StatusChip` (the label is always text, never
  color alone) and `HelpTip` (a "?" button, `aria-label` "Help: <topic>",
  popover on hover, keyboard focus, and click/tap pin; Escape closes and
  returns focus to the button; closes on outside focus/pointer).

## What changed, by deliverable

1. **Shell and batches landing.** `AdminLayout` brand title and
   breadcrumbs. `DiscoveryBatchesPage`: page lede stating counts are the
   API's real totals for the full staged set (never a sample), batch
   status chip, review progress bar (`role="progressbar"` with the legacy
   "{decided}/{total} reviewed ({percent}%)" label text preserved),
   review-status counts as labeled chips, and "Build import manifest" as
   the primary action with a manifest-hash help tip. Manifests list and
   detail and the candidates list render statuses as chips; the manifest
   SHA-256 renders in a wrapping hash block.
2. **Candidate review flow.** `DiscoveryCandidateDetailPage` is
   restructured into five numbered sections: (1) Staged beer and source
   evidence; (2) Review intent; (3) Image review; (4) Candidate decision;
   (5) What happens next. The page lede and section copy state that each
   step is a separate record: saving an intent does not select, an image
   approval does not publish or import, and manifest approval is a later
   hash-bound gate. All original field labels, values, decision history,
   and duplicate-pair rendering are preserved.
3. **Responsive field comparison.** The cramped seven-field table in
   `DiscoveryCandidateFieldReview` is replaced by a `.field-compare`
   layout: staged vs proposed side by side on wide screens, stacked with
   visible per-cell labels at 760px and below; long names and URLs wrap.
   A validation summary region (`aria-live`) lists every field issue;
   field ids, per-field issue ids, and visually hidden "Proposed X"
   labels are preserved. The mode picker is a pair of described option
   cards (descriptions placed so the radio accessible names stay exactly
   "New beer" / "Image only for an existing beer").
4. **HelpTip placements.** Review intent, image-only target, image
   decision, hold reasons, candidate selection, manifest hash (batches,
   candidate page, manifest detail), and import. Essential instructions
   remain as normal text; tips are supplementary.
5. **Image-store unavailable state.** `DiscoveryImageReviewPanel` detects
   the `DISCOVERY_IMAGE_STORE` unset error (from the fetch POST and from
   preview loads) and shows a dedicated `role="alert"` callout: preview
   fetching is unavailable because the server-side image store is not
   configured, an administrator must configure it, and reviewers must not
   fetch origin URLs themselves. Staged provenance and any saved intent
   stay visible; approve/reject remain disabled until a stored preview
   exists (the pre-existing gate). Other API errors still show the actual
   error message. No preview is ever faked and the origin URL is never
   loaded as an image.
6. **Stale-copy removal.** See the list below. Docs updated to match:
   `docs/DISCOVERY_REVIEW_API_CONTRACT.md` (A2, B1, B2 marked live) and
   `docs/DISCOVERY_REVIEW_INTENT_API.md` ("This contract is live in
   production"). Stale comments in `src/api/discoveryReview.ts` updated;
   `NotYetAvailableError` remains only for the genuinely unsupported
   image_url change.
7. **Target search quality.** Results show name, #id, and brewery, with
   an "Exact name match" vs "Name variant" badge (name equality with the
   query, case-insensitive). The existing explicit confirmation step is
   unchanged, and the saved target from the loaded intent is displayed in
   the saved-intent banner and the confirmed-target panel.

## Stale copy removed (user-facing strings)

- FieldReview note: "implemented locally and not yet deployed; until
  deployment, loading and saving an intent fail with the server's error"
  (replaced with accurate workflow help).
- ExistingBeerPanel gate note claiming image-only support was "pending
  backend review and deployment" (replaced with the manifest approval and
  import gate description).
- ManifestComposition "Pending backend support" badge and the paragraph
  "Image-only import is pending backend review and deployment ... locally
  but not yet deployed" (replaced with the "Image only" chip and accurate
  manifest copy).
- The image_url limitation copy (audited refetch/invalidation design;
  an approved hash never approves a new URL) is accurate and stays.

## Behavior preserved

- ABV hard range 0 to 100, the >2 decimal place precision warning, and
  values are never auto-rounded (the staged 3.2123353678124 fixture shows
  in full in the screenshots).
- Intent save is distinct from the select decision; image decisions bind
  to the displayed fetch; previews render stored bytes only; the origin
  URL is text-only provenance.
- The manifest approval gate stays hash-bound (exact manifest ID plus
  SHA-256) and restricted to the approver allowlist; import stays an
  operator step.
- Reviewer role and permission gates untouched; `DiscoveryReviewClient`
  interface usage intact; full-batch counts (6,817) are never presented
  as a sample.

## Tests

- Baseline on untouched master: **25 suites / 96 tests, all passing**.
- Final: **26 suites / 106 tests, all passing** (`CI=true npm test`).
- Build: `CI=true npm run build` compiled successfully.
- New tests: HelpTip (5: accessible name, click toggle, focus opens,
  hover opens, Escape closes and refocuses); image-store-unset panel in
  DiscoveryImageReviewPanel; five-section structure, decision-separation
  copy, help-tip presence, and stale-phrase absence on the candidate
  detail page; AdminLayout nav toggle with `aria-expanded`; batches
  progress bar values and chips; image-only variant search and
  confirmation (same name, different brewery) in the field review.
- Existing tests changed only where the redesign intentionally changed
  structure or copy:
  - DiscoveryManifestComposition.test: "Pending backend support"
    assertion became the "Image only" chip; the pending paragraph
    assertion became the accurate manifest copy; absence assertions for
    the stale phrases added.
  - DiscoveryExistingBeerPanel.test: gate-note regex updated to the new
    manifest-gate copy; absence of /pending backend/i asserted.
  - DiscoveryCandidateFieldReview.test: ABV warning/error assertions now
    expect the message twice (beside the field and in the validation
    summary) with summary-heading assertions; the search-result assertion
    moved from the old "#42 - Bud Light" text format to per-result
    name/#id/brewery/badge checks.
  - AdminLayout.test, DiscoveryBatchesPage.test,
    DiscoveryCandidateDetailPage.test,
    DiscoveryCandidateFieldReview.test: new tests appended; no existing
    assertions weakened or deleted.

## Screenshots (local only, never committed)

Saved to `~/workspace/admin-image-workflow/qa-screenshots-redesign/`:
desktop (1440px) and iPhone (390px) captures of the batches list,
candidates list, candidate detail (all five sections), candidate detail
with the image-store-unset state, manifests list, and manifest detail
(12 PNGs). They were produced with a throwaway fixture harness rendering
the real pages and CSS with mocked data mirroring the verified
production facts (6,817-record batch at 0 reviewed; candidate #61 Bud
Light, staged brewery Budweiser, ABV 3.2123353678124, detector no_match,
saved image-only intent revision 1 targeting catalog beer #3784; the
fetch POST refusing with the DISCOVERY_IMAGE_STORE-unset error, triggered
by clicking the real fetch button). The shell framing in the shots is
static fixture markup using the real layout class names, because
AdminLayout's Firebase auth guard cannot render without a signed-in
admin; every page inside the frame is the real component.

## Harness files excluded from the commit set

- `src/qa-harness.tsx` (untracked; fixture fetch router, fixture shell,
  auto-fetch trigger for the unset-store shot). During capture,
  `src/index.tsx` temporarily imported the harness and was restored with
  `git checkout` afterwards; it is unmodified in the final tree.
- The dev server ran locally with dummy `REACT_APP_*` values so the
  Firebase module initializes; no real credentials were used and all API
  traffic was fixture-patched in page.

## Deviations and remaining blockers

- No deviations from the tasking. One implementation note: the HelpTip
  Escape handler suppresses the focus-open that its own programmatic
  refocus would otherwise trigger, so Escape reliably closes in
  browsers and jsdom.
- No backend contract gaps were found; nothing under `server/` needed
  changes.
- Remaining blocker (production, unchanged by this PR): the production
  image store is still unconfigured (`DISCOVERY_IMAGE_STORE` unset), so
  live image fetching still fails server-side until an administrator
  configures it. The UI now explains that state instead of surfacing a
  raw error.
