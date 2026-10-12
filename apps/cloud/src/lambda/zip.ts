import { createHash } from "node:crypto"
import { PassThrough, type Readable, Transform } from "node:stream"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda"
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Upload } from "@aws-sdk/lib-storage"
import { ZipArchive } from "archiver"
import type { APIGatewayProxyEventV2, Context } from "aws-lambda"
import { authenticated, signedHeaders, type ZipManifest } from "../shared/zip-protocol"

interface Submission {
  version: 1
  jobId: string
  manifestKey: string
  fingerprint: string
}
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: !!process.env.S3_ENDPOINT,
})
const lambda = new LambdaClient({ endpoint: process.env.LAMBDA_ENDPOINT })
let secretPromise: Promise<string> | undefined
function secret() {
  if (secretPromise) return secretPromise
  secretPromise = process.env.ZIP_SERVICE_SECRET
    ? Promise.resolve(process.env.ZIP_SERVICE_SECRET)
    : new SSMClient({})
        .send(
          new GetParameterCommand({ Name: process.env.ZIP_SECRET_PARAMETER, WithDecryption: true }),
        )
        .then((r) => {
          if (!r.Parameter?.Value) throw new Error("Missing ZIP secret")
          return r.Parameter.Value
        })
        .catch((error) => {
          secretPromise = undefined
          throw error
        })
  return secretPromise
}
const bucket = () => {
  if (!process.env.S3_BUCKET) throw new Error("S3 bucket is not configured")
  return process.env.S3_BUCKET
}
function validateSubmission(value: unknown): Submission {
  const v = value as Submission
  if (
    !v ||
    v.version !== 1 ||
    !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(v.jobId) ||
    v.manifestKey !== `system/zip-requests/${v.jobId}.json` ||
    !/^[a-f0-9]{64}$/.test(v.fingerprint)
  )
    throw new Error("Invalid submission")
  return v
}
async function callback(input: Submission, action: string, details: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    jobId: input.jobId,
    fingerprint: input.fingerprint,
    action,
    ...details,
  })
  const response = await fetch(`${process.env.CALLBACK_URL}`, {
    method: "POST",
    headers: signedHeaders(await secret(), body),
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 409) return null
  if (!response.ok) throw new Error(`ZIP callback returned ${response.status}`)
  return (await response.json()) as { leaseToken?: string }
}
async function readJson(key: string): Promise<unknown> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  if (!result.Body) throw new Error("Missing manifest body")
  return JSON.parse(await result.Body.transformToString())
}
function validateManifest(value: unknown, input: Submission): ZipManifest {
  const m = value as ZipManifest
  if (
    !m ||
    m.version !== 1 ||
    m.jobId !== input.jobId ||
    m.fingerprint !== input.fingerprint ||
    !Array.isArray(m.entries) ||
    createHash("sha256").update(JSON.stringify(m.entries)).digest("hex") !== input.fingerprint
  )
    throw new Error("Manifest mismatch")
  const paths = new Set<string>()
  for (const e of m.entries) {
    if (
      !e ||
      typeof e.path !== "string" ||
      !e.path ||
      e.path.startsWith("/") ||
      e.path.includes("\\") ||
      e.path.includes("\0") ||
      e.path
        .replace(/\/$/, "")
        .split("/")
        .some((p) => !p || p === "." || p === "..") ||
      paths.has(e.path) ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      !(e.objectKey === null
        ? e.path.endsWith("/")
        : typeof e.objectKey === "string" &&
          e.objectKey.startsWith("objects/") &&
          !e.path.endsWith("/"))
    )
      throw new Error("Invalid ZIP entry")
    paths.add(e.path)
  }
  return m
}
function append(zip: ZipArchive, body: Readable | string, path: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", done)
      zip.off("error", failed)
      if (typeof body !== "string") body.off("error", failed)
      signal.removeEventListener("abort", aborted)
    }
    const done = (entry: { name: string }) => {
      if (entry.name === path) {
        cleanup()
        resolve()
      }
    }
    const failed = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const aborted = () => {
      if (typeof body !== "string") body.destroy()
      failed(new Error("ZIP exceeded Lambda time limit"))
    }
    zip.on("entry", done)
    zip.once("error", failed)
    if (typeof body !== "string") body.once("error", failed)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) return aborted()
    zip.append(body, { name: path, store: true })
  })
}
export async function buildZip(
  input: Submission,
  context: Pick<Context, "getRemainingTimeInMillis">,
) {
  const claim = await callback(input, "claim")
  if (!claim?.leaseToken) return
  const token = claim.leaseToken
  const outputKey = `downloads/${input.jobId}/${token}.zip`
  const outcomeKey = `system/zip-outcomes/${input.jobId}/${token}.json`
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, context.getRemainingTimeInMillis() - 30_000),
  )
  let outcome: Record<string, unknown>
  const zip = new ZipArchive({ store: true })
  const output = new PassThrough()
  output.on("error", () => {})
  zip.on("error", (error) => output.destroy(error))
  zip.pipe(output)
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket(), Key: outputKey, Body: output, ContentType: "application/zip" },
    partSize: 8 * 1024 * 1024,
    queueSize: 2,
    leavePartsOnError: false,
  })
  let uploadError: unknown
  const uploading = upload.done().catch((error) => {
    uploadError = error
    controller.abort()
    output.destroy(error)
  })
  const abort = () => {
    zip.abort()
    output.destroy(new Error("ZIP cancelled"))
    void upload.abort().catch(() => {})
  }
  controller.signal.addEventListener("abort", abort, { once: true })
  try {
    const manifest = validateManifest(await readJson(input.manifestKey), input)
    let processed = 0
    let reportedAt = 0
    for (const entry of manifest.entries) {
      if (controller.signal.aborted) throw new Error("ZIP exceeded Lambda time limit")
      if (entry.objectKey === null) {
        await append(zip, "", entry.path, controller.signal)
        continue
      }
      const object = await s3
        .send(new GetObjectCommand({ Bucket: bucket(), Key: entry.objectKey }), {
          abortSignal: controller.signal,
        })
        .catch(() => {
          throw new Error(`Missing or unreadable input: ${entry.path}`)
        })
      if (!object.Body || object.ContentLength !== entry.size)
        throw new Error(`Input size mismatch: ${entry.path}`)
      let length = 0
      const counter = new Transform({
        transform(chunk, _encoding, next) {
          length += chunk.length
          next(null, chunk)
        },
        flush(next) {
          next(length === entry.size ? null : new Error(`Incomplete input: ${entry.path}`))
        },
      })
      const body = object.Body as Readable
      body.on("error", (error) => counter.destroy(error))
      body.pipe(counter)
      try {
        await append(zip, counter, entry.path, controller.signal)
      } finally {
        body.destroy()
        counter.destroy()
      }
      processed++
      if (Date.now() - reportedAt > 2000) {
        await callback(input, "progress", { leaseToken: token, processed })
        reportedAt = Date.now()
      }
    }
    await zip.finalize()
    await uploading
    if (uploadError) throw uploadError
    outcome = { action: "completed", leaseToken: token, objectKey: outputKey }
  } catch (error) {
    controller.abort()
    await upload.abort().catch(() => {})
    await uploading
    outcome = {
      action: "failed",
      leaseToken: token,
      error: error instanceof Error ? error.message : "ZIP creation failed",
    }
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", abort)
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: outcomeKey,
      ContentType: "application/json",
      Body: JSON.stringify({ jobId: input.jobId, fingerprint: input.fingerprint, ...outcome }),
    }),
  )
  await callback(input, outcome.action as string, outcome)
}
export async function handler(event: APIGatewayProxyEventV2 | Submission, context: Context) {
  if (!("requestContext" in event)) {
    await buildZip(validateSubmission(event), context)
    return
  }
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString()
    : (event.body ?? "")
  const headers = new Headers(
    Object.entries(event.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
  )
  if (event.requestContext.http.method !== "POST" || !authenticated(await secret(), body, headers))
    return { statusCode: 401, body: "Unauthorized" }
  let input: Submission
  try {
    input = validateSubmission(JSON.parse(body))
    if (event.rawPath !== `/zip/${input.jobId}`) throw new Error("Path mismatch")
  } catch {
    return { statusCode: 400, body: "Invalid submission" }
  }
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.ZIP_BUILDER_FUNCTION_NAME ?? process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(input)),
    }),
  )
  return {
    statusCode: 202,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accepted: true, id: input.jobId }),
  }
}
