import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
const attachmentContentDisposition = (filename: string) => {
  const fallback = filename.replaceAll(/[^\x20-\x7e]|["\\]/g, "_")
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

const handler = runInNewContext(
  `${readFileSync(new URL("../../../../../infra/cloudfront-download-response.js", import.meta.url), "utf8")}\nhandler`,
)
const event = (filename?: string) => ({
  request: {
    querystring: filename
      ? {
          "response-content-disposition": {
            value: new URLSearchParams({ value: attachmentContentDisposition(filename) })
              .toString()
              .slice(6),
          },
        }
      : {},
  },
  response: {
    statusCode: 200,
    headers: { "content-disposition": { value: 'attachment; filename="stored.zip"' } },
  },
})

describe("CloudFront attachment response", () => {
  it("sets each filename independently on a cached response", () => {
    const first = handler(event("日本語.zip"))
    const second = handler(event("second.zip"))
    expect(first.headers["content-disposition"].value).toBe(
      attachmentContentDisposition("日本語.zip"),
    )
    expect(second.headers["content-disposition"].value).toBe(
      attachmentContentDisposition("second.zip"),
    )
    expect(second.headers["cache-control"].value).toBe("private, no-store")
    expect(handler(event()).headers["content-disposition"].value).toContain("stored.zip")
  })

  it("ignores malformed, duplicate, or injected header parameters", () => {
    for (const parameter of [
      { value: "%" },
      { value: "attachment%3B%20filename=%22x%22%0D%0AX-Evil:%20yes" },
      { value: "x", multiValue: [{ value: "x" }, { value: "y" }] },
    ]) {
      const input = event()
      input.request.querystring = { "response-content-disposition": parameter } as never
      expect(handler(input).headers["content-disposition"].value).toContain("stored.zip")
    }
  })
})
