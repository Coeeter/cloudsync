# CloudFront object reads

Direction approved by Nas on 2026-10-02: move raw S3 body reads and downloads to CloudFront in another project and CloudSync, preserving security and observable behavior, and stop CloudSync retrying deterministic preview failures.

- Workers, archive builders, importer fallback reads, and user downloads fetch bodies through CloudFront.
- Private files require existing authorization and short-lived signatures scoped to the exact object and download parameters. Existing intentionally public media remains public.
- Uploads, metadata checks, deletes, and server-side S3 copies remain direct S3 operations.
- Preserve streaming, cancellation, filenames including Unicode, content types, and video ranges.
- Never fall back to direct S3 reads after a CDN failure. Never expose signing credentials or signed URLs in logs.
- Permanent preview processing failures stop after their first attempt; transient storage/network failures retain bounded retries.
- Production rollout was separately authorized by Nas and completed on 2026-10-02. IAM permissions were unchanged. Development infrastructure changes may be used for validation.
