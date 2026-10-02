# CloudSync implementation plan

Status: Approved; implemented and deployed.

## Approach

Build a Bun/Turborepo TypeScript monorepo with:

- `apps/cloud`: TanStack Start React application served at `sync.example.com`, Effect RPC endpoint, Resend PIN authentication, cross-subdomain CloudFront cookie issuance for `files.example.com`, and worker entrypoint.
- `apps/desktop`: Electron + React/Vite application with one persistent inbox mapping, Keychain-backed session, reliable scan/watch/upload queue, notifications, and packaged macOS output.
- `packages/core`: reusable upload naming/finalization, storage, preview, and file-operation services.
- `packages/domain`: Effect schemas and RPC contracts shared by cloud, browser, and Electron.
- `packages/db`: Drizzle PostgreSQL schema, migrations, and catalog/job queries.
- `packages/ui`: shared shadcn-style components and the dark visual system.

Pin one matching Effect v4 RC package set and use its shipped documentation as the implementation authority. Use Effect RPC for all browser/desktop application calls. Use direct S3 presigned uploads and explicit finalization; use PostgreSQL jobs for previews and cleanup rather than treating S3 notifications as a transaction log.

## Important constraints

- Never read or print Doppler secret values. Transfer the existing Resend secret from `other-project-api` to the new project only through a direct pipe.
- Preserve arbitrary Unicode/path names and ignore `.DS_Store`.
- Do not proxy upload bytes through the cloud server.
- Keep the Dokploy application and CloudFront file delivery on separate origins. CloudFront fronts only private S3 objects and previews.
- Do not remove a local source until remote checksum verification and metadata commit both succeed.
- Keep physical S3 keys immutable; moves and renames update catalog state.
- Keep preview failures independent from original-file durability.
- Keep shared behavior in core/domain packages rather than duplicating desktop and browser implementations.

## Stages

1. Establish workspace tooling, pinned dependencies, environment schema, database schema/migrations, and Effect RPC contracts.
2. Implement catalog, authentication, S3 upload/finalization, signed delivery, collision naming, file operations, search, recycle bin, and worker jobs.
3. Implement the dark responsive TanStack Start file manager and real browser upload flow.
4. Implement the Electron inbox scanner/watcher, direct uploader, deletion invariant, retry UX, notifications, and local packaging.
5. Add container/Dokploy assets, Doppler project/configuration transfer, and AWS provisioning scripts or documented commands.
6. Validate the real local application with PostgreSQL and S3-compatible/AWS storage when available; exercise browser UI, Electron ingestion, database state, source deletion, container startup, and broad repository checks.

## Validation

- Start real PostgreSQL and object storage services, apply real migrations, and run cloud web plus worker processes.
- Authenticate through the real PIN flow using a development mail sink when production Resend delivery is not safe.
- In a real browser, create folders, upload files/directories, inspect grid ordering/covers/previews, rename/move/search/download/delete/restore, and verify persisted database/object state.
- Run the packaged or development Electron app against a temporary inbox, observe upload/finalize, inspect S3 and PostgreSQL, and confirm only verified sources are deleted while failures remain.
- Build and run the production container using its documented process modes and health endpoint.
- Run formatting, linting, type checking, tests for non-trivial deterministic logic, and production builds.

## Current state

- All stages implemented and deployed; owner validated the web flows and desktop ingestion in dev. Infrastructure (Doppler `cloudsync` dev/prod, mirrored private S3 buckets, OAC-only CloudFront at `files-dev.example.com` and `files.example.com`, ACM certificate).
- Dev runs against local PostgreSQL (`compose.dev.yml`) and the real AWS dev bucket; `bun run dev` starts the web app and the preview worker.
- PIN emails always go through Resend. The former `DEV_AUTH_CODE` bypass was removed; the unused Doppler value can be deleted.
- All file-body reads and explicit downloads use CloudFront. Download URLs are signed for the exact object and attachment filename; a viewer-response function applies the filename per request. Uploads, metadata checks and deletes remain on S3. The update is deployed and validated in production; the completed evidence is recorded in [the rollout record](../archive/cloudfront-reads/plan.md).
- Verified: presigned browser PUT with SHA-256 checksum against the dev bucket, keyset pagination against real data, Recycle Bin browsing, the production image (web + worker) against real Postgres and S3, and the public deployment (TLS, health, RPC, unsigned CDN requests rejected).

## Production

- Live at `https://sync.example.com` on Dokploy project `cloudsync` (VPS `my-vps`): `web` (image default command, domain on port 3000 with Let's Encrypt), `worker` (command `bun apps/cloud/dist-worker/worker.js`, Swarm health check disabled), and Dokploy Postgres 17 `database`.
- Image `ghcr.io/coeeter/cloudsync:latest` is built by GitHub Actions on every push to `main`; Dokploy pulls it through its GHCR registry access.
- App env is Doppler `cloudsync/prod` (minus `DOPPLER_*` and `DOKPLOY_API_KEY`) pushed through the Dokploy API; `DATABASE_URL` points at the Dokploy Postgres service.
- Both CloudFront distributions use PriceClass_200 (Singapore edge) and response headers policy `cloudsync-immutable-private`.

## Remaining work

- Package the Electron app (`bun --filter @cloudsync/desktop package`), move it to `~/Applications`; packaged builds default to `https://sync.example.com`.
- Deploys are manual: after CI publishes a new image, redeploy `web` and `worker` in Dokploy.

## Blockers

- None.
