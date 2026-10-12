# Owner-paused cutover and recovery

Prepared only. Nothing here authorizes a deployment, import, schedule, DNS change, production write or deletion.

## Preparation gates

- Protect GitHub dev/prod and aws-dev/prod-apply environments with owner review. CI never deploys Dokploy. Configure scoped Cloudflare API/Doppler tokens, AWS OIDC roles and separate dev/prod state keys.
- Create D1 databases with Wrangler after authorization, replace the explicit database-ID placeholders in wrangler.jsonc, and configure the app's custom hostname. Preserve the existing .example.com viewer-cookie scope.
- Terraform ZIP root references the existing Singapore S3 bucket and CloudFront distribution as data sources. Plan/apply new ZIP resources separately from any content-delivery adoption. Review existing bucket policies, CORS and signing identities; no original object copy or remote setting change is part of local implementation.
- Populate ZIP_SERVICE_SECRET in Doppler. Worker secrets flow directly to Wrangler; the same ZIP secret flows to a standard SSM SecureString outside Terraform state. Keep SESSION_SECRET and CloudFront signing key unchanged so sessions and private delivery survive.
- Build via CI, deploy AWS ZIPs from that immutable CI artifact, place the returned ZIP_SERVICE_URL in Doppler, then release the Worker. Initial Worker release may omit the ZIP endpoint while AWS is prepared. Deployment workflows are manual; apply uses a protected second job with the saved plan.
- Prove real dev authentication/email, presigned checksum PUT/HEAD, private CDN views/range/download/CORS, asynchronous Lambda/API Gateway/IAM, callback replay and failure recovery. S3Mock and local Lambda emulation do not prove AWS permissions or signatures.
- Validate D1 backups/Time Travel and exported snapshots. Before enabling schedules, review cleanup and add an incomplete-multipart lifecycle rule without replacing existing original-byte retention. Add failure-queue monitoring. Environment cron arrays remain empty until separately authorized.
- Rehearse at the current catalog scale. The source audit must explain every anomaly and operational row; do not use --accept-review for production without an explicit recorded disposition.

## Paused migration

1. Nas quits/pauses the desktop uploader and closes browser uploads. Let active requests and jobs finish. Record unfinished work and multipart uploads; stop both Dokploy web and worker. Keep PostgreSQL read-only and keep the pinned old image and original settings for recovery.
2. Take a restorable PostgreSQL backup and export with `MIGRATION_SOURCE_URL=... bun apps/cloud/scripts/migration/export.ts <new-empty-directory>`. The export is one read-only repeatable-read snapshot; timestamp microseconds, bigint text and every original SQL table remain in checksummed JSONL. Never print the connection URL.
3. Run audit.ts, import.ts into a new local .sqlite, and reconcile.ts. An interrupted import resumes by table checkpoint. Inspect the independent per-field reconciliation and operational dispositions. Original/preview keys and bytes remain unchanged; historical jobs/rate-limit rows remain in legacy tables. Interrupted archives are visible failures, and completed archive outputs retain their existing keys.
4. Produce SQL with sql.ts, then import into a newly created empty D1 database with Wrangler `d1 execute --remote --file`. Parent-before-child rows precede runtime triggers; migration tracking prevents the release workflow from reapplying the schema. Do not import into a nonempty or live database. Retain source/local import/SQL/checksums, and perform independent destination reconciliation before cutover.
5. Publish only generated ZIP manifests with manifests.ts after separate authorization; this does not copy originals. Check original and preview objects with bounded real HEADs and compare lengths/checksums. Missing objects or unexplained record differences stop cutover. Validate completed archives whose historical manifest references remain visible; ambiguous/missing historical path mappings must be reviewed.
6. Deploy AWS/Worker resources with maintenance disabled. Rehearse read-only catalog/auth/private downloads while the uploader stays paused. Nas authorizes endpoint/custom-domain switching separately. Keep old Dokploy services stopped so cached DNS cannot produce split-brain writes.
7. Only after owner review, authorize the production maintenance schedule and resume ingestion. Verify one real desktop upload/finalization/local-source removal and one browser upload/preview before continuing the full inbox.

## Recovery

Before new writes, disable the new runtime and restore the old endpoint/image against the unchanged PostgreSQL snapshot if needed. Once D1 accepts writes, it is authoritative: forward-fix or restore a rehearsed D1 backup and reconcile all later uploaded objects/metadata before reopening writes. Do not switch back to stale PostgreSQL. Keep old database/export/image until Nas explicitly authorizes retirement.

Code rollback uses the previous Wrangler deployment and previous Lambda artifact. It does not reverse data migrations. Inspect schema compatibility first. Secrets and S3 originals are never part of a code rollback.
