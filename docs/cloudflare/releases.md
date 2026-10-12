# Release setup

All workflows are prepared only; no credentials, projects, state or remote resource have been created.

CI checks types/lint/tests and publishes secret-free compiled artifacts named cloudsync-<commit SHA>. AWS ZIP release downloads that exact successful CI run's artifact, verifies its commit/workflow provenance, produces a deterministic zip.zip and uploads it under releases/<SHA>/zip.zip with checksum/no-overwrite checks. Terraform plans are saved, then a separate protected apply job applies that exact plan. CI no longer pushes latest images or triggers Dokploy.

Configure protected environments dev/prod for Workers, aws-dev/aws-prod for planning, and aws-dev-apply/aws-prod-apply for owner approval of the saved AWS plan. The repository must enable required reviewers before using these workflows; YAML cannot create that policy. Each AWS environment needs its scoped OIDC release role ARN and the same state/artifact configuration; apply environments also need a scoped Doppler token for the ZIP secret. Role trust must restrict the repository and exact GitHub environment subject. The artifact role needs only its environment's artifact prefix, ZIP resources and state key/lock file. Bootstrap state/artifact buckets separately; version and protect them.

Workers environments need CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a scoped DOPPLER_TOKEN. WORKER_HEALTH_URL must target the actual deployed Worker, rather than the old Dokploy hostname during preparation. Configure D1 database IDs in wrangler.jsonc only after authorized creation. Build uses CLOUDFLARE_ENV to select the matching configuration. Remote cron arrays are empty until separately authorized.

Doppler holds owner/session/AWS S3/CloudFront/Resend configuration plus ZIP_SERVICE_SECRET and, once AWS exists, ZIP_SERVICE_URL. scripts/release/secrets.ts selects those exact keys and pipes them to `wrangler secret bulk`; unrelated Doppler secrets never enter the Worker. GitHub stores tokens, not the copied app secret payload. The AWS apply step pipes only ZIP_SERVICE_SECRET into a standard SSM SecureString using its OIDC role, so Doppler's app AWS credentials never replace the deployment role. Terraform sees only the parameter name.

An initial Worker release can omit ZIP_SERVICE_URL while AWS is prepared. Deploy AWS from a successful CI artifact, copy the nonsecret endpoint URL into Doppler, then release the Worker. This avoids an artifact/deployment dependency cycle. Secrets, D1 migrations and Worker deployment are serialized by environment with cancel-in-progress=false. Production promotion is an explicit dispatch to a protected environment; it never follows an automatic main push.

The workflow health check verifies startup only. Before production cutover, validate authenticated RPC, current catalog, private CDN/CORS, Lambda callback/recovery and one authorized ingestion through the deployed artifact. Do not treat CI or a public health response as that evidence.
