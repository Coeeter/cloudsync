# Implementation plan

Status: approved, implementation in progress.

## Approach

- Extend domain RPCs with complete selection IDs, bulk catalog actions, archive creation, and archive status.
- Reuse existing catalog operations and worker claims. Normalize selected ancestor/descendant roots before bulk actions and archive snapshots.
- Persist archive manifests/status/progress/expiry in PostgreSQL. Reuse identical unexpired snapshots under a transaction lock.
- Download source files into bounded temporary batches, up to ten concurrently and about 256 MiB per batch (a larger individual file runs alone). ZIP stored entries into a multipart S3 upload; never buffer the entire ZIP or all selected originals in memory.
- Serve ZIPs directly via existing authenticated CloudFront signing. Sweep expired archives and remove their objects through the existing deletion queue.
- Extend the contact-sheet UI with selection controls, a contextual action toolbar, and archive progress. Keep original navigation and previews.

## Validation

- Exercise real RPC -> database -> worker -> development S3 -> signed CloudFront download. Inspect ZIP paths, duplicate suppression, Unicode/empty directories and byte integrity, reuse/invalidation, and failed reads.
- Validate actual concurrent source reads and cleanup in the development storage flow.
- Use the collaborative browser against a local server with a disposable database to exercise selection, all-results selection, exclusions, ZIP preparation/download, and bulk actions.
- Run repository check, lint, tests, and build. Never run fixtures against production.

## Progress

- Inspected catalog, browser, worker, and another project's archive implementation.
- CDN reads measured much faster than the current streamed folder downloads; PNG compression saves effectively no space.
- Local port 3000 belongs to another project; use a separate port for cloudsync validation.
