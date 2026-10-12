# Owner-paused cutover and recovery

Stopped by Nas on 2026-10-12. Nothing here authorizes a deployment, import, schedule, DNS change, production write or deletion; each needs a fresh instruction.

## Preparation gates

- Complete the one-time setup in [releases](releases.md) and let a `main` push deploy. The prod D1 ID is already in `wrangler.jsonc`, and that database is empty. The first deploy applies the schema.
- Keep SESSION_SECRET and the CloudFront signing key unchanged, so desktop sessions and private delivery survive. Keep the `.example.com` viewer-cookie scope.
- The bucket already has an abort-incomplete-multipart (7 days) and noncurrent-version (30 days) lifecycle rule. Do not replace it. Review scoped expiry for `downloads/` and `system/` separately.
- Prove real auth/email, presigned checksum PUT/HEAD, private CDN views/range/download/CORS, API Gateway → async Lambda → callback, and failure recovery once the domain points at the Worker. S3Mock and local Lambda emulation do not prove AWS permissions or signatures.
- Rehearse at current catalog scale. The source audit must explain every anomaly; do not use `--accept-review` for production without a recorded disposition.

## Paused migration

1. Nas pauses the desktop uploader and closes browser uploads. Let active work finish, record unfinished uploads, and stop both Dokploy web and worker. Keep PostgreSQL read-only, and keep the old image and settings for recovery.
2. Take a restorable PostgreSQL backup and export with `MIGRATION_SOURCE_URL=... bun apps/cloud/scripts/migration/export.ts <new-empty-directory>`. The export is one repeatable-read snapshot in checksummed JSONL. Never print the connection URL.
3. Run `audit.ts`, `import.ts` into a new local `.sqlite`, and `reconcile.ts`. An interrupted import resumes by table checkpoint. Original and preview keys and bytes never change.
4. Run `sql.ts <local.sqlite> <import.sql>` to produce a data-only file for the already-migrated prod D1. Apply it with `wrangler d1 execute cloudsync-prod --remote --env prod --file <import.sql>`. Its first statement aborts if `entries` is non-empty. It drops the live-parent insert trigger while loading (trashed children of trashed folders would fail it), then recreates it and runs `PRAGMA foreign_key_check`. Then export the D1 database and reconcile it independently before switching.
5. Publish only generated ZIP manifests with `manifests.ts`; this does not copy originals. Check originals and previews with bounded real HEADs. Missing objects or unexplained differences stop the cutover.
6. Switch the domain: add `"routes": [{"pattern": "sync.example.com", "custom_domain": true}]` to `env.prod` and deploy. The existing DNS record for the VPS must be removed first, and the API token needs zone Workers Routes edit. Keep the old Dokploy services stopped so cached DNS cannot cause split-brain writes. The ZIP callback URL already targets this hostname.
7. After owner review, set the prod cron to `*/5 * * * *` and resume ingestion. Verify one real desktop upload/finalization/local-source removal and one browser upload/preview before continuing the full inbox.

## Recovery

Before new writes: remove the custom domain, restore the old DNS record, and restart Dokploy against the unchanged PostgreSQL. Once D1 accepts writes, it is authoritative: forward-fix, or restore D1 Time Travel, and reconcile later objects and metadata. Do not switch back to stale PostgreSQL. Keep the old database, export and image until Nas authorizes retirement.

Code rollback is `wrangler rollback` for the Worker, or reverting the commit, which redeploys the Lambda. Neither reverses data migrations.
