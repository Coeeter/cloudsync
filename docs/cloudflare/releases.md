# Release pipeline

`.github/workflows/deploy.yml` follows another project's pattern: every push and pull request runs check/lint/test; a push to `main` then deploys automatically. There are no manual release dispatches, protected environments, artifact buckets or saved-plan approvals. Only `prod` is deployed; development runs locally with Wrangler.

1. `zip` builds `dist-lambda/zip.mjs`, assumes the AWS deploy role through GitHub OIDC and runs `terraform apply` on `infra/terraform/zip`. It reads `ZIP_SERVICE_SECRET`, `S3_BUCKET` and `PUBLIC_URL` from Doppler individually. `doppler run` would also inject the Worker's AWS app keys over the role credentials. The secret goes into a write-only SSM parameter and stays out of state. The API Gateway URL becomes the job output.
2. `worker` builds with `CLOUDFLARE_ENV=prod`, applies pending D1 migrations to `cloudsync-prod`, then deploys. Secrets ship in the same version through `--secrets-file`; `scripts/release/secrets.ts` selects the Worker's keys from Doppler. `ZIP_SERVICE_URL` is passed as a plain var from the `zip` output.

Schema migrations run on every deploy and must stay additive. The one-time PostgreSQL data import is a separate cutover step; see [cutover](cutover.md).

## One-time setup (not done)

- AWS: with admin credentials, `terraform init && terraform apply` in `infra/terraform/bootstrap`. This creates the state bucket `cloudsync-terraform-123456789012`, the GitHub OIDC provider, and `cloudsync-github-deploy`, which only `main` of Coeeter/cloudsync can assume. Its local state is gitignored; the resources can be re-imported.
- Doppler `cloudsync/prod`: add `ZIP_SERVICE_SECRET` (e.g. `openssl rand -hex 32`). Everything else the Worker needs already exists there.
- GitHub repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts edit + D1 edit on the account; add Workers Routes edit on example.com before the domain switch) and `DOPPLER_TOKEN` (a read-only service token for `cloudsync/prod`). The account ID, D1 ID and role ARN are not secret; they are in `wrangler.jsonc` and the workflow.
- Delete the now-unused repository secrets `DOKPLOY_WEB_DEPLOY_URL` and `DOKPLOY_WORKER_DEPLOY_URL` once Dokploy is retired.

Until this is done, the `zip` and `worker` jobs fail on `main`, and that failure is expected. Checks are unaffected.

## Behaviour before cutover

A deploy creates the `cloudsync` Worker on its workers.dev URL with an empty, migrated D1. No custom domain is attached, so sync.example.com keeps serving Dokploy. Browser uploads from workers.dev are blocked by the bucket CORS rule, which allows only https://sync.example.com. ZIP callbacks target `PUBLIC_URL`, the old host, until the domain moves. Pre-cutover checks are therefore limited to health, auth and read-only RPC.

Remote cron stays empty. Maintenance purges trash older than 30 days and deletes S3 objects, so enable it only after cutover. Without it, expired ZIP leases, abandoned uploads and permanent deletes are not cleaned up.
