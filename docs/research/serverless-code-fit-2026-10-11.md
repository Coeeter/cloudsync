# Cloudsync serverless fit — 2026-10-11

## Recommendation

Move the web/API and short background jobs to managed, event-driven compute. Preserve PostgreSQL initially; DynamoDB is a possible deliberate redesign, not a deployment substitution. Existing S3 and CloudFront remain. A final platform/pricing comparison is in `serverless-platforms-2026-10-11.md`.

## Fresh production evidence

Read-only aggregate queries on the production PostgreSQL database returned:

- 114 MB database; 74,723 entries, including 73,529 files.
- File metadata totals 157,888,168,986 bytes in existing object storage; largest current file 78,837,759 bytes.
- 71,469 completed preview jobs, four completed archive jobs, two completed object deletion jobs.
- The four retained archives have at most 374,723,030 bytes and 54 manifest entries. Their job creation-to-completion intervals are 30.17 seconds average and 38.24 seconds maximum.
- For 71,307 successful previews, final claim-to-completion intervals average 1.11 seconds, p95 1.99 seconds, maximum 76.30 seconds. This is a useful current-server processing proxy, not a Lambda benchmark.
- Preview creation-to-completion intervals include substantial queue wait and are **not** processing durations or suitable Lambda cost estimates. A bulk-import workload must be measured separately.

These are current aggregates, not guarantees of future file/archive limits.

## Actual code constraints

- `apps/cloud/vite.config.ts`: TanStack Start + Nitro currently use the Bun preset.
- `apps/cloud/src/server/layers.ts` and `packages/db/src/index.ts`: database migrations run at service-layer initialization. Move migrations to a deployment task; avoid a migration/advisory lock on every cold start. A standalone `bun run db:migrate` command already exists.
- `packages/db/src/schema.ts`: relational tables, folder adjacency, per-folder active-name uniqueness, sessions, pins, uploads, jobs, rate limits, and archive manifests.
- `packages/db/drizzle/0001_natural_sort.sql`: PostgreSQL ICU natural collation and indexed listing order. D1 needs a replacement sorting representation; Dynamo needs explicit query keys.
- `apps/cloud/src/server/services/catalog.ts`: PostgreSQL transaction advisory locks, row locks, recursive traversal, keyset ordering, and atomic upload finalization. Changing database changes the correctness mechanisms protecting simultaneous operations.
- `apps/cloud/src/server/services/selection.ts`, `folder-covers.ts`, and `archives.ts`: recursive relational folder queries. Dynamo requires designing access patterns and traversal/move behavior instead of swapping a Drizzle adapter.
- `apps/cloud/src/server/services/worker.ts`: Bun.Image plus ffmpeg, Poppler, and webpmux; filesystem and child-process access. These native paths cannot run unchanged in a Cloudflare Worker. Lambda needs a supported runtime/custom runtime and native binaries built for its OS/architecture; Node with sharp is another adaptation.
- The current worker has four polling consumers, PostgreSQL SKIP LOCKED claims, retry/backoff and hourly cleanup. Replace with queue-triggered jobs and scheduled cleanup, retaining business-state correctness.
- Worker timeouts: ten minutes for previews/deletes and two hours for archives. Preview sources are currently fully buffered in memory. Large sources need streaming to temporary storage and explicit resource limits.
- `archive-builder.ts`: filesystem staging and streaming ZIPs with a 256 MiB batch target, but a single file may exceed that target. No overall archive-size bound establishes Lambda suitability. Current small archives are encouraging, but preserving unbounded behavior needs an on-demand container fallback or a separately approved product limit.

## Event semantics

`Catalog.finalizeUpload` verifies S3 length/checksum, verifies any desktop-generated previews, creates the catalog entry transactionally, and only queues server previews when verified previews are missing. S3 object creation can arrive before that finalization, and includes uploads that might never be finalized.

Prefer a finalized-upload business event → durable queue → thumbnail Lambda. Preserve an outbox or equivalent reliable publication mechanism so a DB commit followed by a failed queue send cannot lose work. Make consumers idempotent using the entry/source/generation identity. If using S3 notifications, filter original object prefixes, reconcile against finalized metadata, and handle duplicate/out-of-order delivery. Preview output must not recursively trigger new preview work.

Cleanup becomes scheduled work; object deletion becomes queued work. Files and ZIP output continue to upload/download directly from object storage rather than passing through the API.

## Hermes

User said Hermes is unused and unwanted. Stopped its Compose service on my-vps and verified status `exited`, restart policy `unless-stopped`, and retained volume `unrelated_service_data`. No volume, image, deployment configuration, or application data was deleted. Dokploy redeployment could start it again; omit Hermes from migration.

## Scope

Code inspection and read-only production aggregates only, plus the authorized reversible Hermes stop. No Cloudsync code changes, infrastructure creation, paid-resource deployment, or database migration performed.
