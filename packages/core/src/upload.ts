import type { Entry, PreviewManifest, UploadTicket } from "@cloudsync/domain"
import { Effect } from "effect"

export interface PreparedUpload {
  readonly parentId: string | null
  readonly relativePath: string
  readonly size: number
  readonly mimeType: string
  readonly checksumSha256: string
  readonly modifiedAt: string
  readonly previews?: PreviewManifest | undefined
}

export interface DirectUploadRemote<E> {
  readonly begin: (upload: PreparedUpload) => Effect.Effect<UploadTicket, E>
  readonly put: (ticket: UploadTicket) => Effect.Effect<void, E>
  readonly finalize: (uploadId: string) => Effect.Effect<Entry, E>
}

export const completeDirectUpload = Effect.fn("completeDirectUpload")(function* <E>(
  upload: PreparedUpload,
  remote: DirectUploadRemote<E>,
) {
  const ticket = yield* remote.begin(upload)
  yield* remote.put(ticket)
  return yield* remote.finalize(ticket.uploadId)
})
