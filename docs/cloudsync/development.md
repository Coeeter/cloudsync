# Development and validation

Use Doppler project `cloudsync`, config `dev` for runtime configuration and credentials. Development already has a real private S3 bucket and CloudFront distribution at `files-dev.example.com`. Use these for uploads and preview integration tests. Do not substitute local object storage or placeholder AWS credentials, and never print secret values.

Start the app and worker with:

```sh
doppler run --project cloudsync --config dev -- bun run dev
```

Check existing processes and containers before starting services. `compose.dev.yml` provides only PostgreSQL on port 54329 when a local database is needed:

```sh
docker compose -f compose.dev.yml up -d postgres
```

Worker integration tests use an otherwise empty, disposable local database named `cloudsync_worker_test` and the real development S3/CloudFront environment. They create unique fixture objects and clean them up. Create the database once:

```sh
docker compose -f compose.dev.yml exec postgres psql -U cloudsync -d postgres -c 'CREATE DATABASE cloudsync_worker_test'
```

Then run the suites sequentially:

```sh
doppler run --project cloudsync --config dev -- sh -c '
  export CLOUDSYNC_TEST_DATABASE_URL=postgres://cloudsync:cloudsync@127.0.0.1:54329/cloudsync_worker_test
  bun test apps/cloud/src/server/services/worker-concurrency.integration.test.ts &&
  bun test apps/cloud/src/server/services/worker.integration.test.ts
'
```

The concurrency test gates real CDN responses to verify four simultaneous claims, immediate refill of a freed slot, successful persisted previews, and exactly one attempt per job. The rendering test covers valid images, terminal decode errors, and retryable download failures. Both refuse production buckets; the concurrency test also requires the dedicated local database because it owns the entire queue.

Run repository checks and build before publishing changes:

```sh
bun run check
bun run lint
bun run test
bun run build
```

Production inspection uses `docker --context remote`. Do not run integration fixtures against the production database or bucket. Nas deploys the built image through Dokploy.

## Desktop previews and releases

Desktop preview generation uses the installed `ffmpeg`, `pdftoppm` (Poppler), and `cwebp` tools. Finder launches do not inherit the shell's PATH, so the app checks `/opt/homebrew/bin` and `/usr/local/bin` before using PATH. Tools are not bundled. Install missing tools with `brew install ffmpeg poppler webp`.

Images and video frames are rendered to a PNG capped at 2200 pixels on the long edge. PDFs use their first page. `cwebp` creates the 480-pixel thumbnail and larger preview with shared worker quality settings. Each upload includes a versioned manifest with byte counts, SHA-256 checksums, and WebP animation classification. Missing tools, failed conversions, and failed preview uploads fall back to the worker without failing the original upload.

To validate the whole flow, start only the cloud server against the disposable test database, then run the live RPC suite in another terminal. Do not start a worker on that test database during this suite:

```sh
doppler run --project cloudsync --config dev -- sh -c '
  DATABASE_URL=postgres://cloudsync:cloudsync@127.0.0.1:54329/cloudsync_worker_test bun --filter @cloudsync/cloud dev
'

doppler run --project cloudsync --config dev -- sh -c '
  CLOUDSYNC_TEST_DATABASE_URL=postgres://cloudsync:cloudsync@127.0.0.1:54329/cloudsync_worker_test CLOUDSYNC_TEST_URL=http://localhost:3000 bun test apps/cloud/src/server/services/desktop-preview.integration.test.ts
'
```

This suite renders image/video/PDF fixtures, uploads through real RPC-issued S3 tickets, downloads previews through CloudFront, and inspects database jobs. It also covers partial preview uploads, mismatched metadata, older clients, conversion failures, and idempotent finalization.

Build the macOS arm64 release with `bun --filter @cloudsync/desktop package`. The output is `apps/desktop/dist/mac-arm64/CloudSync.app`. Quit the running application, replace `~/Applications/CloudSync.app` with that bundle, and reopen it. Keep its existing user-data directory and Keychain session; packaged builds default to `https://sync.example.com`. The optional preview protocol lets a newer desktop app continue uploading originals against an older server until the server is deployed.
