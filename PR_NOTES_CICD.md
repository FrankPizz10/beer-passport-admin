# Admin delivery pipeline

Adds active GitHub workflows for client and server checks and AMD64 image build/scan. The image uses Node 22 and excludes secrets. Publishing to the existing public Docker Hub repository and deploying to Lightsail are separate operator actions approved by Frank; ECR is deferred.

The deploy script uses the existing root-only env file, attaches the API to the database network, checks liveness and a read-only database query, and attempts to restore the previous container when startup, attachment, or checks fail. Database migrations remain separate approved actions. See docs/ci-cd/RUNBOOK.md.

Local verification: client 23 tests and production build passed; server 66 tests passed, 4 DB tests skipped; AMD64 Node 22 image built and Prisma read succeeded against disposable PostgreSQL 16; mock startup and network failures restored the previous container. GitHub workflow and scanner results must be verified after push.
