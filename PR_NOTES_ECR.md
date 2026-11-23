### Move the admin API image from Docker Hub to a private ECR repository

**What this PR does**

- The deploy job in `.github/workflows/ci.yml` now publishes the release image to the private Amazon ECR repository `beer-passport-admin-api` (us-east-1, account 149290600858) instead of the public Docker Hub repository. AWS sign-in uses the existing GitHub OIDC deployment role (`BP_DEPLOY_ROLE_ARN`) plus `amazon-ecr-login`; the Docker Hub secrets are no longer referenced. The registry host comes from the new GitHub variable `BP_ECR_REGISTRY`.
- The vulnerability policy is unchanged: Trivy scans the release image before publish, critical findings fail the job, high findings are reported as warnings. ECR scan-on-push (enabled at repository creation) is additive visibility, not the gate.
- Deployment still happens by immutable digest through the fixed SSM document, now pinned to the new document version 2 (`docs/ci-cd/ssm-deploy-document.v2.json`), whose only change is the ECR repository reference. Version 1 (Docker Hub) is retained unchanged and remains the rollback path to the currently running image.
- Lightsail pull path (the host has no AWS CLI and ECR tokens expire after 12 hours): `scripts/deploy-api.sh` detects ECR references and, before pulling and before touching the running container, runs the new `scripts/ecr-login.py` (Python 3 standard library only; it makes the signed ECR GetAuthorizationToken call itself). The password is piped to `docker login --password-stdin`, never printed, and the login uses a temporary DOCKER_CONFIG directory that is deleted on exit. The pull identity is minimal (`docs/ci-cd/lightsail-ecr-pull-policy.example.json`): primarily the host's existing SSM managed-node role extended with that policy (temporary, agent-refreshed credentials; no long-lived credential on the host), with a dedicated pull-only IAM user plus a root-only key file on the host as the documented fallback. Docker Hub references skip ECR authentication entirely, so rollback to the pre-migration image is preserved exactly.
- New IAM example: `docs/ci-cd/github-ecr-push-policy.example.json` scopes the deployment role's ECR push to the single repository.
- Runbook updated: ECR setup with exact commands, the pull-auth design and verification, document version 2 creation, the cutover sequence, and post-cutover Docker Hub token revocation.

**Delivery note (one manual step):** every file in this PR is pushed normally except `.github/workflows/ci.yml` itself: the agent's GitHub App cannot push workflow files (403 on tree creation, re-verified 2026-11-23), so the updated workflow ships as a full replacement copy at `docs/ci-cd/workflows/ci.yml`. Frank or Codex applies it by replacing `.github/workflows/ci.yml` with that file; the rest of the PR (scripts, SSM document, IAM examples, runbook, tests) is complete as pushed.

**Test report**

- `bash scripts/test-deploy-api.sh` (also run by CI): the 4 pre-existing failure-restore scenarios pass (run, network, health, database), plus 3 new ECR scenarios: login precedes the pull and the temporary docker config is removed; an ECR authentication failure aborts before the running container is touched; rollback after an ECR deploy returns to the recorded Docker Hub image without invoking ECR authentication.
- `python3 scripts/test-ecr-login.py` (new; also wired into CI): against a local stub ECR endpoint, the helper produces a correctly shaped SigV4 Authorization header and X-Amz-Target, pipes only the password to docker login's stdin, leaks neither password nor token to stdout, and fails before invoking docker when ECR denies the request.
- `bash -n` clean on all shell scripts; `ci.yml` parses as YAML; all three new/updated JSON documents parse.
- Not verifiable from here: a live ECR push/pull or SSM execution (requires Frank's AWS setup steps below; the agent's AWS access is read-only and no production change was made).

**Setup Frank/Codex run (nothing here is done by this PR)**

1. `aws ecr create-repository --repository-name beer-passport-admin-api --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true --region us-east-1`
2. Create a policy from `docs/ci-cd/github-ecr-push-policy.example.json` and attach it to the existing deployment role.
3. Set the GitHub variable `BP_ECR_REGISTRY` to `149290600858.dkr.ecr.us-east-1.amazonaws.com`.
4. `aws ssm update-document --name BeerPassportDeployAdmin --content file://docs/ci-cd/ssm-deploy-document.v2.json --document-version '$LATEST'`
5. Attach the pull policy (`docs/ci-cd/lightsail-ecr-pull-policy.example.json`) to the managed-node role; install `scripts/ecr-login.py` at `/opt/beerpassport-admin/` (root-owned, executable); verify a manual login run on the host. Fallback user path is documented in the runbook.
6. Keep `BP_AUTO_DEPLOY_ENABLED` false until the above verify, then enable and dispatch; after the first ECR release verifies, revoke the Docker Hub token and delete its GitHub secrets.
