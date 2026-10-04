import { describe, expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { completeDirectUpload, uploadedPreviewKeys } from "@cloudsync/core"
import { Database, schema } from "@cloudsync/db"
import { CloudSyncRpcs, type ObjectUploadTicket } from "@cloudsync/domain"
import { eq, inArray } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { createLocalPreviews } from "../../../../desktop/src/main/preview"
import { CloudConfig } from "../config"
import { Storage } from "./storage"

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
const url = process.env.CLOUDSYNC_TEST_URL
const integration = connection && url ? describe : describe.skip
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64")

function pdfFixture() {
  const stream = "0 0 1 rg 0 0 400 200 re f\n"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += "xref\n0 5\n0000000000 65535 f \n"
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  return Buffer.from(`${pdf}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

integration("Desktop previews through live RPC and dev S3", () => {
  it("accepts image/video/PDF previews and falls back for missing or invalid previews", async () => {
    if (
      !connection ||
      !url ||
      new URL(connection).hostname !== "127.0.0.1" ||
      new URL(connection).pathname !== "/cloudsync_worker_test" ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    )
      throw new Error("Use the disposable local test database and server")
    const config = await Effect.runPromise(CloudConfig.pipe(Effect.provide(CloudConfig.layer)))
    if (!config.s3Bucket.endsWith("-dev")) throw new Error("Use development storage only")
    const directory = await mkdtemp(join(tmpdir(), "cloudsync-preview-fixtures-"))
    const execute = promisify(execFile)
    const token = randomUUID()
    const uploadIds: string[] = []
    const entryIds: string[] = []
    const keys: string[] = []
    const database = Database.layer({
      connectionString: Redacted.make(connection),
      migrationsFolder: resolve(import.meta.dirname, "../../../../../packages/db/drizzle"),
    })
    const storage = Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config)))
    const protocol = RpcClient.layerProtocolHttp({ url: `${url}/rpc` }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
    )
    try {
      await execute("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=2400x1200",
        "-frames:v",
        "1",
        "-y",
        join(directory, "image.png"),
      ])
      await execute("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-y",
        join(directory, "video.mp4"),
      ])
      const fixtures = [
        { mime: "image/png", bytes: await readFile(join(directory, "image.png")) },
        { mime: "video/mp4", bytes: await readFile(join(directory, "video.mp4")) },
        { mime: "application/pdf", bytes: pdfFixture() },
      ]
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database
          const objects = yield* Storage
          const rpc = yield* RpcClient.make(CloudSyncRpcs)
          yield* db.execute("test.session", (sql) =>
            sql.insert(schema.sessions).values({
              email: config.ownerEmail,
              tokenHash: createHash("sha256").update(token).digest("hex"),
              expiresAt: new Date(Date.now() + 60_000),
            }),
          )
          const put = (ticket: ObjectUploadTicket, bytes: Uint8Array) =>
            Effect.promise(async () => {
              const response = await fetch(ticket.url, {
                method: "PUT",
                headers: ticket.headers,
                body: Buffer.from(bytes),
              })
              if (!response.ok) throw new Error(`Fixture upload failed: HTTP ${response.status}`)
            })
          yield* Effect.gen(function* () {
            for (const [index, mode] of [
              "image",
              "video",
              "pdf",
              "partial",
              "mismatch",
              "legacy",
              "decode-failure",
            ].entries()) {
              const fixture = fixtures[index < 3 ? index : 0]
              if (!fixture) return yield* Effect.die("Missing fixture")
              const bytes = mode === "decode-failure" ? Buffer.from("invalid image") : fixture.bytes
              const generated = yield* Effect.promise(() =>
                createLocalPreviews(bytes, fixture.mime).catch(() => null),
              )
              const manifest = mode === "legacy" ? undefined : generated?.manifest
              let uploadId = ""
              const entry = yield* completeDirectUpload(
                {
                  parentId: null,
                  relativePath: `${randomUUID()}.fixture`,
                  size: bytes.length,
                  mimeType: fixture.mime,
                  checksumSha256: digest(bytes),
                  modifiedAt: new Date().toISOString(),
                  ...(manifest
                    ? {
                        previews:
                          mode === "mismatch"
                            ? {
                                ...manifest,
                                preview: { ...manifest.preview, size: manifest.preview.size + 1 },
                              }
                            : manifest,
                      }
                    : {}),
                },
                {
                  begin: (input) =>
                    rpc["upload.begin"]({ sessionToken: token, ...input }).pipe(
                      Effect.tap((ticket) =>
                        Effect.sync(() => {
                          uploadId = ticket.uploadId
                          uploadIds.push(uploadId)
                          keys.push(
                            ticket.objectKey,
                            ...Object.values(uploadedPreviewKeys(uploadId)),
                          )
                        }),
                      ),
                    ),
                  put: (ticket) =>
                    Effect.gen(function* () {
                      yield* put(ticket, bytes)
                      if (generated && ticket.previews) {
                        yield* put(ticket.previews.thumbnail, generated.thumbnail)
                        if (mode !== "partial")
                          yield* put(ticket.previews.preview, generated.preview)
                      }
                    }),
                  finalize: (uploadId) => rpc["upload.finalize"]({ sessionToken: token, uploadId }),
                },
              )
              entryIds.push(entry.id)
              const ready = index < 3
              expect(entry.previewStatus).toBe(ready ? "ready" : "pending")
              const jobs = yield* db.execute("test.inspect", (sql) =>
                sql.select().from(schema.jobs).where(eq(schema.jobs.kind, "preview")),
              )
              expect(
                jobs.filter((job) => (job.payload as { entryId?: string }).entryId === entry.id),
              ).toHaveLength(ready ? 0 : 1)
              const repeated = yield* rpc["upload.finalize"]({ sessionToken: token, uploadId })
              expect(repeated.id).toBe(entry.id)
              if (ready && entry.previewUrl) {
                if (!generated) return yield* Effect.die("Expected desktop previews")
                const body = yield* Effect.promise(async () => {
                  const response = await fetch(entry.previewUrl as string)
                  if (!response.ok)
                    throw new Error(`Preview download failed: HTTP ${response.status}`)
                  return Buffer.from(await response.arrayBuffer())
                })
                expect(body.subarray(0, 4).toString()).toBe("RIFF")
                expect(digest(body)).toEqual(generated.manifest.preview.checksumSha256)
              }
            }
            const cleanupJobs = yield* db.execute("test.inspect", (sql) =>
              sql.select().from(schema.jobs).where(eq(schema.jobs.kind, "delete_objects")),
            )
            expect(cleanupJobs).toHaveLength(2)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Effect.forEach(keys, objects.delete, { concurrency: 4, discard: true })
                yield* db.execute("test.cleanup", async (sql) => {
                  await sql.delete(schema.jobs)
                  await sql.delete(schema.entries).where(inArray(schema.entries.id, entryIds))
                  await sql.delete(schema.uploads).where(inArray(schema.uploads.id, uploadIds))
                  await sql
                    .delete(schema.sessions)
                    .where(
                      eq(
                        schema.sessions.tokenHash,
                        createHash("sha256").update(token).digest("hex"),
                      ),
                    )
                })
              }).pipe(Effect.orDie),
            ),
          )
        }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(database, storage, protocol))),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
