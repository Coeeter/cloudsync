# CloudSync specification

Status: Approved on 2026-09-26.

## Goal

CloudSync is a private, single-owner cloud archive. A macOS desktop app drains one configured local inbox into cloud storage, removes each source file only after the cloud copy and metadata are verified, and exposes the resulting hierarchy through a responsive media-first website.

## Non-goals

- Bidirectional filesystem synchronization or a mounted remote filesystem.
- Sharing, public links, multiple users, organizations, or native mobile apps.
- Content or semantic AI features.
- Windows support, light mode, an automatic desktop updater, or notarized distribution.
- A list/table browsing mode.

## Ingestion

- Exactly one local inbox may be active at a time and it always maps to cloud `/`.
- The mapping persists across desktop restarts. Startup rescans the same configured inbox and never guesses a different destination.
- Existing content and later additions are ingested recursively with their relative hierarchy preserved.
- Files upload directly to S3 through short-lived authorization; file bytes do not pass through the VPS.
- A file is removed locally only after the uploaded object checksum is verified and its metadata is committed atomically.
- Successfully uploaded files are removed immediately. Empty directories beneath the watched root are removed; the watched root remains.
- Failed files remain on disk, unrelated files continue, retries are available, and macOS notifies the owner.
- `.DS_Store` is always ignored. Other regular files are accepted regardless of type.
- Symlinks and non-regular filesystem entries are not followed or uploaded.
- Browser uploads accept files, directory selection, and drag-and-drop into the currently open cloud folder. They use the same server-side naming and finalization behavior as desktop ingestion.
- A collision uses Finder-style suffixes before the extension: `name.ext`, `name (2).ext`, `name (3).ext`; directories follow the same rule.

## Web file manager

- The owner can browse, preview, search by name/path, upload, download, rename, move, create folders, delete, restore, and permanently delete.
- Whole folders can be downloaded as streamed ZIP archives without requiring VPS temporary disk proportional to archive size.
- Deletion moves a logical subtree to Recycle Bin. Objects are not physically copied to a `.bin` S3 prefix.
- Recycle Bin retains items for 30 days before permanent object deletion. Restore preserves hierarchy and applies normal collision naming when needed.
- Directory deletion and restoration include the complete subtree.

## Browsing and previews

- Browsing is a dark-only responsive grid: two columns on mobile and adaptive columns on larger screens.
- Directories appear before files. Each group is naturally sorted by display name.
- A directory card uses the first naturally sorted previewable regular file among its direct children only. It uses a folder icon when no direct child has a preview.
- Image, animated image, video, and PDF previews are supported. Unknown formats use a generic file card and remain downloadable.
- Stored originals are never modified. Processing produces uncropped grid thumbnails, larger lightbox previews, PDF first-page previews, and video poster frames.
- A preview failure does not invalidate the uploaded original.
- Media opens in a keyboard-, pointer-, and touch-friendly viewer that follows the folder's natural order.

## Authentication and privacy

- Only the email address configured in the environment may authenticate.
- Authentication uses a six-digit, single-use Resend email PIN with expiry and rate/attempt limits.
- Web sessions use secure HTTP-only cookies. Electron stores its durable session in macOS Keychain.
- `sync.example.com` serves the production website, Effect RPC API, authentication, and streamed archive downloads from the Dokploy application.
- `files.example.com` is a separate CloudFront file-delivery hostname backed only by the private S3 bucket. The development file distribution uses `files-dev.example.com`.
- Both public hostnames are internet-reachable, but application data and stored files must be inaccessible without authorization.
- S3 is private and reachable for reads only through CloudFront Origin Access Control. Protected object delivery uses CloudFront signed cookies.
- Production CloudFront cookies are scoped to `.example.com` so an authenticated response from `sync.example.com` authorizes protected reads from `files.example.com`.
- There is no sharing flow or intentionally public object path.

## Reliability and recovery

- S3 is the authoritative byte store and PostgreSQL is the authoritative logical catalog.
- Physical S3 keys are immutable and independent of logical paths.
- Upload finalization is idempotent. Concurrent path claims cannot produce duplicate sibling names.
- Interrupted uploads and incomplete metadata operations are recoverable or safely retryable.
- The system reconciles abandoned uploads and missing previews without relying on ordered or exactly-once S3 events.
- The S3 bucket is versioned. Obsolete/deleted physical data follows the configured 30-day lifecycle.
- Dokploy database backup configuration is owner-managed and outside the application.

## Applications and deployment

- The cloud website, RPC API, authentication, and worker ship from one codebase/container image with separate web and worker modes where appropriate.
- The application and file delivery remain separate origins; CloudFront is not used as a reverse proxy for the website or RPC API.
- The desktop app is a locally packaged Apple Silicon Electron application placed in `~/Applications` by the owner.
- The repository includes production Docker configuration suitable for publishing to a registry and running on Dokploy.
- Runtime secrets live in Doppler. Code and logs never print secret values.

## File delivery

Worker inputs, streamed folder archive sources, and explicit file downloads use authenticated CloudFront delivery. Download links are short-lived and scoped to the exact file and filename. Uploads remain direct S3 presigned PUTs. Permanent preview decode failures terminate on the first attempt and remain visible; transient storage failures retain bounded retries.
