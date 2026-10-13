# CloudSync

A private, single-owner cloud archive. A macOS app drains a local inbox folder into
S3 and deletes each file only after the cloud copy is verified; a web app browses,
previews and manages the archive.

## How it works

- **Desktop** (`apps/desktop`, Electron) watches one inbox folder, generates image,
  video and PDF previews locally, and uploads originals straight to S3 with
  short-lived authorisation. A file is removed locally only after its checksum is
  verified and its metadata is committed, so an interrupted upload never loses data.
- **Cloud** (`apps/cloud`, TanStack Start on Cloudflare Workers + D1) is the catalog,
  Effect RPC API and file manager: browse, search, rename, move, a 30-day recycle bin
  and a media viewer. A scheduled Worker reconciles abandoned uploads and missing
  previews without relying on ordered or exactly-once S3 events.
- **Storage** is a private, versioned S3 bucket. Reads go through CloudFront with
  Origin Access Control and signed cookies, so the app and file delivery are separate
  origins and no object is ever publicly addressable.
- **Folder downloads** are streamed ZIP archives built by an AWS Lambda
  (`infra/terraform/zip`), so archive size never depends on server disk.
- **Sign-in** is a single-use email PIN for one configured address; the desktop app
  keeps its session in the macOS Keychain.

Physical S3 keys are immutable and independent of logical paths, so renames, moves
and restores are catalog-only operations, and upload finalisation is idempotent.

## Stack

Bun, TypeScript, Effect, TanStack Start, Drizzle, Cloudflare Workers and D1, AWS
S3, CloudFront and Lambda, Terraform, Electron, Turborepo.

## Development

Secrets come from Doppler.

```sh
bun install
doppler run --project cloudsync --config dev -- bun run dev
bun run check && bun run lint && bun run test
```

See [`docs/cloudsync/development.md`](docs/cloudsync/development.md) for local setup
and [`docs/cloudflare/releases.md`](docs/cloudflare/releases.md) for the deploy pipeline.
