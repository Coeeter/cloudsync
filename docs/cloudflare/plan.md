# Workers + D1 implementation plan

Direction explicitly approved by Nas on 2026-10-12. Implementation in the current workspace.

1. Reset unfinished DynamoDB changes; retain documentation/research and a local backup of discarded implementation.
2. Use the Cloudflare Vite adapter and Wrangler with a local D1 binding. SQL tables for entries, uploads, auth, archives and durable cleanup. Atomic D1 batches and SQLite constraints/triggers protect hierarchy, finalization and single-use PINs; no interactive transactions.
3. Compute paths/covers through indexed recursive SQL and small in-memory natural sorting. No full-catalog derived snapshot worker. Preserve microsecond timestamp text.
4. Generate browser/desktop previews, verify checksum/length/MIME, support browser retries, block desktop startup when native tools are unavailable.
5. ZIP HTTP submission returns 202 after persisting an immutable S3 manifest and asynchronously invoking the builder. Builder claims a lease through authenticated Cloudflare callbacks, streams S3 to multipart ZIP, records durable outcomes, and reports progress/completion. D1 holds retry/submission status; scheduled reconciliation is disabled in production until authorized.
6. Terraform references existing S3 and keeps content-delivery adoption separate; prepare least-privilege roles, Lambda/API Gateway, immutable artifact inputs and protected release workflows. Doppler secrets pipe to Wrangler; AWS secrets outside Terraform state.
7. Preserve PostgreSQL exports and convert into SQLite with per-record reconciliation and resumable rehearsal. Prepare paused cutover/recovery runbook.

Validation: real local Wrangler/workerd/D1 API, browser upload/list/search/trash/restore, native desktop tools, Node Lambda ZIP with local disposable S3, migration import/reconciliation, repository checks/build, Terraform validation. Cloud dev/prod delivery, AWS triggers/IAM and zero-change adoption plans need separate authorization.

## Completed local work

- Reset the superseded implementation with a backup at /tmp/cloudsync-before-d1; retained all docs/research in the existing workspace.
- Implemented Workers/D1 catalogue, hierarchy constraints, atomic bulk operations, uploads, sessions/PINs, natural listings/search/covers, trash/restore and durable cleanup.
- Implemented browser image/video/PDF previews and the actual Retry preview flow; desktop startup checks executable tools and blocks ingestion when unavailable.
- Implemented asynchronous authenticated ZIP submission, streaming Node 22 Lambda builder, leases, signed callbacks and durable outcome reconciliation. No cloud preview renderer.
- Prepared Wrangler configuration, Doppler secret piping, manual protected release workflows, Terraform ZIP resources and separate existing delivery adoption. Automatic Dokploy publication removed from CI. Resend retained.
- Implemented read-only export, anomaly audit, resumable SQLite conversion/import, generated D1 SQL, independent per-record reconciliation and paused cutover/recovery documentation.

## Fresh validation on 2026-10-12

- Compiled Worker via Wrangler/workerd, real local D1 and disposable S3: seven end-to-end scenarios passed, 46 assertions. Includes concurrent upload finalization/naming, natural pagination/path search, hierarchy cycle rejection, restore-together/collisions, stale download rejection, single-use PIN, bulk operations and actual Node Lambda container ZIP success/reuse/Unicode/empty directories/missing-input failure.
- Real Chrome against the compiled app: PNG upload stored WebP previews; MP4 preview 194 ms, PDF preview 291 ms, Retry preview 417 ms; no page errors. Timing includes upload/finalization. Actual Electron startup inspected in isolated user-data with no production session/inbox.
- Real RPC bulk trash/restore of 74,957 selected metadata entries: 482/558 ms; all selected IDs accounted for and 323 direct children preserved. Listing/search and all-results archive preparation previously exercised at the same scale.
- Migration rehearsal from disposable PostgreSQL: 74,548 entries independently reconciled with zero field differences, zero foreign-key violations, and all 74,548 microsecond timestamp strings preserved. Interrupted import resumed successfully. Generated SQL also imported into real local Wrangler D1 and independently reconciled.
- Compiled Worker scheduled handler invoked manually; durable object cleanup and metadata purge exercised locally. Remote cron arrays remain empty.
- Repository type checks, lint, default tests and build passed. Opt-in end-to-end suite was run separately rather than relying on skipped default fixtures. Terraform ZIP module validated; actual Lambda Docker image built and exercised; environment-specific Wrangler deploy dry-run passed.
- Read-only signed HEAD against an existing development S3 object passed checksum/size validation. No cloud objects were created or changed.

## Important discoveries

The RPC client appends a slash. Redirecting its large streaming POST through TanStack/Wrangler lost the body in the compiled runtime; direct dispatch now handles both forms without redirect. Bulk trash originally used a correlated recursive lookup and took about 75 seconds; materializing the tree and joining it in UPDATE reduced the same real boundary to under a second. Bulk actions group work into atomic batches, avoiding per-entry network calls and D1 query-count limits.

## Remaining work and boundaries

Status: Partial overall; local implementation and reachable validation complete. No commit, push, deployment, shared-state import, production migration, DNS change or production schedule performed.

Authorized cloud setup/deployment is required to replace D1 ID placeholders, configure protected GitHub environments/scoped tokens/OIDC roles/state and artifact buckets, review saved Terraform plans and deploy. Then validate actual Cloudflare D1 quotas/runtime, Resend delivery, S3/CloudFront signatures/CORS/range requests, AWS API Gateway/IAM/async Lambda/callback recovery and ordinary Lambda resource limits through deployed artifacts. Local emulation does not prove these boundaries. Existing delivery adoption remains separate and unapplied.

Use [release setup](releases.md) and [paused cutover](cutover.md) for the next stage. Production anomaly dispositions and destination reconciliation must precede endpoint switching; production cleanup schedules require separate authorization.
