# Release pipeline

`.github/workflows/deploy.yml` follows another project's pattern: every push and pull request runs check/lint/test; a push to `main` then deploys automatically. There are no manual release dispatches, protected environments, artifact buckets or saved-plan approvals. Only `prod` is deployed; development runs locally with Wrangler.

1. `zip` builds `dist-lambda/zip.mjs`, assumes the AWS deploy role through GitHub OIDC and runs `terraform apply` on `infra/terraform/zip`. It reads `ZIP_SERVICE_SECRET`, `S3_BUCKET` and `PUBLIC_URL` from Doppler individually. `doppler run` would also inject the Worker's AWS app keys over the role credentials. The secret goes into a write-only SSM parameter and stays out of state. The API Gateway URL becomes the job output.
2. `worker` builds with `CLOUDFLARE_ENV=prod`, applies pending D1 migrations to `cloudsync-prod`, then deploys. Secrets ship in the same version through `--secrets-file`; `scripts/release/secrets.ts` selects the Worker's keys from Doppler. `ZIP_SERVICE_URL` is passed as a plain var from the `zip` output.

Schema migrations run on every deploy and must stay additive. The one-time PostgreSQL data import is a separate cutover step; see [cutover](cutover.md).

## Sign-in

Cloudflare Access (Zero Trust, free tier) protects the custom domain, so the app has no sign-in code or session table of its own. The Worker still verifies the `Cf-Access-Jwt-Assertion` JWT on every route (signature against the team's certs, issuer and the application's AUD), so a request that skips Access is rejected. `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `ACCESS_AUD` live in Doppler `cloudsync/prod` like the other deployment identifiers.

Access applications on the Worker domain, created with `cf zero-trust access applications create`:

- The app itself: self-hosted, session duration `720h`, one-time PIN login, one allow policy including the owner email. Its `aud` is `ACCESS_AUD`.
- `<domain>/internal/zip`: a bypass policy for everyone. The ZIP Lambda authenticates with `ZIP_SERVICE_SECRET` instead.
- `<domain>/health`: a bypass policy for everyone, for deployment checks.

The desktop app opens `/auth/desktop?port=…&state=…` in the system browser. After Access signs the browser in, the Worker redirects to `http://127.0.0.1:<port>/callback` with the Access token, which the app sends as `cf-access-token` on every RPC. When Access rejects it (a redirect to the login page once the session expires), the app signs out and asks to sign in again.

## One-time setup (not done)

- AWS: with admin credentials, `terraform init && terraform apply` in `infra/terraform/bootstrap`. This creates the state bucket `cloudsync-terraform-123456789012`, the GitHub OIDC provider, and `cloudsync-github-deploy`, which only `main` of Coeeter/cloudsync can assume. Its local state is gitignored; the resources can be re-imported.
- Doppler `cloudsync/prod`: add `ZIP_SERVICE_SECRET` (e.g. `openssl rand -hex 32`). Everything else the Worker needs already exists there.
- GitHub repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts edit + D1 edit on the account; add Workers Routes edit on example.com before the domain switch) and `DOPPLER_TOKEN` (a read-only service token for `cloudsync/prod`). Deployment identifiers are kept out of the public repository and its logs as repository secrets: `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`, `CLOUDFLARE_ACCOUNT_ID` and `WORKER_DOMAIN` (the custom domain passed to `wrangler deploy --domain`). The D1 ID stays in `wrangler.jsonc`; it is useless without an API token.
- Delete the now-unused repository secrets `DOKPLOY_WEB_DEPLOY_URL` and `DOKPLOY_WORKER_DEPLOY_URL` once Dokploy is retired.

Until this is done, the `zip` and `worker` jobs fail on `main`, and that failure is expected. Checks are unaffected.

## Behaviour before cutover

A deploy creates the `cloudsync` Worker on its workers.dev URL with an empty, migrated D1. No custom domain is attached, so sync.example.com keeps serving Dokploy. Browser uploads from workers.dev are blocked by the bucket CORS rule, which allows only https://sync.example.com. ZIP callbacks target `PUBLIC_URL`, the old host, until the domain moves. Pre-cutover checks are therefore limited to health, auth and read-only RPC.

Remote cron stays empty. Maintenance purges trash older than 30 days and deletes S3 objects, so enable it only after cutover. Without it, expired ZIP leases, abandoned uploads and permanent deletes are not cleaned up.
