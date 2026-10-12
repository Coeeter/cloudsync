import { handler, buildZip } from "../../src/lambda/zip"
import type { APIGatewayProxyEventV2, Context } from "aws-lambda"
// Replaces only API Gateway/Lambda event delivery locally; the real handlers still use S3 and callbacks.
const tasks = new Set<Promise<unknown>>()
let chain: Promise<unknown> = Promise.resolve()
const invocation = Bun.serve({
  port: 3312,
  async fetch(request) {
    const event = (await request.json()) as Parameters<typeof buildZip>[0]
    const task = chain
      .then(async () => {
        if (process.env.ZIP_RIE_URL) {
          const response = await fetch(process.env.ZIP_RIE_URL, {
            method: "POST",
            body: JSON.stringify(event),
          })
          const result = (await response.json()) as { errorMessage?: string }
          if (result.errorMessage) throw new Error(result.errorMessage)
        } else await buildZip(event, { getRemainingTimeInMillis: () => 900_000 })
      })
      .catch(() => console.error("Local ZIP invocation failed"))
      .finally(() => tasks.delete(task))
    chain = task
    tasks.add(task)
    return new Response(null, { status: 202 })
  },
})
const server = Bun.serve({
  port: 3311,
  async fetch(request) {
    const body = await request.text()
    const event = {
      requestContext: { http: { method: request.method } },
      rawPath: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body,
      isBase64Encoded: false,
    } as APIGatewayProxyEventV2
    const response = await handler(event, { getRemainingTimeInMillis: () => 900_000 } as Context)
    return new Response(response?.body, {
      status: response?.statusCode ?? 500,
      headers: response?.headers,
    })
  },
})
console.log(`Local ZIP endpoint listening on ${server.port}; async delivery on ${invocation.port}`)
