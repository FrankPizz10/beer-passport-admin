# PR notes: close the S3 image-storage gap in the discovery import path

Branch: `discovery/s3-image-storage` (from the merged Phases 3-5 stack,
merge commit 17e5e8d). Local only: nothing pushed, no PR created by the
author of these notes, nothing deployed, no real object uploaded, no
AWS permission created or changed.

### Summary

Phase 5's import executor re-fetched each approved image, verified its
SHA-256, and then wrote `beverage_images.storage_key` = the candidate's
source ref (a URL). The API's presigned-GET read path resolves bare
storage keys against the private image bucket (which held no objects),
so imported images could not resolve as private product images. The
executor now uploads the verified bytes to the bucket in the real write
path and stores the returned content-addressed object key in
`storage_key`. `source_url` still carries the origin URL. The API, its
roles and grants, its GetObject-only signing identity, and the read
path are all untouched: uploads run under the OPERATOR identity of the
executor process.

### Design

- **New module `server/src/discoveryImageUpload.ts`.** Key derivation,
  checksum conversion, retry policy, and the S3 uploader factory, kept
  out of the executor script so it is unit-testable and type-checked
  with `src/`.
- **Content-addressed key:** `discovery/<first 2 hex chars of the
  sha256>/<full sha256>`, mirroring the Phase 4 local store layout
  (`<root>/<shard>/<sha256>`). A retry, or a second import of the same
  bytes, PUTs identical content to the same key, so the upload step is
  inherently safe to repeat.
- **Integrity at S3:** every `PutObject` sets `ContentType` to the
  fetcher-verified content type and `ChecksumSHA256` to the base64 form
  of the verified hash, so S3 itself rejects bytes that do not match.
  The uploader also re-hashes the bytes at its own boundary and refuses
  a mismatch before sending anything.
- **Configuration:** the bucket and region come from the same
  environment the presigned read path already uses
  (`imageStorageConfigFromEnv`): `ADMIN_IMAGE_BUCKET`, and
  `ADMIN_IMAGE_REGION` with `AWS_REGION` as fallback. No new variable
  was needed; the same names now configure the operator-side writer
  exactly as they configure the API-side reader, under different
  identities. Credentials resolve through the SDK default chain of the
  executor process.
- **Dependency injection:** `ImportDeps` gains an optional
  `uploadImage` alongside `fetchImage`. The CLI wires
  `getDefaultDiscoveryUploader()` (null when the bucket is not
  configured); tests inject stubs. Optionality is safe because of the
  refusal below.
- **Failure behavior:**
  - Uploader retries: at most 3 attempts, exponential backoff
    (250 ms, 500 ms), transient failures only (throttling, 5xx, 429,
    timeouts, network errors). Deterministic failures (403, 404, bad
    digest) fail on the first attempt.
  - An upload error after retries aborts the import as
    `IMPORT REFUSED [image_upload]` and the database transaction
    rolls back. Uploads complete before any catalog row is written.
  - A manifest that carries images while no uploader is configured
    refuses the same way (`image_upload`, naming `ADMIN_IMAGE_BUCKET`)
    instead of silently storing the source URL. Image-less manifests
    import fine with no bucket configured. `--dry-run` never uploads
    and never requires an uploader.
  - **Orphan semantics (documented in the executor header and the
    runbook):** the S3 PUT is not part of the database transaction,
    so an abort after a successful PUT (a later image failing, a
    commit failure) leaves an orphan object. Content addressing
    makes it harmless: exactly the verified bytes under their hash,
    referenced by no row, and a retry overwrites the same key.
- **Identity separation:** no changes to API roles, DB grants, the
  API's AWS identity, or `imageStorage.ts` / `routes/images.ts` /
  `images.ts`. The only new permission artifact is an example policy
  for the operator identity (below); attaching it is an
  approval-gated operator step that was NOT performed.

### Files

- `server/src/discoveryImageUpload.ts` (new): key derivation
  (`discoveryObjectKey`), checksum conversion
  (`sha256ChecksumBase64`), transient-error classification
  (`isTransientUploadError`), the retrying uploader factory
  (`createDiscoveryImageUploader`, injectable client/sleep/attempts),
  and `getDefaultDiscoveryUploader` for the CLI.
- `server/src/discoveryImageUpload.test.ts` (new): 15 unit tests with
  a hand-rolled stub S3 client (no new dependency, no AWS calls).
- `server/scripts/import-discovery-manifest.ts`: `ImportDeps
  .uploadImage`; the fetched image (bytes included) is retained from
  the re-fetch; after the dry-run branch and before sequence
  alignment, the executor refuses (no uploader + images) or uploads
  each verified image and records its key; `beverage_images
  .storage_key` now stores that key; CLI main wires the default
  uploader; header documents the storage design and orphan semantics.
- `server/test/discoveryManifests.integration.test.ts`: all existing
  real-import call sites now inject a recording stub uploader (via a
  shared `importDeps()` helper); the positive scenario asserts each
  imported row's `storage_key` equals
  `discovery/<shard>/<PNG sha256>` (and is not the source URL) and
  that the uploader received exactly the verified bytes (length,
  hash, content type) once per image; the dry-run scenario asserts
  zero upload calls; two new scenarios cover an uploader failure
  aborting with `image_upload` and no catalog rows written, and a
  missing uploader refusing with `image_upload` (message names
  `ADMIN_IMAGE_BUCKET`) and nothing written.
- `docs/ci-cd/discovery-image-upload-policy.example.json` (new): one
  statement, `s3:PutObject` on `arn:aws:s3:::<image-bucket>/discovery/*`
  only, in the existing examples' style.
- `docs/DISCOVERY_HUB_RUNBOOK.md`: the Import section gains step 7
  covering the env vars, key layout, checksum, retry policy, refusal
  behavior, orphan semantics, and the operator-identity-only rule for
  the policy.

### Test report

All run 2026-11-23 in the worktree; no real AWS anywhere (stub S3
client in unit tests, stub uploader in the rehearsal):

- `npx jest src/discoveryImageUpload.test.ts` (server/): 15/15
  passed. Covers key derivation (including determinism and invalid
  hash refusal), the checksum known-answer vector (empty-string
  SHA-256, hex to base64) and round-trip, transient classification
  (5xx/429/names/codes vs 403/404/400), a single-PUT success asserting
  Bucket/Key/ContentType/ChecksumSHA256/Body, the bytes/hash mismatch
  refusal with zero sends, transient retry with backoff delays
  [100, 200] at a 100 ms base, exhaustion at `UPLOAD_MAX_ATTEMPTS`,
  and no retry on a deterministic 403.
- Bare `npx jest` (server/, DB env unset): exit 0, 230 passed,
  26 skipped, 0 failed.
- `npx tsc --noEmit` (server/): clean.
- `bash server/scripts/test-discovery-roles.sh`: exit 0, ALL
  DISCOVERY ROLE CHECKS PASSED, integration 7/7 (decisions + images).
- `bash server/scripts/test-discovery-manifests.sh`: exit 0, ALL
  DISCOVERY MANIFEST CHECKS PASSED, integration suite 12/12: the ten
  prior scenarios (positive, six negatives, three import-safety
  regressions) plus the two new S3 scenarios; CLI refusals intact
  (exit 2 without the loader env, exit 1 check1 for a missing
  manifest); offline `sha256sum` of the exported manifest matches
  the recorded hash.

### Deviations

- `uploadImage` is optional in `ImportDeps` rather than required,
  with the executor refusing at the write path when a manifest has
  images and no uploader. This keeps refusal-path and dry-run
  callers honest without configuration, and the rehearsal's stub is
  injected at every real-import call site so no test silently skips
  an upload.
- The existing scenarios' call sites were updated to the shared
  `importDeps()` helper (fetch + stub upload). No scenario's
  assertions were weakened; the positive and dry-run scenarios
  gained assertions.
- The bucket env var reuses the read path's `ADMIN_IMAGE_BUCKET`
  (with `ADMIN_IMAGE_REGION` / `AWS_REGION`) instead of introducing
  a `DISCOVERY_IMAGE_S3_BUCKET`: one bucket, one name, two
  identities. The runbook states explicitly which identity each
  side resolves under.
- The import report's shape is unchanged (no storage keys added to
  `id_assignments`); the keys are derivable from the approved image
  hashes and are asserted in the rehearsal from the written rows.

### Operator setup that remains (approval-gated, NOT performed)

1. Attach the policy from
   `docs/ci-cd/discovery-image-upload-policy.example.json` (with the
   real bucket name substituted) to the OPERATOR identity that runs
   the executor. Never attach it to the API identity.
2. Set `ADMIN_IMAGE_BUCKET` (and `ADMIN_IMAGE_REGION` or
   `AWS_REGION`) in the operator environment that runs the executor,
   matching the API's bucket.
3. A production import still requires Frank's approval of the exact
   manifest id + sha256, as before; this change does not alter the
   gate.

### Blockers

None for this change. The stacked promotion of Phases 3-5 and the
production prerequisites (server-repo schema mirror, read-only grant
whitelist fix, production migrations, a production import) are
separate work items outside this branch.
