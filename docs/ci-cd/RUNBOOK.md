# Admin API delivery runbook

Status: proposed. PR approval does not authorize production actions.

## Scope and current state

GitHub Actions workflows live under `.github/workflows/`; the matching files under `docs/ci-cd/workflows/` are reference copies. They run only after this PR is merged. The repository uses the public Docker Hub repository `frankpizz10/beerpassport-admin-api`. Images must never contain secrets. ECR is deferred. The running Lightsail API predates image approval; the Netlify client already exposes Image Queue.

## CI and image checks

`ci.yml` checks client and server on PRs and master pushes and builds and scans the AMD64 image with Trivy for HIGH and CRITICAL operating-system and language-package vulnerabilities. Scan failures block the job; investigate findings, including unfixed ones, rather than disabling the gate. `api-image.yml` is an additional manual or server-change build and scan; it does not publish. Workflows must be merged before either check runs. Track Node 22 security updates and rebuild regularly; a floating base tag does not update an existing image.

## Release and approval

This is an operator-run deployment, not automatic deployment. After Frank merges, build from the exact commit with `docker buildx build --platform linux/amd64 --load -f server/Dockerfile -t beerpassport-admin-api:<commit> server/`. Scan the image; inspect the final image for secrets. Obtain Frank's approval before tagging and pushing to the public Docker Hub repository. Record the immutable registry digest and verify the image corresponds to the reviewed commit. Frank separately approves the digest and exact production command. The `deploy-api.yml` template validates digest format only; it neither verifies image provenance nor records an approval.

Place the reviewed deploy and rollback scripts on Lightsail only after approval. The operator runs `scripts/deploy-api.sh frankpizz10/beerpassport-admin-api@sha256:<digest>` on the host. The script pulls before stopping the current container, starts on Docker's default bridge with port 4100 bound to localhost, connects `beerpassport-backend`, verifies liveness and a read-only database query, and attempts to restore the previous container on failure. Runtime configuration is read from `/etc/beerpassport/secrets/admin-api.env`; never print or commit it. `scripts/rollback-api.sh` is the manual rollback path. Rehearse both paths on disposable containers before production.

The existing Netlify site is independently deployed. Before publishing a client that requires new API behavior, deploy and verify the compatible API first, then explicitly approve publishing the client. Prevent auto-publication or maintain backward compatibility; this ordering is an operator rule and is not enforced by these templates.

## First image workflow release

The image queue needs migration 001, the viewer grant, restricted approver role and verification, `DATABASE_URL_WRITE`, and an updated API. Take and verify a current backup; review and separately approve each database change, role/secret change, image publication, and deployment command. Verify the queue as a signed-in admin and use a separately approved candidate to check decisions. Never use an unauthenticated 401 response as proof that the authenticated queue or write path works.

## Recovery and costs

Keep the existing API container until the new service passes both checks. If automatic restoration fails, use the retained container and investigate; do not assume a restart succeeded. Images are public on Docker Hub; verify all layers are free of secrets before upload. Scan and build minutes and storage depend on usage and account plan. No ECR objects or AWS users are required for this phase.
