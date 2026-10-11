import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const EntryKind = Schema.Literals(["file", "directory"])
export type EntryKind = typeof EntryKind.Type

export const PreviewKind = Schema.Literals(["image", "video", "pdf", "none"])
export type PreviewKind = typeof PreviewKind.Type

export const PreviewStatus = Schema.Literals(["pending", "ready", "failed", "none"])
export type PreviewStatus = typeof PreviewStatus.Type

export class Entry extends Schema.Class<Entry>("Entry")({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  kind: EntryKind,
  mimeType: Schema.NullOr(Schema.String),
  size: Schema.Finite,
  updatedAt: Schema.String,
  previewKind: PreviewKind,
  previewStatus: PreviewStatus,
  isAnimated: Schema.NullOr(Schema.Boolean),
  thumbnailUrl: Schema.NullOr(Schema.String),
  previewUrl: Schema.NullOr(Schema.String),
  contentUrl: Schema.NullOr(Schema.String),
  childCount: Schema.Finite,
}) {}

export class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  entry: Entry,
  parentPath: Schema.String,
}) {}

export class SearchResponse extends Schema.Class<SearchResponse>("SearchResponse")({
  results: Schema.Array(SearchResult),
  truncated: Schema.Boolean,
}) {}

export class Breadcrumb extends Schema.Class<Breadcrumb>("Breadcrumb")({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
}) {}

export class DirectoryListing extends Schema.Class<DirectoryListing>("DirectoryListing")({
  directory: Schema.NullOr(Entry),
  breadcrumbs: Schema.Array(Breadcrumb),
  entries: Schema.Array(Entry),
  nextCursor: Schema.NullOr(Schema.String),
}) {}

export class Session extends Schema.Class<Session>("Session")({
  email: Schema.String,
  expiresAt: Schema.String,
  token: Schema.optional(Schema.String),
}) {}

export const PreviewManifest = Schema.Struct({
  version: Schema.Literal(1),
  thumbnail: Schema.Struct({ size: Schema.Finite, checksumSha256: Schema.String }),
  preview: Schema.Struct({ size: Schema.Finite, checksumSha256: Schema.String }),
  isAnimated: Schema.NullOr(Schema.Boolean),
})
export type PreviewManifest = typeof PreviewManifest.Type

export class ObjectUploadTicket extends Schema.Class<ObjectUploadTicket>("ObjectUploadTicket")({
  objectKey: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  expiresAt: Schema.String,
}) {}

export class UploadTicket extends Schema.Class<UploadTicket>("UploadTicket")({
  ...ObjectUploadTicket.fields,
  uploadId: Schema.String,
  previews: Schema.optional(
    Schema.Struct({
      thumbnail: ObjectUploadTicket,
      preview: ObjectUploadTicket,
    }),
  ),
}) {}

export class DownloadTicket extends Schema.Class<DownloadTicket>("DownloadTicket")({
  url: Schema.String,
  expiresAt: Schema.String,
}) {}

export const BulkAction = Schema.Literals(["trash", "restore", "delete", "move"])
export type BulkAction = typeof BulkAction.Type

export class BulkResult extends Schema.Class<BulkResult>("BulkResult")({
  succeeded: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
}) {}

export class ArchiveDownload extends Schema.Class<ArchiveDownload>("ArchiveDownload")({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "building", "uploading", "completed", "failed"]),
  processed: Schema.Finite,
  total: Schema.Finite,
  bytes: Schema.Finite,
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
}) {}

export class Ok extends Schema.Class<Ok>("Ok")({ ok: Schema.Literal(true) }) {}

export class CloudSyncError extends Schema.TaggedError<CloudSyncError>()("CloudSyncError", {
  code: Schema.Literals([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "INVALID_INPUT",
    "UPLOAD_INCOMPLETE",
    "RATE_LIMITED",
    "INTERNAL",
  ]),
  message: Schema.String,
}) {}

const SessionPayload = { sessionToken: Schema.optional(Schema.String) }

export const CloudSyncRpcs = RpcGroup.make(
  Rpc.make("auth.requestPin", {
    payload: { email: Schema.String },
    success: Ok,
    error: CloudSyncError,
  }),
  Rpc.make("auth.verifyPin", {
    payload: {
      email: Schema.String,
      code: Schema.String,
      client: Schema.Literals(["web", "desktop"]),
    },
    success: Session,
    error: CloudSyncError,
  }),
  Rpc.make("auth.session", {
    payload: SessionPayload,
    success: Session,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.list", {
    payload: {
      ...SessionPayload,
      parentId: Schema.NullOr(Schema.String),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Finite),
      trashed: Schema.optional(Schema.Boolean),
    },
    success: DirectoryListing,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.search", {
    payload: { ...SessionPayload, query: Schema.String, limit: Schema.optional(Schema.Finite) },
    success: SearchResponse,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.selectionIds", {
    payload: {
      ...SessionPayload,
      parentId: Schema.NullOr(Schema.String),
      query: Schema.optional(Schema.String),
      trashed: Schema.optional(Schema.Boolean),
    },
    success: Schema.Array(Schema.String),
    error: CloudSyncError,
  }),
  Rpc.make("catalog.bulk", {
    payload: {
      ...SessionPayload,
      ids: Schema.Array(Schema.String),
      action: BulkAction,
      parentId: Schema.optional(Schema.NullOr(Schema.String)),
    },
    success: BulkResult,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.retryPreview", {
    payload: { ...SessionPayload, id: Schema.String },
    success: Ok,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.createFolder", {
    payload: { ...SessionPayload, parentId: Schema.NullOr(Schema.String), name: Schema.String },
    success: Entry,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.rename", {
    payload: { ...SessionPayload, id: Schema.String, name: Schema.String },
    success: Entry,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.move", {
    payload: { ...SessionPayload, id: Schema.String, parentId: Schema.NullOr(Schema.String) },
    success: Entry,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.trash", {
    payload: { ...SessionPayload, id: Schema.String },
    success: Ok,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.recycleBin", {
    payload: SessionPayload,
    success: Schema.Array(Entry),
    error: CloudSyncError,
  }),
  Rpc.make("catalog.restore", {
    payload: { ...SessionPayload, id: Schema.String },
    success: Entry,
    error: CloudSyncError,
  }),
  Rpc.make("catalog.deletePermanently", {
    payload: { ...SessionPayload, id: Schema.String },
    success: Ok,
    error: CloudSyncError,
  }),
  Rpc.make("upload.begin", {
    payload: {
      ...SessionPayload,
      parentId: Schema.NullOr(Schema.String),
      relativePath: Schema.String,
      size: Schema.Finite,
      mimeType: Schema.String,
      checksumSha256: Schema.String,
      modifiedAt: Schema.String,
      previews: Schema.optional(PreviewManifest),
    },
    success: UploadTicket,
    error: CloudSyncError,
  }),
  Rpc.make("upload.finalize", {
    payload: { ...SessionPayload, uploadId: Schema.String },
    success: Entry,
    error: CloudSyncError,
  }),
  Rpc.make("download.file", {
    payload: { ...SessionPayload, id: Schema.String },
    success: DownloadTicket,
    error: CloudSyncError,
  }),
  Rpc.make("download.archive", {
    payload: { ...SessionPayload, ids: Schema.Array(Schema.String) },
    success: ArchiveDownload,
    error: CloudSyncError,
  }),
  Rpc.make("download.status", {
    payload: { ...SessionPayload, id: Schema.String },
    success: ArchiveDownload,
    error: CloudSyncError,
  }),
)

export type CloudSyncRpcs = typeof CloudSyncRpcs
