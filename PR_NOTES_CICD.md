### Proposed PR title

CI/CD: PR checks, ECR image pipeline by digest, approval-gated API deploys

### Proposed PR description

**Read this first — workflow install caveat.** The three GitHub Actions
workflows in this PR live under `docs/ci-cd/workflows/`, NOT under
`.github/workflows/`, because the agent's GitHub App cannot push workflow
files (403, verified 2026-11-23). They are inert where they are. A human
installs them once by copying them to `.github/workflows/` (GitHub web UI or
a local push) as part of the one-time setup checklist in
`docs/ci-cd/RUNBOOK.md` section (j). Each file's header comment says the
same. Everything else in this PR (Dockerfile, scripts, runbook) is effective
as committed.

**Summary.** This PR adds the delivery pipeline for the admin API and
client, designed around the November 2026 Docker Hub incident (public
images with a baked `.env` leaked production credentials):

- `ci.yml` — on every PR and master push: client job (`npm ci`,
  `CI=true npm test`, `CI=true npm run build`) and API job (`npm ci`,
  `npx prisma generate`, `npm run build`, `npm test` in `server/`).
  Deploys nothing, needs no secrets.
- `api-image.yml` — on master pushes touching `server/**` (or manual
  dispatch): builds `server/Dockerfile` for linux/amd64 only, pushes to
  Amazon ECR with an immutable `sha-<short commit>` tag, and emits a
  release manifest whose identity is the image **digest**. AWS auth is
  GitHub OIDC; there are no static AWS keys anywhere in GitHub.
- `deploy-api.yml` — manual dispatch with a full `sha256:` digest. Runs in
  the `production` environment (Frank is the required reviewer), verifies
  the digest exists in ECR and maps to a `sha-<commit>` tag whose commit is
  an ancestor of `origin/master`, and emits the approved manifest plus the
  exact operator commands. It never touches the Lightsail box: deployment
  is `scripts/deploy-api.sh <repo>@<digest>` run by an operator on the
  box, health-gated with automatic rollback to the recorded previous
  digest (`scripts/rollback-api.sh`).
- `server/Dockerfile` + `server/.dockerignore` — multi-stage Node 20 image.
  No `.env` or secret is copied in any stage (with a header comment
  explaining why), production-only dependencies, the generated Prisma
  client carried into the runtime stage, non-root user, healthcheck on
  `/admin-api/v1/health`.
- `docs/ci-cd/RUNBOOK.md` — the full design: pipeline overview, Docker Hub
  vs ECR evaluation (ECR recommended, with the exact AWS objects for Frank
  to create), secrets inventory, the production approval flow, the Netlify
  ordering controls (stop auto-publishing + API-first release order + the
  one-release compatibility rule), the migration policy (migrations are
  never in the pipeline; each is its own approved change), the exact first
  production run for the merged PR #11 API + migration 001 so Image Queue
  works, recovery procedures, and costs (incremental: effectively $0).

**What reviewers should scrutinize.**

1. The Dockerfile's Prisma handling: the generated client is produced in
   the `deps` stage and copied into the production `node_modules`
   (`prod-deps` stage), because the Prisma CLI is a devDependency and is
   deliberately absent from the production install. If that copy is wrong,
   the container builds fine and fails only at runtime — it is the
   highest-risk detail in the PR, and it cannot be exercised until the
   first real image build (see test report).
2. The deploy/rollback state discipline in `scripts/`: `previous-digest`
   is written only by forward deploys; rollback preserves it so a second
   rollback cannot ping-pong back to a bad release.
3. The deploy gate's ancestry check: a digest is approvable only if one of
   its ECR tags is `sha-<commit>` for a commit on `origin/master`.
4. The claim in the runbook that stopping Netlify auto-publishing plus the
   compatibility rule fully closes the client-before-API race.

**Not in this PR.** No workflow is installed, nothing is deployed, no
migration is applied, no AWS object is created. Database migrations remain
separate, explicitly approved changes (runbook section (f)). The first
production use, once this design is approved and set up, is runbook
section (g).

**Test report** (run locally on this branch, which is master at 525bf918
plus this PR's files; commands mirror what CI will run):

- Workflow syntax: `python3 yaml.safe_load` parsed all three workflow
  files successfully (ci: jobs client + server; api-image: build-and-push;
  deploy-api: approve-release).
- Scripts: `bash -n scripts/deploy-api.sh` and `bash -n
  scripts/rollback-api.sh` both pass.
- Client tests: `CI=true npx react-scripts test --watchAll=false` —
  5 suites, **13/13 tests passed**.
- Client build: `CI=true npm run build` — **fails on current master
  content**, on a pre-existing error this PR does not introduce and does
  not touch: `jsx-a11y/img-redundant-alt` at
  `src/pages/ImageQueuePage.tsx:98` (the "Candidate image for ..." alt
  text, merged in PR #11; the fix is in the open reliability PR #13).
  This is the same failure that killed PR #12's Netlify preview, and it is
  the pipeline working as designed: once `ci.yml` is installed, this class
  of failure is caught on the PR instead of at publish time. The client
  job goes green when PR #13 merges.
- API checks, run exactly as the CI server job runs them (in `server/`):
  `npx prisma generate` OK (locally with the sandbox Prisma engine
  environment variables; CI runners download engines normally),
  `npm run build` (tsc) clean, `npm test` — 9 suites passed, 1 skipped
  (live-database suite), **66 tests passed, 4 skipped, 0 failed**.
- Docker image build: **not run — there is no Docker on the agent
  machine.** The Dockerfile is verified by reading and by the tsc/Jest
  results above only. Its first real verification is the initial
  `api-image.yml` run after installation (runbook section (j), step 7),
  and reviewers should treat the image build as unproven until that run
  is green.
- Secrets scan: grepped every new file for credential-shaped assignments
  (`password`/`secret`/`token`/`key` followed by a value). No credential
  values exist in any new file; the only matches are environment-variable
  names, the OIDC `id-token: write` permission, the `docker login
  --password-stdin` flag (value arrives by pipe, never printed), and prose
  in the runbook.
