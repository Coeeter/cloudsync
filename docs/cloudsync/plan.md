# CloudSync implementation plan

Status: Approved; implementation in progress.

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

- Stages 1–4 implemented; stage 5 infrastructure provisioned (Doppler `cloudsync` dev/prod, mirrored private S3 buckets, OAC-only CloudFront at `files-dev.example.com` and `files.example.com`, ACM certificate).
- Dev runs against local PostgreSQL (`compose.dev.yml`) and the real AWS dev bucket; `bun run dev` starts the web app and the preview worker.
- PIN emails always go through Resend. The former `DEV_AUTH_CODE` bypass was removed; the unused Doppler value can be deleted.
- Explicit downloads use short-lived S3 presigned URLs with an attachment `Content-Disposition`, because CloudFront does not forward `response-content-disposition`. Thumbnails, previews, and viewer media go through CloudFront.
- Verified: presigned browser PUT with SHA-256 checksum against the dev bucket, PIN verification, and session establishment.

## Remaining work

- Owner validation of the web flows (upload, previews, rename/move/trash/restore/ZIP) and Electron ingestion against a temporary inbox.
- Package the Electron app (`bun --filter @cloudsync/desktop package`) and place it in `~/Applications`.
- Production: `DATABASE_URL`, Dokploy web (`bun apps/cloud/.output/server/index.mjs`) and worker (`bun apps/cloud/dist-worker/worker.js`) services, `sync.example.com` DNS, and adding `https://sync.example.com` to the prod bucket CORS origins.

## Blockers

- DNS changes and final Dokploy production deployment require owner action.
