# Independent architecture review

On 2026-10-12 Nas requested Claude Code Opus 5.5, medium effort, through T3 Code orchestration. One read-only delegated review examined the original spec/plan and repository. The review supported the AWS direction but rejected claiming migration safety or low cost before the required evidence. The parent verified material findings and revised the documents; those revisions have not been independently re-reviewed.

## Findings and dispositions

- **Automatic deployment:** confirmed `.github/workflows/ci.yml` publishes latest and calls Dokploy web/worker webhooks on main. The plan now requires a manual release guard and pinned compatible PostgreSQL image before persistence-changing merges, infra validation on main, and noncancelling apply/deploy jobs. No workflow/deployment has been changed.
- **Write freeze:** confirmed there is no application read-only flag and old ZIP jobs can run for two hours. Nas clarified this is a personal computer-to-cloud tool. The proposal now pauses the owner uploader, quiesces work, and stops old web/worker during final export/cutover. It does not add a maintenance-mode subsystem, dual writes, or replication.
- **Legacy anomalies:** confirmed no catalog foreign keys and SQL trash traverses/overwrites descendants, including older trash. The plan now includes explicit snapshot anomaly gates and preserves absorbed trash behavior. Nas explicitly chose restore-together. Fresh targeted aggregates found zero dangling parent/original-parent/trash-root links, active rows directly under deleted parents, absorbed former non-root trash markers, and file rows missing original keys; full recursive audit remains pending.
- **Timestamp precision:** confirmed 74,666 current entries have microsecond precision in created/updated timestamps beyond JavaScript Date. Export/reconciliation must retain full precision independently of API formatting.
- **Derived starvation/cost:** accepted the risk of repeatedly rejecting full scans during active ingestion. One debounced eventually consistent scan now rebuilds all derived views, permits stale generation publication, and queues another generation when needed. Authoritative action validation remains mandatory. Costing includes filtered-out table items because filters do not reduce scan capacity use.
- **Natural sorting:** stored ICU keys were technically possible with added native machinery, not available from Intl.Collator itself. Fresh read-only inventory found only 323 children in the largest folder. An in-memory numeric/accent-sensitive comparator with UTF-8/ID ties matched PostgreSQL for that folder (zero ordering differences). Prefer strong folder queries plus in-memory sorting and existing cursors; broad Unicode/runtime fixtures still need validation.
- **Backups:** PITR was only a cost item in the original plan. Both tables now require PITR, deletion protection, prevent_destroy, and a rehearsed restore/reconciliation path before releasing writes.

## Simplifications and rejected shortcuts

Accepted: no Streams publisher, durable job commit followed by SQS send and scheduled reconciliation; SSM standard SecureString instead of Secrets Manager where sizes fit; separate shared/dev/prod ownership; direct child counts from already-required folder queries; no reverse PostgreSQL converter in this personal-tool proposal.

Rejected: dropping pending uploads solely because desktop retries begin/put/finalize. Retrying preserves the local source, but does not justify throwing away already-uploaded recoverable data or changing browser finalization. Preserve valid upload records and record cleanup disposition.

Rejected: deleting incomplete archive outputs/history during migration. Requeue/fail unfinished work explicitly, retain export evidence, and leave physical temporary cleanup to separately authorized normal retention. No deletion is authorized by planning.

Rejected: claiming current data is anomaly-free based only on code inspection or targeted counts. Full final-snapshot audit/per-record reconciliation and real object checks remain cutover gates. Similarly, no numerical monthly-cost or no-data-loss guarantee is justified before benchmarks and rehearsal.

The original independent verdict had seven must-fix gaps; revised documents address the design/documentation gaps, not their future implementation. Runtime/model validation, the complete anomaly audit, Singapore cost estimate, migration interruption/resume rehearsal, and recovery evidence remain unfinished.
