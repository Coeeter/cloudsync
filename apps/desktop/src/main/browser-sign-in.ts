import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>CloudSync</title>
<body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;color:#444">
<p>${message}</p></body>`

// Loopback redirect for native apps (RFC 8252). The cloud's /auth/desktop page sits behind
// Cloudflare Access, so the system browser signs in there and is redirected back here with the
// Access token. Custom URL schemes were rejected: they do not register for unpackaged dev builds.
export function browserSignIn(
  cloudUrl: string,
  open: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<string> {
  const state = randomBytes(24).toString("base64url")
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const token = url.searchParams.get("token")
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !token) {
        response.writeHead(400, { "content-type": "text/html" }).end(page("Invalid sign-in link."))
        return
      }
      response
        .writeHead(200, { "content-type": "text/html", connection: "close" })
        .end(page("Signed in to CloudSync. You can close this tab."))
      finish(() => resolve(token))
    })
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", abort)
      server.close()
      server.closeAllConnections()
      settle()
    }
    const abort = () => finish(() => reject(new Error("Sign-in was cancelled")))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort)
    server.on("error", (cause) => finish(() => reject(cause)))
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      const url = new URL("/auth/desktop", cloudUrl)
      url.searchParams.set("port", String(port))
      url.searchParams.set("state", state)
      open(url.toString()).catch((cause) => finish(() => reject(cause)))
    })
  })
}
