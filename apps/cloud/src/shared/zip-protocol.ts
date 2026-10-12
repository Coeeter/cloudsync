import { createHmac, timingSafeEqual } from "node:crypto"
export interface ZipEntry {
  path: string
  objectKey: string | null
  size: number
}
export interface ZipManifest {
  version: 1
  jobId: string
  fingerprint: string
  entries: ZipEntry[]
}
export function signedHeaders(secret: string, body: string) {
  const timestamp = String(Date.now())
  return {
    "content-type": "application/json",
    "x-cloudsync-time": timestamp,
    "x-cloudsync-signature": createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex"),
  }
}
export function authenticated(
  secret: string,
  body: string,
  headers: { get: (name: string) => string | null },
) {
  const timestamp = headers.get("x-cloudsync-time")
  const signature = headers.get("x-cloudsync-signature")
  if (
    !timestamp ||
    !signature ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
}
