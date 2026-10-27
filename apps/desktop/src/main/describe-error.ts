// RPC transport failures surface as "HttpError: " with an empty message, so the useful detail
// (failure kind, HTTP status, socket errno) has to be collected from the cause chain.
export function describe(cause: unknown): string {
  const parts: string[] = []
  let current: unknown = cause
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const value = current as {
      kind?: unknown
      code?: unknown
      message?: unknown
      response?: { status?: unknown }
      reason?: unknown
      cause?: unknown
    }
    for (const raw of [value.kind, value.code, value.response?.status, value.message]) {
      if (typeof raw !== "string" && typeof raw !== "number") continue
      const part = String(raw).replace(/:\s*$/, "").trim()
      if (part && !parts.some((existing) => existing.includes(part))) parts.push(part)
    }
    current = value.reason ?? value.cause
  }
  return parts.join(": ")
}
