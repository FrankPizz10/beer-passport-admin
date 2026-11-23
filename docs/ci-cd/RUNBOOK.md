# BeerPassport Admin CI/CD Runbook

Status: PROPOSED (this PR). Nothing in this document authorizes a deployment,
a migration, or an AWS change by itself. Production actions follow the
approval flow in section (d) and Frank's standing rule: approval of a plan,
an architecture, or a PR is never permission to execute it.

Scope: the `beer-passport-admin` repository (CRA client at the root,
Express + Prisma API in `server/`), its Amazon ECR image pipeline, the
approval-gated API deployment to the single Lightsail instance, and the
Netlify-published client at admin.beer-passport.com.

Companion files in this PR:

| File | Purpose |
| --- | --- |
| `docs/ci-cd/workflows/ci.yml` | PR/master checks for client and API (install at `.github/workflows/ci.yml`) |
| `docs/ci-cd/workflows/api-image.yml` | Builds and pushes the API image to ECR by digest (install at `.github/workflows/api-image.yml`) |
| `docs/ci-cd/workflows/deploy-api.yml` | Production approval gate for one digest (install at `.github/workflows/deploy-api.yml`) |
| `server/Dockerfile` | Multi-stage API image; no secrets, no `.env`, non-root |
| `server/.dockerignore` | Build-context backstop that excludes `.env*` |
| `scripts/deploy-api.sh` | Operator-run deploy on the Lightsail box, by digest, with health gate and auto-rollback |
| `scripts/rollback-api.sh` | Operator-run rollback to the recorded previous digest |

The workflows ship as documentation copies because the agent's GitHub App
cannot push files under `.github/workflows/` (403, verified 2026-11-23). A
human installs them once; see the setup checklist in section (j).

---

## (a) Pipeline overview

1. **Pull request.** `ci.yml` runs on every PR and on every push to master:
   the client job (`npm ci`, `CI=true npm test`, `CI=true npm run build`)
   and the API job (`npm ci`, `npx prisma generate`, `npm run build`,
   `npm test`, in `server/`). CI mode is deliberate: it is the mode that
   failed the PR #12 Netlify preview on a lint error, so the same failure is
   now caught before merge instead of at publish time.
2. **Merge to master.** Frank merges. Merging is not a deployment of
   anything: the API image is only built, and the Netlify production publish
   is held (section (e)).
3. **Image build.** `api-image.yml` triggers on master pushes that touch
   `server/**` (or manual dispatch). It authenticates to AWS with GitHub
   OIDC (no static keys), builds `server/Dockerfile` for **linux/amd64
   only**, pushes to ECR with the immutable tag `sha-<short commit>`, and
   emits a release manifest (repository, digest, commit, ref, built_at) as
   a workflow artifact and in the job summary. **The digest is the release
   identity.** Tags are human-readable labels only.
4. **Approval.** A human dispatches `deploy-api.yml` with the full
   `sha256:...` digest. The job runs in the GitHub `production` environment
   and waits for Frank's approval before executing. It then verifies the
   digest exists in ECR and carries a `sha-<commit>` tag whose commit is an
   ancestor of `origin/master`, and writes the approved release manifest
   plus the exact operator commands into the job summary.
5. **Operator deploy.** On the Lightsail box, the operator runs
   `scripts/deploy-api.sh <repository>@<digest>`. The script records the
   current release as the rollback target, pulls by digest, switches the
   container, and health-gates on `GET /admin-api/v1/health` for ~60
   seconds. On health failure it removes the new container, restarts the
   previous one, and exits non-zero.
6. **Client publish.** Only after the API is health-verified does anyone
   publish the waiting Netlify production deploy (section (e)). Deploy
   Previews are unaffected and keep working for every PR.
7. **Rollback is always one command.** `scripts/rollback-api.sh` on the box
   returns the API to the recorded previous digest; a bad Netlify publish is
   reverted by re-publishing the previous deploy in the Netlify UI
   (section (h)).

Invariants that hold at every step:

- No credentials in Git, in image layers, or in workflow logs.
- No workflow ever connects to the Lightsail box (no SSH from CI; runner IPs
  are ephemeral and the box only accepts Frank's /32).
- Deployments reference images by digest. Nothing deploys "latest".
- Database migrations are never part of this pipeline (section (f)).

---

## (b) Registry and AWS evaluation

The November 2026 incident is the controlling fact here: server Docker
images with a baked `.env` were **public** on Docker Hub under
`frankpizz10` and leaked the production Firebase service-account key,
`DATABASE_URL`, and the MySQL root password. All exposed credentials were
rotated and the incident is closed. `beer-passport-image` is now private;
`beer-passport-history` was deleted. Any registry choice has to be judged
against that history: the failure mode was not Docker Hub's existence, it
was a public repository plus secrets baked into layers. The Dockerfile and
`.dockerignore` in this PR remove the second half of that failure; the
registry choice should remove the first half.

### Option 1: Docker Hub (existing `frankpizz10` account)

- The account and a now-private repository already exist; no new vendor.
- Free tier allows a limited number of private repositories (one private
  repository on the free plan at the time of writing), which is enough for
  this single image but leaves no room to grow.
- CI push would use a Docker Hub access token stored as a GitHub secret: a
  long-lived static credential, exactly the class of secret this design
  tries to eliminate.
- Box pulls would use a read-only pull token stored on the box.
- Digests work fine, and tag immutability can be approximated by convention
  only; Docker Hub does not enforce immutable tags the way ECR can.
- Reputational/operational risk: the same account that hosted the public
  leak. Nothing technical prevents a repository from being flipped public
  again by mistake.

### Option 2: Amazon ECR (recommended)

- Private by default; repositories are never public unless someone writes a
  policy making them so.
- CI push uses **GitHub OIDC**: the workflow assumes an IAM role with a
  short-lived token. There are no static AWS keys in GitHub secrets at all.
- Digest-native: images are content-addressed, and the repository can be
  created with **immutable tags** and **scan on push** turned on.
- Cost: storage is $0.10/GB-month in us-east-1. A Node API image is a few
  hundred MB; even dozens of retained digests cost cents per month.
  Same-region pulls from Lightsail cost ~$0 in transfer.
- One Lightsail caveat: a Lightsail instance cannot assume an IAM instance
  profile the way EC2 can. Box pulls therefore use a **dedicated IAM user**
  (`beerpassport-lightsail-ecr-pull`) whose access key lives only on the
  box (in the operator's AWS CLI configuration / docker credential flow),
  with a policy that allows pulling **only** from this one repository. The
  key is rotatable and revocable without touching anything else, and it can
  never push.

### Recommendation: Amazon ECR

ECR removes the static CI credential entirely (OIDC), is private by
default, enforces immutable tags, and costs cents. Docker Hub remains a
viable fallback but reintroduces a long-lived token in GitHub secrets and
keeps the project on the account from the incident.

### Exact AWS objects for Frank to create

The agent's AWS access is read-only (SSO role
`BeerPassportRecoveryReader`, account 149290600858, us-east-1). All of the
following are Frank-executed from his Mac (AWS CLI, SSO profile
`beerpassport-admin`), each as its own approved step:

1. **ECR repository** `beer-passport-admin-api` (private, us-east-1),
   tag immutability = IMMUTABLE, scan on push = enabled.
2. **GitHub OIDC identity provider** for
   `token.actions.githubusercontent.com`, if one does not already exist in
   the account.
3. **IAM role** `github-actions-beerpassport-admin`, trusted by that OIDC
   provider for this repository's workflows (subject condition scoped to
   `repo:FrankPizz10/beer-passport-admin`), with a policy allowing ECR
   authorization-token retrieval and push (`ecr:BatchCheckLayerAvailability`,
   `ecr:CompleteLayerUpload`, `ecr:InitiateLayerUpload`, `ecr:PutImage`,
   `ecr:UploadLayerPart`, plus `ecr:DescribeImages` for the deploy gate)
   **only** on the `beer-passport-admin-api` repository.
4. **IAM user** `beerpassport-lightsail-ecr-pull` with a pull-only policy
   (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
   `ecr:GetDownloadUrlForLayer`) on that one repository; its access key is
   created on, and stored only on, the Lightsail box.

No other AWS resources are needed. No RDS, no new buckets, no changes to
the existing Lightsail instance or to Secrets Manager.

---

## (c) Secrets inventory

Rule, restated: nothing secret lives in Git, in an image layer, or in a
workflow log. Workflow steps never echo environment values; the deploy
scripts never print the on-box env file. Digests, tags, and commit SHAs are
not secrets and are the only release data that appears in logs and
summaries.

| Secret / value | Where it lives | What it can do |
| --- | --- | --- |
| `AWS_ROLE_ARN` (GitHub **variable**, not a secret) | GitHub repo variables | Identifies the IAM role the workflows assume via OIDC. Not a credential: useless without a GitHub-issued OIDC token from this repo's workflows. |
| GitHub OIDC token | Minted per workflow run by GitHub; never stored | Assumes `github-actions-beerpassport-admin` for minutes; push/describe on one ECR repository. |
| ECR pull access key (`beerpassport-lightsail-ecr-pull`) | Lightsail box only (operator AWS CLI config) | Pull images from the one ECR repository. Cannot push, cannot touch anything else in AWS. Rotatable on the box. |
| `DATABASE_URL` | On-box env file `/opt/beerpassport-admin/admin-api.env` | API read path, connects as `beerpassport_admin_viewer` (SELECT-only, column-restricted). |
| `DATABASE_URL_WRITE` | Same on-box env file | API write path, connects as `beerpassport_admin_approver` (decision columns of `beverage_images` + `image_review_events` insert/select only). Unset = approval endpoints answer 503, everything else unaffected. Frank handles the value; it never transits chat, Git, or CI. |
| Firebase service-account variables (`FIREBASE_*`) | Same on-box env file (values originate in AWS Secrets Manager `prod/beerpassport/backend-2026`) | Verifies Firebase ID tokens and requires the `admin` custom claim on API requests. |
| `ADMIN_ORIGIN` | Same on-box env file | CORS allow-list value (`https://admin.beer-passport.com`). Not a secret, kept with the rest of the runtime config. |
| Netlify | No secrets used by this pipeline | Publishing is done in the Netlify UI by Frank (section (e)). No build hook URL is created by default, so there is no new secret to leak. |

What is deliberately NOT created: no Docker Hub token in GitHub secrets, no
AWS access keys in GitHub secrets, no SSH key for CI (CI never connects to
the box), no Netlify build hook.

---

## (d) Production approval flow

Who approves what, and where:

| Action | Who | Where | Effect |
| --- | --- | --- | --- |
| Merge a PR | Frank | GitHub | Code lands on master. Builds an image (if `server/**` changed). Deploys nothing. |
| Approve an API release | Frank, as required reviewer | GitHub `production` environment, on a `deploy-api.yml` run | The run verifies the digest and emits the approved manifest + operator commands. Still deploys nothing by itself. |
| Run `deploy-api.sh` | Operator on the box (Frank, or an operator Frank directs) | Lightsail instance | The actual API deployment, health-gated, auto-rollback on failure. |
| Publish the client | Frank | Netlify UI | The waiting production deploy goes live, after the API is verified (section (e)). |
| Apply a migration | Frank approves the specific migration as its own change | Box, operator DB identity | Section (f). Never bundled with an image deploy approval. |

One-time setup for the gate: create the GitHub environment named
`production` (repo Settings -> Environments), add Frank as a **required
reviewer**, and restrict deployment branches to `master`. Until that
environment exists, `deploy-api.yml` cannot run at all, which is the safe
default.

Standing rule, made explicit because this project has been bitten by the
confusion before: **approving this runbook, approving a PR, or approving
the environment prompt for a plan authorizes nothing by itself.** Each
production execution (image deploy, Netlify publish, migration, AWS object
creation) is its own step with its own explicit go-ahead.

---

## (e) Netlify ordering: the client can never outrun the API

### The failure mode

Netlify auto-deploys master merges. Without a control, a merge can publish
a client that calls API behavior that is not deployed yet (new endpoints,
new response fields, new write paths). The API deploy in this pipeline is
deliberately manual and approval-gated, so the client would win the race by
default and fail silently in production: pages render, calls 404/503, and
nothing alarms.

### Control 1: stop auto-publishing the production context (one-time)

In the Netlify UI for site `harmonious-genie-c19558`:

1. Site configuration -> Build & deploy -> Continuous deployment.
2. Under **Deploy contexts**, confirm Production = branch `master`.
3. Click **Stop auto publishing** (site overview -> Deploys also offers
   "Stop auto publishing" for the production context).

From then on, master merges still **build** and reach a ready state, and
Deploy Previews for PRs keep working exactly as before, but nothing goes
live until someone clicks **Publish deploy** on a specific ready deploy.
This is a reversible, one-click setting; it creates no secrets and no new
tooling.

### Control 2: fixed release order

1. API first: approve the digest (`deploy-api.yml`), run
   `scripts/deploy-api.sh` on the box, pass the health and smoke checks.
2. Client second: in the Netlify UI, open the waiting production deploy
   built from the same master commit and click **Publish deploy**.
3. If a release is API-only (no client change in the merge), there is
   nothing to publish; if it is client-only, publish normally after
   confirming the compatibility rule below.

(A Netlify build hook could replace the button click, but a hook URL is a
bearer secret that anyone holding it can use to trigger production builds.
The UI click is the default; a hook is Frank's explicit opt-in only.)

### Control 3: the compatibility rule

**A client change must run correctly against the currently deployed API
for at least one release.** The API is backwards-tolerant by design in the
places that matter: for example, the Image Queue page already degrades
gracefully when the approval write path is disabled, because the decision
endpoints answer 503 when `DATABASE_URL_WRITE` is unset and the queue's
read endpoints keep working. A PR that cannot honor this rule (it requires
an API change to function at all) must say so in its description, in so
many words, and it waits for an API-first window: API deployed and verified
first, client published second, in the same sitting.

Reviewers check this on every client PR: "does this work against today's
deployed API?" If the answer is no and the PR does not say so, it does not
merge.

---

## (f) Migration policy

Migrations are **separate, explicitly approved changes**. They are never
baked into the API image, never run by a container entrypoint, and never
applied by any GitHub workflow. The image contains no migration tooling and
the runtime database roles cannot run DDL: the viewer role is SELECT-only
and the approver role can only update decision columns and insert audit
rows.

For each migration, in order:

1. The migration ships as a reviewed SQL file in the repo
   (`server/db/migrations/NNN-*.sql`, plus role scripts where needed), in
   its own PR or in the feature PR, but approval to merge is not approval
   to apply.
2. Before applying: take a Lightsail snapshot and/or a `pg_dump` of the
   production database and record where it is stored.
3. Apply with the operator (migration/owner) database identity on the box,
   in one transaction where the SQL allows it.
4. Run the repo's verification scripts for the change (for the image
   approval workflow: `server/db/verify-approval-role.sql` run as the
   approver role and `server/db/verify-readonly-role.sql` run as the
   viewer role) and record the results.
5. Record what was applied, when, by whom, and the verification results in
   the PR or the deployment notes.

Ordering rule: **additive** migrations (new nullable columns, new tables,
new indexes) may be applied before the API deploy that first uses them,
because the old API ignores them. **Destructive** migrations (drops,
renames, type changes, data rewrites) need their own plan with an explicit
rollback story and are never combined with a feature launch.

Schema-drift note for this repo: the canonical Prisma schema is the one in
`beer-passport-server`. This repo's copy, `server/prisma/schema.prisma`,
**already reflects migration 001**: the `beverage_images` columns
(`reviewed_by`, `reviewed_by_uid`, `reviewed_at`, `source_content_type`,
`source_checked_at`, `source_check_status`) and the `image_review_events`
model are present. What remains outstanding is the mirror change in
`beer-passport-server` itself; until that lands as its own server PR, treat
the admin copy as ahead of canonical and do not "fix" it by reverting the
columns here. See section (g), step 5.

---

## (g) First production use: ship the merged PR #11 API + migration 001

Goal state: the Image Queue works in production. The merged master already
contains the queue client page, the queue/decision API endpoints, migration
001, and the approver role script. What production does **not** have yet:
migration 001 applied, the approver role created, `DATABASE_URL_WRITE`
configured, or an API build that includes the endpoints (the live API
predates them). Execute these steps in order; each is separately approved,
and the rollback for each is noted inline.

1. **Confirm the client state.** In the Netlify UI, check which production
   deploy is currently published and which master deploy is waiting. The
   queue page is in the client from PR #11's merge. Per section (e), do
   **not** publish the waiting deploy yet if it is not already live; the
   API goes first. (If the queue page is already in the published client,
   it is harmless: its decision buttons will get 503s until step 7, and
   the rest of the admin works.)
2. **Snapshot.** Take a manual Lightsail snapshot of the instance and
   confirm it completes. This matches the existing pre-load snapshot
   practice for the production database; the snapshot is the rollback for
   steps 3-4 as a whole.
3. **Apply migration 001.** As the operator DB identity on the box:
   `psql -d <database> -f server/db/migrations/001-image-approval.sql`.
   It is additive only (six nullable columns on `beverage_images`, one new
   table `image_review_events`, one index) and `beverage_images` is empty
   in production, so no image data is touched. Rollback for this step: the
   migration's down steps in `docs/DEPLOYMENT_RUNBOOK.md`, or restore the
   step-2 snapshot; the currently live API works against the migrated
   schema either way because the change is additive.
4. **Create the approver role.** As the same operator identity:
   `psql -d <database> -f server/db/approval-role.sql`. Then run the
   verifications and record the output:
   `server/db/verify-approval-role.sql` (run as the approver role) and
   `server/db/verify-readonly-role.sql` (run as the viewer role).
   Rollback: drop the role per `approval-role.sql`'s companion notes in
   `docs/DEPLOYMENT_RUNBOOK.md`; nothing else references it yet.
5. **Schema-drift follow-up (paperwork, not a box step).** Open the mirror
   PR in `beer-passport-server` carrying migration 001's columns and the
   `image_review_events` table into the canonical schema and its migration
   history. The admin repo's schema copy already has them (section (f)).
   This follow-up does not block the launch.
6. **Build the API image from master.** Two acceptable paths for this first
   run:
   - **Preferred:** install the three workflows (section (j)), let
     `api-image.yml` build and push the image from the master commit that
     merged PR #11, and note the digest from its release manifest.
   - **Manual first run (if the workflows are not installed yet):** on a
     local machine with Docker, from a clean master checkout:
     `docker build -f server/Dockerfile -t beer-passport-admin-api:sha-<short-sha> server/`
     for linux/amd64, push it to the ECR repository, and record the digest
     that the push reports (`docker push` prints it; or
     `aws ecr describe-images`). The digest, not the tag, goes into the
     next steps either way.
   Then dispatch `deploy-api.yml` with that digest and approve it in the
   `production` environment (if the workflow path was used; for a fully
   manual first run, Frank's explicit go-ahead in chat replaces the
   environment approval, and the deviation is recorded in the PR).
7. **Configure the write path.** Frank sets `DATABASE_URL_WRITE` in
   `/opt/beerpassport-admin/admin-api.env` on the box (the
   `beerpassport_admin_approver` connection string). The value is handled
   only by Frank and never appears in chat, Git, or CI. Also confirm the
   same file carries the existing `DATABASE_URL`, Firebase variables, and
   `ADMIN_ORIGIN` used by the current API, since the container gets all of
   its configuration from this file.
8. **Capture the pre-container rollback target.** Identify how the API
   currently runs on the box (`docker ps` if it is already a container, or
   the process/systemd unit if it is not) and record it in the deployment
   notes: image reference or unit name, and how to restart it. The deploy
   script records a rollback target automatically only when the current
   API is a container named `beerpassport-admin-api`. If this first switch
   moves the API from a non-container runtime into the container form,
   keep the old runtime stopped-but-intact until step 10 passes; it is the
   rollback for this step (restart it and stop the container).
9. **Deploy.** On the box:
   `scripts/deploy-api.sh <ecr-repository>@<approved-digest>`.
   The script pulls by digest, starts the container on
   `127.0.0.1:4100` behind Caddy with a 288 MB memory limit, and
   health-gates for ~60 seconds, auto-rolling back on failure.
10. **Smoke tests, in order:**
    - From the box or Frank's network:
      `curl -fs https://admin-api.beer-passport.com/admin-api/v1/health`
      answers 200. (Remember the API's HTTPS is restricted to Frank's /32;
      run public checks from his network, not from CI or the agent VM.)
    - Unauthenticated `GET /admin-api/v1/images/queue` answers **401**
      (auth required). A 503 here means `DATABASE_URL_WRITE` did not reach
      the container; a 404 means the deployed image predates PR #11.
    - From Frank's network, signed in as admin: open **Image Queue** in the
      published client (publish the waiting Netlify deploy now if step 1
      held it back).
    - Load candidates with the operator loader
      (`server/scripts/load-image-candidates.ts`, run with the operator
      loader identity, per `docs/DEPLOYMENT_RUNBOOK.md`), refresh the
      queue, and confirm candidates appear with their source-check badges.
    - Approve one candidate and reject one. Both decisions must succeed
      (not 503), appear in the decisions list, and write rows to
      `image_review_events`.
11. **Close out.** Record in the PR: the deployed digest, the migration
    verification results, the smoke test results, and the rollback target.
    The release is done only when all of step 10 passes.

Rollback triggers for this launch: any smoke test failure that is not
explained by a fixable configuration typo (step 7) means roll back:
`scripts/rollback-api.sh` for the API (or restart the pre-container
runtime captured in step 8), and re-publish the previous Netlify deploy if
the client was published in step 10 and misbehaves. Migration 001 does not
need to be rolled back for an API rollback; it is additive and inert for
the old API.

---

## (h) Recovery procedures

- **Bad API deploy.** If the health gate fails, `deploy-api.sh` already
  rolled back automatically (it restarts the previous container and exits
  1); confirm with `curl` against the health endpoint and
  `docker ps`. If a deploy passed the gate but misbehaves afterwards, run
  `scripts/rollback-api.sh`: it returns to the digest recorded in
  `/opt/beerpassport-admin/previous-digest` without overwriting that
  target (see the script's header for the state discipline). The stopped
  previous container is kept on the box, so rollback does not depend on
  ECR being reachable.
- **Bad migration.** Migrations are applied only after a snapshot
  (section (f)). Recovery is restoring the pre-migration Lightsail
  snapshot or the `pg_dump` taken in step 2 of the migration procedure.
  For migration 001 specifically: it is additive, so the old API keeps
  working against the migrated schema; a code rollback never requires a
  schema rollback, and the down steps exist in
  `docs/DEPLOYMENT_RUNBOOK.md` if the schema change itself must be undone.
- **Bad Netlify publish.** In the Netlify UI, open the previous production
  deploy and click **Publish deploy**. This is instant and does not require
  a rebuild. Because production auto-publishing is stopped (section (e)),
  a bad publish can only have come from a manual publish, and the previous
  ready deploy is right there in the list.
- **Registry or AWS outage.** The running container is unaffected: it does
  not talk to ECR or AWS at runtime except for S3 image signing, which is
  unrelated to the registry. Deploys and image builds pause until the
  outage clears. Nothing about an ECR outage can take the live API down.
- **GitHub outage.** The box, Netlify, and ECR keep working. An operator
  with Docker can build the same image locally from the same
  `server/Dockerfile`, push it to ECR manually, and deploy by the digest
  the push reports (section (g), step 6, manual path). The approval record
  for such an emergency deploy is Frank's explicit go-ahead, recorded in
  the PR afterwards; the digest discipline does not change.

---

## (i) Cost

| Item | Cost | Notes |
| --- | --- | --- |
| GitHub Actions | $0 expected | Private-repo free tier includes 2,000 minutes/month. A full CI run is ~6-10 minutes; an image build ~4-6 minutes. Even daily use stays far under the tier. Overage, if it ever happened, is $0.008/minute for Linux runners. |
| Amazon ECR | Cents/month | Storage $0.10/GB-month in us-east-1. One image is a few hundred MB; retaining every digest for a year stays under ~$1/month. Same-region pulls from Lightsail: ~$0 transfer. |
| GitHub `production` environment | $0 | Included in the repo plan. |
| Lightsail instance | $7/month, unchanged | This pipeline adds no instance, no snapshot schedule change, and no bandwidth of consequence. |
| Netlify | $0, unchanged | Free tier; stopping auto-publishing is a setting, not a plan feature. |
| **Total incremental** | **Effectively $0** | Well inside the project's ~$0-15/month infrastructure target. |

---

## (j) One-time setup checklist (Frank, in order)

Nothing here is done by the agent: the agent's GitHub App cannot push
workflow files, and the agent's AWS access is read-only. Each step is
Frank's, and each is safe to do before any production use.

1. **Install the workflows.** Copy the three files from
   `docs/ci-cd/workflows/` to `.github/workflows/` with identical names
   (`ci.yml`, `api-image.yml`, `deploy-api.yml`), via the GitHub web UI
   (Create new file) or a local clone push. Verify the Actions tab lists
   CI, API image, and Deploy API (approval gate).
2. **Create the `production` environment.** Repo Settings -> Environments
   -> New environment: `production`. Add Frank as a required reviewer and
   set deployment branches to `master` only.
3. **Create the AWS objects** from section (b): the ECR repository
   `beer-passport-admin-api` (immutable tags, scan on push), the GitHub
   OIDC provider if absent, the role `github-actions-beerpassport-admin`,
   and the pull-only user `beerpassport-lightsail-ecr-pull`.
4. **Set the GitHub variable** `AWS_ROLE_ARN` to the role's ARN (repo
   Settings -> Secrets and variables -> Actions -> Variables). It is a
   variable, not a secret; no AWS keys are stored anywhere in GitHub.
5. **Stop Netlify auto-publishing** for the production context, per
   section (e), Control 1.
6. **Prepare the box.** Create `/opt/beerpassport-admin/`; write
   `admin-api.env` there with the runtime configuration (section (c));
   confirm Docker is installed and the operator's AWS CLI is configured
   with the pull-only user's key (for ECR logins in `deploy-api.sh`);
   copy `scripts/deploy-api.sh` and `scripts/rollback-api.sh` to the box
   and make them executable.
7. **Dry-run the checks.** Open any small PR and confirm `ci.yml` runs both
   jobs green. One known exception at the time of writing: the client
   build step is red on current master because of the pre-existing
   `jsx-a11y/img-redundant-alt` error at `src/pages/ImageQueuePage.tsx:98`
   (introduced by PR #11, fixed by the open reliability PR #13). That is
   the pipeline working as designed; the step goes green when #13 merges,
   and it is not a setup failure. Merge a trivial `server/**` change (or
   dispatch `api-image.yml` manually) and confirm an image lands in ECR
   with a `sha-<commit>` tag and a digest in the run summary. Do not
   dispatch `deploy-api.yml` until a real release is intended.

After setup, the first real use is section (g).
