# AWS ownership

`zip/` owns only new ZIP resources. It references existing S3/CloudFront with data sources and never changes their configuration. Cloudflare owns the app hostname; API Gateway exposes POST /zip/{id} to the Worker. CloudFront remains file delivery, and CloudFormation is not needed.

`adoption/delivery/` preserves the earlier prepared adoption module as a separate, unapplied starting point. Refresh live inventory and prove a zero-change import plan in isolated local state before adopting it. Never combine content adoption with ZIP creation or apply stale snapshots. No state import, apply, DNS update, or remote bucket mutation has been authorized.

Use separate state keys for dev/prod ZIPs and content adoption. Bootstrap a private versioned state/artifact bucket separately; use the S3 backend with `use_lockfile=true`. CI uses environment-scoped AWS OIDC roles; role creation and protected GitHub environments require owner setup. Artifact bucket/key/hash refer to one immutable zip.mjs package built by CI. Promote that same artifact to prod.

Set the ZIP secret outside Terraform: a standard SSM SecureString at the configured `secret_parameter`, using the same Doppler ZIP_SERVICE_SECRET as Wrangler. No Terraform secret resource/data source is used. The Lambda role reads its one parameter; the default aws/ssm key is sufficient. IAM privileges for Workers' existing S3 credentials must cover original/preview uploads and HEADs, system/zip-requests writes, zip-outcome reads, and deletion cleanup. Restrict to the environment's bucket; never rotate existing production credentials during this migration.

All AWS ZIP bytes remain in Singapore. One builder runs at a time; asynchronous invocation buffers submissions. Capture exhausted async failures in the queue and monitor it. Configure an alarm separately before production. D1 reconciliation recovers lost callbacks and marks expired leases failed; requests can be prepared again.

Do not add a new lifecycle configuration over the existing bucket's rules. Separately review adding scoped temporary ZIP/manifest/outcome expiry and incomplete multipart cleanup; originals must remain untouched. These are cutover gates, not an authorized apply.
