import { chromium } from "playwright"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { localSql } from "./d1"
const base = process.env.CLOUDSYNC_E2E_URL ?? "http://localhost:3310"
const id = randomUUID()
const token = randomUUID()
await localSql(
  "INSERT INTO sessions(id,email,tokenHash,expiresAt,lastSeenAt,createdAt) VALUES(?,?,?,?,?,?)",
  [
    id,
    "owner@example.test",
    createHash("sha256").update(token).digest("hex"),
    "2099-01-01T00:00:00Z",
    new Date().toISOString(),
    new Date().toISOString(),
  ],
)
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
})
try {
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: "cloudsync_session",
      value: token,
      url: base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(base)
  await page.getByRole("button", { name: "Upload", exact: true }).waitFor()
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 100
    canvas.height = 80
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Canvas unavailable")
    ctx.fillStyle = "red"
    ctx.fillRect(0, 0, 100, 80)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => {
        if (!b) throw new Error("PNG encoding failed")
        resolve(b)
      }, "image/png"),
    )
    return { data: btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()))) }
  })
  const filename = `browser-${randomUUID()}.png`
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: filename,
      mimeType: "image/png",
      buffer: Buffer.from(result.data, "base64"),
    })
  await page.getByText(filename, { exact: true }).first().waitFor({ timeout: 30000 })
  const rows = await localSql<{ thumbnailKey: string; previewKey: string }>(
    "SELECT thumbnailKey,previewKey FROM entries WHERE name=?",
    [filename],
  )
  if (!rows[0]?.thumbnailKey || !rows[0]?.previewKey)
    throw new Error("Browser upload did not save previews")
  const thumbnail = await fetch(`http://127.0.0.1:54332/cloudsync-local/${rows[0].thumbnailKey}`, {
    method: "HEAD",
  })
  if (!thumbnail.ok) throw new Error("Thumbnail object is unavailable")
  const media: Record<string, number> = {}
  for (const [name, mime, path] of [
    ["video.mp4", "video/mp4", "/tmp/cloudsync-preview-fixtures/video.mp4"],
    ["page.pdf", "application/pdf", "/tmp/cloudsync-preview-fixtures/page.pdf"],
  ]) {
    const filename = `browser-${randomUUID()}-${name}`
    const start = performance.now()
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: filename, mimeType: mime, buffer: await readFile(path) })
    await page.getByText(filename, { exact: true }).first().waitFor({ timeout: 30000 })
    const rows = await localSql<{ thumbnailKey: string; previewKey: string }>(
      "SELECT thumbnailKey,previewKey FROM entries WHERE name=?",
      [filename],
    )
    if (!rows[0]?.thumbnailKey || !rows[0]?.previewKey) throw new Error(`Missing ${mime} preview`)
    media[mime] = Math.round(performance.now() - start)
  }
  for (const key of [rows[0].thumbnailKey, rows[0].previewKey])
    await fetch(`http://127.0.0.1:54332/cloudsync-local/${key}`, { method: "DELETE" })
  await localSql(
    "UPDATE entries SET thumbnailKey=NULL,previewKey=NULL,previewError='fixture failure' WHERE name=?",
    [filename],
  )
  await page.reload()
  await page.getByRole("button", { name: `Actions for ${filename}`, exact: true }).click()
  const retryStart = performance.now()
  await page.getByRole("menuitem", { name: "Retry preview" }).click()
  const deadline = Date.now() + 30000
  let ready = false
  while (!ready && Date.now() < deadline) {
    const rows = await localSql<{ thumbnailKey: string; previewError: string | null }>(
      "SELECT thumbnailKey,previewError FROM entries WHERE name=?",
      [filename],
    )
    ready = !!rows[0]?.thumbnailKey && !rows[0].previewError
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error("Retry button did not replace the preview")
  media.retryMs = Math.round(performance.now() - retryStart)
  await page.reload()
  await page.screenshot({ path: "/tmp/cloudsync-d1-browser.png", fullPage: true })
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(
    JSON.stringify({
      browserUpload: {
        thumbnailBytes: Number(thumbnail.headers.get("content-length")),
        mime: thumbnail.headers.get("content-type"),
      },
      media,
      errors,
    }),
  )
} finally {
  await browser.close()
  await localSql("DELETE FROM sessions WHERE id=?", [id])
}
