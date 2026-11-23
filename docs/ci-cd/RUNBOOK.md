# Admin API CI/CD and release runbook

PR approval does not activate the pipeline or authorize infrastructure changes. Frank merges pull requests. Database migrations remain separate approved changes.

## Automatic release after setup

The active workflow is `.github/workflows/ci.yml`. Critical image findings fail CI and deployment; high findings are reported as warnings with details in the job log. Scanner execution errors remain failures. Pull requests run client and API checks and build and scan an AMD64 image on GitHub-hosted runners. A master push or manual master dispatch runs those checks first. When `BP_AUTO_DEPLOY_ENABLED=true`, the deploy job rebuilds and scans the release image, pushes it to the existing public Docker Hub repository using a repository-scoped Docker Hub token, captures the digest, and invokes version 1 of the fixed `BeerPassportDeployAdmin` Systems Manager document. The document accepts only a SHA-256 digest and invokes `/opt/beerpassport-admin/deploy-api.sh` with a fixed repository. CI does not run migrations. Concurrent deployment jobs are serialized; a job checks that its commit is still master before publishing and before requesting deployment. CI reports SSM execution failures. The API release is therefore automatic after merge only once the setup below has been explicitly approved and completed.

Lightsail must be registered as a Systems Manager hybrid managed node. AWS lists no hybrid-node registration charge and $0.002 per Run Command invocation as of 2026-11-23; ten deployments cost about $0.02 in command charges. GitHub Actions minutes and network bandwidth depend on plan and usage. Verify current pricing before setup. Install the reviewed deployment script at `/opt/beerpassport-admin/deploy-api.sh` as root-owned, not writable by the application or its runtime accounts. The existing root-only env file is `/etc/beerpassport/secrets/admin-api.env`. The script preserves localhost port binding, attaches the internal database network, verifies HTTP liveness and a database read, and attempts rollback on failure. Rehearse startup, network and DB failures on disposable infrastructure before enabling.

## Required one-time setup (each production change requires Frank's approval)

1. Merge this PR. Keep `BP_AUTO_DEPLOY_ENABLED` absent or false until all setup and the first image migration are complete. Do not assume a workflow environment automatically enforces an approval.
2. Create a Docker Hub access token restricted to pushing only `frankpizz10/beerpassport-admin-api`. Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as GitHub Actions secrets. The repository is public: image source and layers are public, so never include secrets in the build context or layers.
3. Install and register SSM Agent on Lightsail through a one-node hybrid activation and a dedicated minimal managed-node IAM role. Record the resulting `mi-...` ID in GitHub variable `BP_SSM_NODE_ID`; do not expose activation codes.
4. Create the custom document from `docs/ci-cd/ssm-deploy-document.json` and install the reviewed root-owned deploy script on the host. Restrict its file ownership and permissions; the SSM document must not accept arbitrary command text.
5. Set up GitHub OIDC with `aud=sts.amazonaws.com` and the exact `repo:FrankPizz10/beer-passport-admin:ref:refs/heads/master` subject, checking the actual token subject for this repository. Use the example trust and policy files in this directory as a starting point; replace the managed-node placeholder and verify the actual token subject and IAM scope. Use a dedicated deploy role. Permit `ssm:SendCommand` only for the specific `BeerPassportDeployAdmin` document and managed-node ARN; permit the minimum read actions needed for command status. Do not grant document mutation, IAM administration, generic shell documents, or unrelated nodes. Store its ARN in `BP_DEPLOY_ROLE_ARN`. Protect master and workflow modifications.
6. Test the pinned document version and IAM policy with a harmless disposable node; verify denial for other documents, nodes, malformed digests, and non-master OIDC subjects. Never test with production mutations without approval.
7. Apply the separately reviewed image-workflow migration, viewer grant, and approver role only after a verified backup and explicit approval. Verify the role, securely set `DATABASE_URL_WRITE`, and confirm the first release has a rollback plan.
8. Explicitly approve and set `BP_AUTO_DEPLOY_ENABLED=true`; dispatch the workflow on master or merge a change. Verify the published digest, SSM result, HTTPS health, authenticated queue and database access. Monitor and document rollback.

## Netlify ordering

Netlify currently publishes master independently and can outrun the API. This PR does not control Netlify. Until a separate coordinated client release is implemented, maintain client compatibility with the currently deployed API or hold Netlify publishing and release the API first. Merge approval alone does not make an incompatible simultaneous client/API change safe.

## Recovery

The script records the prior image and retains the old container. On a failed switch it attempts restoration; confirm the old service is healthy. For a later rollback use the reviewed rollback script after Frank's approval. Stop auto deployment by setting `BP_AUTO_DEPLOY_ENABLED=false` and investigate. Keep database backups; an API rollback does not undo migrations. Scan results are a point-in-time view; rebuild on Node and base-image security updates.
