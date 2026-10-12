# Cloudsync AWS serverless migration

Superseded by [Workers + D1 with Lambda ZIPs](../cloudflare/plan.md), approved by Nas on 2026-10-12. Research is preserved; discarded DynamoDB implementation has a local backup at /tmp/cloudsync-before-d1.

Status: approved by Nas for local implementation on 2026-10-12 through execute-approved-plan in a new T3 Code Opus 5.5 thread. Product decisions were made on 2026-10-11/12. Production/shared-state changes remain separately authorized actions.

## Goal and non-goals

Move Cloudsync away from Dokploy toward managed, event-driven AWS services to reduce server maintenance. This is Nas's personal tool for pushing files from one computer to the cloud, not a multi-user production platform. A deliberate maintenance interruption while Nas pauses the uploader is acceptable for the proposed migration; no live replication or dual-write system is needed. Preserve desktop ingestion, existing data, and authenticated file delivery. Prefer Lambda, DynamoDB, SQS, existing S3/CloudFront, and Terraform.

This feature does not add sharing, multiple users, bidirectional synchronization, or a new file-manager UI. Infrastructure adoption must preserve existing resources and settings before introducing intentional changes. Approval authorizes local implementation and reversible local validation. It does not authorize shared-state imports, Terraform applies, deployment, production migration/deletion/schedules, commits, or pushes; external development fixtures still need the authorization recorded in the plan.

The current product baseline is [Cloudsync](../cloudsync/spec.md), [bulk downloads](../bulk-downloads/spec.md), and the implemented descendant-cover behavior documented in [development](../cloudsync/development.md). This spec changes deployment, persistence, freshness, and archive failure semantics as described below; unrelated behavior remains.

## Catalog and observable behavior

- Files and directories have stable identities, a parent, kind, and name. File properties include original size, immutable object identity, checksum, media type, and preview state. Explicit directories preserve empty folders.
- Derive paths from parents. Renaming or moving a directory changes neither descendant identity nor original object keys. For example, moving `Photos/2025` to `Archive/2025` preserves every contained file ID and stored byte.
- Keep directories first, natural name ordering, paginated children, breadcrumbs, existing normalization, and collision naming: `photo.jpg`, `photo (2).jpg`, etc. Concurrent operations cannot claim the same active sibling name.
- Folder listings and direct child counts reflect completed changes immediately. Counts and recursive sizes are derived values, not authoritative file properties.
- Preserve case-insensitive substring search across names and full paths, including matches spanning path separators, existing result limits, and all-results selection. Search may briefly lag after a change.
- Folder covers and recursive sizes may also briefly lag. Covers prefer a ready preview among direct files, then the nearest descendant image in natural path order. Missing covers use the folder icon.
- A stale derived result never makes a hidden, trashed, or permanently deleted entry eligible for an action. Revalidate the current catalog before mutation or issuing a new exact-object/ZIP download URL. Preserve existing broad CloudFront viewer-cookie authorization; catalog trash does not retroactively revoke previously issued cookies or URLs.
- Reject cycles, including cycles formed by concurrent moves. Concurrent ancestry changes cannot make an upload or mutation commit beneath a hidden or deleting ancestor.
- Trash hides the selected subtree, preserves its internal hierarchy, and releases its active root name. Recycle Bin browsing exposes that subtree. If a child was already trashed and its parent is later trashed, they restore together, preserving current behavior. Do not invent independent recycle roots for historical descendants absorbed by a parent trash operation.
- Restore uses the original parent if it is still active; otherwise restore at root. Apply ordinary collision naming. Permanent deletion makes the subtree unavailable immediately and completes physical cleanup reliably afterward. Preserve the existing 30-day trash retention.

## Ingestion, previews, authentication, and downloads

- Browser and desktop upload originals directly to storage. Finalization verifies size/checksum before committing the file; repeated finalization returns the same entry. The desktop removes a local source only after verified cloud finalization succeeds.
- Verify supplied desktop previews and generate only missing/invalid previews. Preview failure does not invalidate the original. Preserve terminal decode failures, visible errors, retry affordances, and bounded retries for transient failures.
- Preserve original bytes, private storage, existing app/file hostnames, secure session cookies, CloudFront signed cookies scoped to `.example.com`, exact-object signed downloads, and attachment filenames.
- Retain owner-only email PIN authentication, single-use codes, expiry, attempt/rate limits, web sessions, and desktop Keychain sessions. Enforce expiration independently of delayed background cleanup.
- ZIP creation remains asynchronous with progress, explicit failure, selection overlap removal, original bytes, Unicode paths, empty directories, and seven-day reuse/expiry. Missing required input fails the archive rather than silently omitting it.
- Nas chose Lambda-only archives and accepted a clear failure if a selection cannot fit one ordinary invocation's duration or resources. There is no on-demand container fallback and no newly agreed byte-size cap. A large job must not retry indefinitely or expose partial output as a completed archive.

## Data safety and operations

- Preserve every durable catalog field, original and preview object reference, active/trash relationship, upload finalization link, and unexpired session during migration. Account explicitly for unfinished uploads/jobs, PINs/rate limits, and retained archive manifests/status rather than silently discarding SQL tables.
- Existing IDs and S3 keys remain stable. Reconcile imported records against an immutable source snapshot by ID and meaningful fields; aggregate totals alone are insufficient.
- Keep original S3 objects, versioning, encryption, retention, CloudFront aliases, signing identities, functions, and policies intact during infrastructure adoption. App secrets remain private and out of source, logs, plan artifacts, and Terraform state.
- Failed or interrupted publication/processing must be recoverable without relying on exactly-once delivery or permanently polling workers.
- Prepare AWS alongside Dokploy, then migrate during an owner-controlled pause: stop the desktop uploader and old application/worker, back up/export metadata, import and reconcile it, switch the endpoint, and resume ingestion. Retain the old database/image for recovery before new writes begin. Once AWS accepts writes it is authoritative; recovery uses corrected AWS code and rehearsed backups. A reverse PostgreSQL converter is outside this proposal, and switching back to a stale catalog is unsafe.
- Enable catalog/operational backups and deletion protection before resuming ingestion. Existing S3 versioning remains the byte-level recovery layer. Recovery must account for writes after the restored point; restoring a backup alone must not silently discard newer files.
- Infrastructure and releases must be reproducible from versioned configuration and immutable build artifacts. Production changes require explicit authorization; a passing CI run is not deployment authorization or production validation.

## Acceptance

Demonstrate complete metadata reconciliation, unchanged original references/bytes, existing-client upload finalization, concurrent catalog correctness, preview/ZIP success and failure, authentication, and private CloudFront delivery through real development boundaries. Verify adoption proposes no remote changes. Benchmark current-sized metadata and jobs and produce a Singapore cost estimate before claiming savings or cutover readiness.
