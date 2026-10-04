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
