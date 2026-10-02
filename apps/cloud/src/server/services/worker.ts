import type { Readable } from "node:stream"
import { isAnimatedWebP } from "@cloudsync/core"
import { Database, type DatabaseError, schema } from "@cloudsync/db"
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Storage, StorageError } from "./storage"

const PreviewPayload = Schema.Struct({ entryId: Schema.String })
const DeletePayload = Schema.Struct({ objectKeys: Schema.Array(Schema.String) })
type JobRow = typeof schema.jobs.$inferSelect
type WorkerFailure = DatabaseError | StorageError

interface BunImagePipeline {
  resize(
    width: number,
    height: number,
    options: { readonly fit: "inside"; readonly withoutEnlargement: boolean },
  ): BunImagePipeline
  webp(options: { readonly quality: number }): BunImagePipeline
  bytes(): Promise<Uint8Array>
}

const BunImage = (
  Bun as unknown as {
    readonly Image: new (
      input: Uint8Array,
      options: { readonly autoOrient: boolean },
    ) => BunImagePipeline
  }
).Image

class WorkerJobError extends Schema.TaggedError<WorkerJobError>()("WorkerJobError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class PreviewDecodeError extends Schema.TaggedError<PreviewDecodeError>()(
  "PreviewDecodeError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface WorkerShape {
  readonly run: Effect.Effect<never, WorkerFailure>
  readonly runOnce: Effect.Effect<boolean, WorkerFailure>
}

function extractedFrame(
  bytes: Uint8Array,
  kind: "video" | "pdf" | "webp",
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<Uint8Array, WorkerJobError | PreviewDecodeError> {
  return Effect.gen(function* () {
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "cloudsync-preview-" })
      .pipe(
        Effect.mapError(
          (cause) => new WorkerJobError({ message: "Could not create preview workspace", cause }),
        ),
      )
    const input = path.join(
      directory,
      kind === "pdf" ? "input.pdf" : kind === "webp" ? "input.webp" : "input.video",
    )
    const output = path.join(directory, "frame.jpg")
    yield* fileSystem
      .writeFile(input, bytes)
      .pipe(
        Effect.mapError(
          (cause) => new WorkerJobError({ message: "Could not stage preview input", cause }),
        ),
      )
    const command =
      kind !== "pdf"
        ? ChildProcess.make("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            input,
            // Videos use a representative frame; animated WebP stops after its first frame.
            ...(kind === "video" ? ["-vf", "thumbnail"] : []),
            "-frames:v",
            "1",
            "-y",
            output,
          ])
        : ChildProcess.make("pdftoppm", [
            "-f",
            "1",
            "-singlefile",
            "-jpeg",
            "-scale-to",
            "2200",
            input,
            path.join(directory, "frame"),
          ])
    const handle = yield* spawner
      .spawn(command)
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkerJobError({ message: `Could not start ${kind} preview command`, cause }),
        ),
      )
    const diagnostics = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError(
        (cause) =>
          new WorkerJobError({ message: `Could not read ${kind} preview diagnostics`, cause }),
      ),
    )
    const exitCode = yield* handle.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new WorkerJobError({ message: `Could not await ${kind} preview command`, cause }),
      ),
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      const message = diagnostics.trim() || `${kind} preview command exited with ${exitCode}`
      if (
        exitCode === ChildProcessSpawner.ExitCode(137) ||
        exitCode === ChildProcessSpawner.ExitCode(143)
      ) {
        return yield* new WorkerJobError({ message, cause: null })
      }
      return yield* new PreviewDecodeError({ message, cause: null })
    }

    return yield* fileSystem
      .readFile(output)
      .pipe(
        Effect.mapError(
          (cause) => new WorkerJobError({ message: `${kind} preview produced no frame`, cause }),
        ),
      )
  }).pipe(Effect.scoped)
}

function readObjectBody(body: Readable) {
  return Effect.tryPromise({
    try: async (signal) => {
      const abort = () => body.destroy(new Error("Object read cancelled"))
      signal.addEventListener("abort", abort, { once: true })
      try {
        const chunks: Uint8Array[] = []
        for await (const chunk of body) chunks.push(chunk)
        return new Uint8Array(Buffer.concat(chunks))
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
    catch: () =>
      new StorageError({
        operation: "get",
        message: "Could not read the CloudFront object body",
        cause: null,
      }),
  })
}

export class Worker extends Context.Service<Worker, WorkerShape>()("@cloudsync/cloud/Worker") {
  static readonly layer = Layer.effect(
    Worker,
    Effect.gen(function* () {
      const database = yield* Database
      const storage = yield* Storage
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const claim = database.execute("worker.claim", (db) =>
        db.transaction(async (tx) => {
          const [job] = await tx
            .select()
            .from(schema.jobs)
            .where(
              and(
                or(
                  and(
                    or(eq(schema.jobs.status, "pending"), eq(schema.jobs.status, "failed")),
                    lte(schema.jobs.runAfter, new Date()),
                  ),
                  and(
                    eq(schema.jobs.status, "running"),
                    lte(schema.jobs.lockedAt, new Date(Date.now() - 15 * 60 * 1000)),
                  ),
                ),
              ),
            )
            .orderBy(schema.jobs.createdAt)
            .limit(1)
            .for("update", { skipLocked: true })
          if (!job) return null
          const [claimed] = await tx
            .update(schema.jobs)
            .set({
              status: "running",
              attempts: sql`${schema.jobs.attempts} + 1`,
              lockedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, job.id))
            .returning()
          return claimed ?? null
        }),
      )

      const createPreview = Effect.fn("Worker.createPreview")(function* (job: JobRow) {
        const { entryId } = yield* Schema.decodeUnknownEffect(PreviewPayload)(job.payload)
        const entry = yield* database.execute("worker.previewEntry", async (db) => {
          const [row] = await db
            .select()
            .from(schema.entries)
            .where(and(eq(schema.entries.id, entryId), eq(schema.entries.kind, "file")))
            .limit(1)
          return row
        })
        if (!entry?.objectKey || !entry.mimeType) return
        const objectKey = entry.objectKey
        const object = yield* storage.get(objectKey)
        const original = yield* readObjectBody(object.body)
        const isWebP = entry.mimeType === "image/webp"
        const isAnimated = isWebP
          ? yield* Effect.try({
              try: () => isAnimatedWebP(original),
              catch: () =>
                new PreviewDecodeError({
                  message: "Could not inspect the WebP container",
                  cause: null,
                }),
            })
          : null
        const source = entry.mimeType.startsWith("video/")
          ? yield* extractedFrame(original, "video", spawner, fileSystem, path)
          : entry.mimeType === "application/pdf"
            ? yield* extractedFrame(original, "pdf", spawner, fileSystem, path)
            : isAnimated
              ? yield* extractedFrame(original, "webp", spawner, fileSystem, path)
              : original
        const thumbnail = yield* Effect.tryPromise({
          try: () =>
            new BunImage(source, { autoOrient: true })
              .resize(480, 480, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 78 })
              .bytes(),
          catch: () =>
            new PreviewDecodeError({ message: "Could not render the thumbnail", cause: null }),
        })
        const preview = yield* Effect.tryPromise({
          try: () =>
            new BunImage(source, { autoOrient: true })
              .resize(2200, 2200, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 86 })
              .bytes(),
          catch: () =>
            new PreviewDecodeError({ message: "Could not render the preview", cause: null }),
        })
        // A fresh key per generation lets delivery mark previews immutable.
        const generation = crypto.randomUUID()
        const thumbnailKey = `previews/${entry.id}/${generation}-thumbnail.webp`
        const previewKey = `previews/${entry.id}/${generation}-preview.webp`
        yield* Effect.all(
          [
            storage.put(thumbnailKey, thumbnail, "image/webp"),
            storage.put(previewKey, preview, "image/webp"),
          ],
          { concurrency: 2 },
        )
        const replaced = [entry.thumbnailKey, entry.previewKey].filter(
          (key): key is string => key !== null,
        )
        yield* database.execute("worker.savePreview", (db) =>
          db.transaction(async (tx) => {
            await tx
              .update(schema.entries)
              .set({
                thumbnailKey,
                previewKey,
                previewError: null,
                isAnimated,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.entries.id, entry.id),
                  eq(schema.entries.objectKey, objectKey),
                  isNull(schema.entries.deletedAt),
                ),
              )
            if (replaced.length > 0) {
              await tx
                .insert(schema.jobs)
                .values({ kind: "delete_objects", payload: { objectKeys: replaced } })
            }
          }),
        )
      })

      const deleteObjects = Effect.fn("Worker.deleteObjects")(function* (job: JobRow) {
        const { objectKeys } = yield* Schema.decodeUnknownEffect(DeletePayload)(job.payload)
        yield* Effect.forEach(objectKeys, storage.delete, { concurrency: 8, discard: true })
      })

      const processJob = (job: JobRow): Effect.Effect<void, DatabaseError> => {
        const task = (
          job.kind === "preview"
            ? createPreview(job)
            : job.kind === "delete_objects"
              ? deleteObjects(job)
              : Effect.fail(
                  new WorkerJobError({ message: `Unknown job kind: ${job.kind}`, cause: null }),
                )
        ).pipe(Effect.asVoid)

        return task.pipe(
          Effect.tap(() =>
            database.execute("worker.complete", (db) =>
              db
                .update(schema.jobs)
                .set({ status: "completed", error: null, updatedAt: new Date() })
                .where(eq(schema.jobs.id, job.id)),
            ),
          ),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const terminal = cause instanceof PreviewDecodeError || job.attempts >= 5
              yield* database.execute("worker.fail", (db) =>
                db
                  .update(schema.jobs)
                  .set({
                    status: terminal ? "completed" : "failed",
                    error: cause instanceof Error ? cause.message : String(cause),
                    runAfter: new Date(Date.now() + Math.min(60, 2 ** job.attempts) * 60_000),
                    updatedAt: new Date(),
                  })
                  .where(eq(schema.jobs.id, job.id)),
              )
              if (job.kind === "preview" && terminal) {
                const parsed = Schema.decodeUnknownExit(PreviewPayload)(job.payload)
                if (parsed._tag === "Success") {
                  yield* database.execute("worker.previewError", (db) =>
                    db
                      .update(schema.entries)
                      .set({ previewError: cause instanceof Error ? cause.message : String(cause) })
                      .where(eq(schema.entries.id, parsed.value.entryId)),
                  )
                }
              }
              yield* Effect.logError("Worker job failed").pipe(
                Effect.annotateLogs({ jobId: job.id, kind: job.kind, terminal }),
              )
            }),
          ),
        )
      }

      const sweep = database.execute("worker.sweep", (db) =>
        db.transaction(async (tx) => {
          const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          const roots = await tx
            .select({ id: schema.entries.id })
            .from(schema.entries)
            .where(
              and(
                isNotNull(schema.entries.deletedAt),
                eq(schema.entries.id, schema.entries.trashRootId),
                lte(schema.entries.deletedAt, cutoff),
              ),
            )
          for (const root of roots) {
            const subtree = await tx.execute(sql`
              with recursive items as (
                select id from entries where id = ${root.id}
                union all
                select child.id from entries child join items parent on child.parent_id = parent.id
              ) select id from items
            `)
            const ids = Array.from(subtree as Iterable<{ id: string }>, (row) => row.id)
            if (ids.length === 0) continue
            const rows = await tx
              .select({
                objectKey: schema.entries.objectKey,
                thumbnailKey: schema.entries.thumbnailKey,
                previewKey: schema.entries.previewKey,
              })
              .from(schema.entries)
              .where(inArray(schema.entries.id, ids))
            const objectKeys = rows
              .flatMap((row) => [row.objectKey, row.thumbnailKey, row.previewKey])
              .filter((key): key is string => Boolean(key))
            await tx.insert(schema.jobs).values({ kind: "delete_objects", payload: { objectKeys } })
            await tx.delete(schema.entries).where(inArray(schema.entries.id, ids))
          }
          await tx.delete(schema.sessions).where(lte(schema.sessions.expiresAt, new Date()))
          await tx.delete(schema.authPins).where(lte(schema.authPins.expiresAt, new Date()))
          const abandoned = await tx
            .delete(schema.uploads)
            .where(
              and(
                lte(schema.uploads.expiresAt, new Date(Date.now() - 60 * 60 * 1000)),
                eq(schema.uploads.status, "pending"),
              ),
            )
            .returning({ objectKey: schema.uploads.objectKey })
          if (abandoned.length > 0) {
            await tx.insert(schema.jobs).values({
              kind: "delete_objects",
              payload: { objectKeys: abandoned.map((upload) => upload.objectKey) },
            })
          }
          await tx.execute(sql`
            insert into jobs (kind, payload)
            select 'preview', jsonb_build_object('entryId', entries.id)
            from entries
            where entries.kind = 'file'
              and entries.deleted_at is null
              and entries.thumbnail_key is null
              and entries.preview_error is null
              and (
                entries.mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'application/pdf')
                or entries.mime_type like 'video/%'
              )
              and not exists (
                select 1 from jobs
                where jobs.kind = 'preview'
                  and jobs.payload->>'entryId' = entries.id::text
                  and jobs.status in ('pending', 'running', 'failed')
              )
          `)
        }),
      )

      let cycles = 0
      const runOnce = Effect.gen(function* () {
        cycles += 1
        if (cycles === 1 || cycles % 3600 === 0) yield* sweep
        const job = yield* claim
        if (!job) return false
        yield* processJob(job)
        return true
      }).pipe(Effect.withSpan("Worker.runOnce"))

      const run = runOnce.pipe(
        Effect.flatMap((worked) => (worked ? Effect.void : Effect.sleep("1 second"))),
        Effect.forever,
      )
      return Worker.of({ run, runOnce })
    }),
  )
}
