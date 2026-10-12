# AWS ownership

`bootstrap/` is applied once by the owner with admin credentials. It creates the state bucket, the GitHub OIDC provider and the `cloudsync-github-deploy` role, which only `main` can assume. Its state is local and gitignored.

`zip/` owns only the new ZIP resources: two Lambdas sharing one `zip.mjs`, API Gateway `POST /zip/{id}`, roles, logs, a failure queue and the SSM secret. CI applies it on every push to `main`. It refers to the existing content bucket by name and never changes the bucket's configuration. The Lambda code is zipped from `apps/cloud/dist-lambda/zip.mjs`, so run `bun run --cwd apps/cloud build:lambda` before any local plan.

`ZIP_SERVICE_SECRET` comes from Doppler and is written to a write-only SSM parameter, so it never enters state. Its version is derived from the value, so a rotation reaches Lambda on the next deploy. The Worker gets the same Doppler value.

No reserved concurrency: the account limit is 10, and AWS rejects any reservation that leaves fewer than 10 unreserved. Leases make duplicate builders harmless. Exhausted async failures land in `cloudsync-zip-failures`, and nothing alarms on it yet.

`adoption/delivery/` is an earlier, unapplied adoption sketch for the existing S3/CloudFront resources. Refresh the live inventory and prove a zero-change import plan in isolated state before using it. Never combine it with the ZIP root.
