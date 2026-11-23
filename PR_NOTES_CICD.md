# Automatic admin API delivery

GitHub Actions checks PRs and master; on master, after successful client, server and image-scan jobs, the opt-in deployment job rebuilds and scans the exact image, pushes it to the existing public Docker Hub repo by commit tag, and sends its digest through a fixed SSM document. The document invokes the root-owned reviewed deploy script. SSM hybrid setup, GitHub OIDC trust, least-privilege IAM, Docker Hub credentials and the enable switch require separate approval. Database migrations remain separately approved. Netlify remains independent; API/client compatibility or held client publishing is required.

The script attaches the internal database network and tests liveness and a database read. It serializes deployments and attempts rollback when switching fails. Node 22 replaces end-of-life Node 20. See docs/ci-cd/RUNBOOK.md for setup, cost, recovery and limitations.

Earlier local verification: 23 client tests and CI-mode build passed; 66 server tests passed and 4 DB tests skipped; AMD64 Node 22 image built and Prisma read succeeded against disposable PostgreSQL 16. Startup and network failure restoration were tested using mocks before the deployment lock was added. Workflow and SSM setup require independent verification; no production changes were made.
