# CloudFront object reads implementation

Status: Complete; committed, pushed, deployed and verified in production on 2026-10-02. Coordinated with another project's matching deployment.

## Completed

- Worker and folder archive body reads use short-lived exact-object signed CloudFront URLs. File download tickets include signed attachment parameters instead of S3 presigned GETs.
- Uploads remain S3 presigned PUTs; checksum HEAD and deletes remain direct S3 operations. Existing CloudFront viewer URLs/cookies retain their authorization and cache behavior.
- The viewer-response download function is live on both development and production distributions and applies each filename per request without affecting shared cached object metadata.
- Preview decode/container failures terminate after one attempt, remain visible, and are excluded from automatic requeue. Storage failures retain bounded retries; the attempt limit now counts claimed attempts correctly. Process termination remains retryable.
- Production snapshots and applied configuration are under ignored `tmp/cloudfront-reads/prod/`. The distribution and viewer-response function are deployed.

## Validation

- Real signed development CDN: binary bytes, Unicode and independent filenames, HTTP 206 range, and unsigned/tampered/expired rejection after warming the cache. Passed.
- `apps/cloud/scripts/validate-cloudfront-reads.ts` with a disposable local PostgreSQL and development credentials exercises the actual folder-download HTTP route with a real session row: unauthenticated access rejected, authenticated ZIP streamed from CDN sources; `unzip -t` passed.
- `apps/cloud/src/server/services/worker.integration.test.ts` against real disposable PostgreSQL and the development CDN: valid PNG creates WebP previews, deterministic animated WebP decoding failure terminates after one attempt, a missing-object storage failure remains retryable, and an immediate next worker cycle does not retry the permanent failure. Passed.
- Run the worker integration with `CLOUDSYNC_TEST_DATABASE_URL` pointing at a disposable localhost database and Doppler cloudsync/dev. For the folder HTTP check, set `DATABASE_URL` to the same database before launching and pass `--preserve-env=DATABASE_URL` to Doppler. Never use a production bucket/database. The integration test is skipped by default to prevent accidental external access.
- Fresh root format, check, lint, test, build passed with the repository's Bun 1.4.2.

## Production verification

- Application commits `299d6c7` and `b6af228`; GitHub Actions run `37007958542` passed checks and image publication. Both web and worker run registry digest `sha256:2adf6f957b5ef16f834b8fe6dfb10c6ecae70ca112adc10de0b6b02cc8aa9175`. Public health check passed and web container is healthy.
- Distribution `EPRODEXAMPLE00` and `cloudsync-download-response-prod` are deployed. Existing private file signed ranges and independent filenames passed; unsigned, altered and expired requests returned 403.
- Two tiny temporary production fixtures exercised the deployed worker: PNG previews were generated; malformed WebP ended after one attempt. The deployed authenticated file RPC returned a CloudFront ticket and original bytes. The deployed folder route rejected unauthenticated access and returned an authenticated ZIP that passed `unzip -t`.
- Temporary session, directory, entries, jobs, original objects and generated preview versions/markers were removed. The pre-existing job count was unchanged.
- Existing terminal WebP failures remain visible. This change prevents wasted retries and does not add a new animated WebP decoder.
- Actual savings need future billing evidence. No ongoing monitor or production schedule was enabled.

## Constraints

Development without CloudFront signing credentials now needs a functioning unsigned HTTP file origin; a private MinIO bucket alone cannot replace the removed S3 presigned GET fallback. The documented real AWS development CDN is supported and validated.

