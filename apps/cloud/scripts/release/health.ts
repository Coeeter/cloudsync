const base = process.env.WORKER_HEALTH_URL
if (!base || new URL(base).protocol !== "https:")
  throw new Error("Configure the environment's deployed Worker health URL")
const response = await fetch(`${base.replace(/\/$/, "")}/health`, {
  signal: AbortSignal.timeout(20_000),
})
if (!response.ok || ((await response.json()) as { ok?: boolean }).ok !== true)
  throw new Error("Deployed Worker health check failed")
console.log("Deployed Worker health check passed")
