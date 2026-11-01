import { describe, expect, it } from "bun:test"
import { browserSignIn } from "./browser-sign-in"

const callback = (opened: string, state?: string) => {
  const url = new URL(opened)
  const target = new URL(`http://127.0.0.1:${url.searchParams.get("port")}/callback`)
  target.searchParams.set("state", state ?? url.searchParams.get("state") ?? "")
  target.searchParams.set("token", "access-jwt")
  return fetch(target)
}

describe("browserSignIn", () => {
  it("opens the cloud sign-in page and resolves with the token from a matching callback", async () => {
    let opened = ""
    const token = await browserSignIn(
      "https://sync.example.test",
      async (url) => {
        opened = url
        const forged = await callback(url, "forged-state")
        expect(forged.status).toBe(400)
        const real = await callback(url)
        expect(real.status).toBe(200)
      },
      new AbortController().signal,
    )
    expect(token).toBe("access-jwt")
    const url = new URL(opened)
    expect(url.origin + url.pathname).toBe("https://sync.example.test/auth/desktop")
    await expect(callback(opened)).rejects.toThrow()
  })

  it("stops listening when cancelled", async () => {
    const controller = new AbortController()
    let opened = ""
    const pending = browserSignIn(
      "https://sync.example.test",
      async (url) => {
        opened = url
        controller.abort()
      },
      controller.signal,
    )
    await expect(pending).rejects.toThrow("Sign-in was cancelled")
    await expect(callback(opened)).rejects.toThrow()
  })
})
