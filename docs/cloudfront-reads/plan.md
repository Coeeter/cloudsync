# CloudFront object reads implementation

Status: Local implementation complete and validated on 2026-10-02; production rollout authorized and in progress. Coordinated with [another project's plan](../../../other-project/docs/cloudfront-reads/plan.md).

## Completed

- Worker and folder archive body reads use short-lived exact-object signed CloudFront URLs. File download tickets include signed attachment parameters instead of S3 presigned GETs.
- Uploads remain S3 presigned PUTs; checksum HEAD and deletes remain direct S3 operations. Existing CloudFront viewer URLs/cookies retain their authorization and cache behavior.
- The viewer-response download function is live on the development distribution and applies each filename per request without affecting shared cached object metadata.
- Preview decode/container failures terminate after one attempt, remain visible, and are excluded from automatic requeue. Storage failures retain bounded retries; the attempt limit now counts claimed attempts correctly. Process termination remains retryable.
- Production drafts are prepared under ignored `tmp/cloudfront-reads/prod/`; production CDN updates have been accepted.

## Validation

- Real signed development CDN: binary bytes, Unicode and independent filenames, HTTP 206 range, and unsigned/tampered/expired rejection after warming the cache. Passed.
- `apps/cloud/scripts/validate-cloudfront-reads.ts` with a disposable local PostgreSQL and development credentials exercises the actual folder-download HTTP route with a real session row: unauthenticated access rejected, authenticated ZIP streamed from CDN sources; `unzip -t` passed.
- `apps/cloud/src/server/services/worker.integration.test.ts` against real disposable PostgreSQL and the development CDN: valid PNG creates WebP previews, deterministic animated WebP decoding failure terminates after one attempt, a missing-object storage failure remains retryable, and an immediate next worker cycle does not retry the permanent failure. Passed.
- Run the worker integration with `CLOUDSYNC_TEST_DATABASE_URL` pointing at a disposable localhost database and Doppler cloudsync/dev. For the folder HTTP check, set `DATABASE_URL` to the same database before launching and pass `--preserve-env=DATABASE_URL` to Doppler. Never use a production bucket/database. The integration test is skipped by default to prevent accidental external access.
- Fresh root format, check, lint, test, build passed with the repository's Bun 1.4.2.

## Remaining work: production rollout

1. Refresh drafts with `bun scripts/prepare-cloudfront-reads.ts prod`; create/update and publish the prepared function and associate it using a fresh distribution ETag.
2. Wait for propagation and verify an existing file with a small signed range request, unsigned/expired/tampered denial, and per-request filename isolation.
3. Deploy both web and worker; validate authenticated file/folder downloads and a tiny preview job.
4. Monitor worker errors and direct S3 outgoing transfer. Existing terminal WebP failures are not retried automatically; this change prevents wasted retries and does not add a new animated WebP decoder.

## Constraints

Development without CloudFront signing credentials now needs a functioning unsigned HTTP file origin; a private MinIO bucket alone cannot replace the removed S3 presigned GET fallback. The documented real AWS development CDN is supported and validated.

Production runtime, rollout, and post-rollout costs remain unverified until rollout verification.
