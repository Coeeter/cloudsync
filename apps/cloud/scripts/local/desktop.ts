import { _electron } from "playwright"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const directory = await mkdtemp(join(tmpdir(), "cloudsync-desktop-"))
const data = join(directory, "data")
await mkdir(data)
const launcher = join(directory, "start.cjs")
const main = new URL("../../../desktop/out/main/index.js", import.meta.url).pathname
await writeFile(
  launcher,
  `const {app}=require('electron');app.setPath('userData',${JSON.stringify(data)});import(${JSON.stringify(main)});`,
)
const require = createRequire(new URL("../../../desktop/package.json", import.meta.url))
const env = { ...process.env, CLOUDSYNC_URL: "http://localhost:3310" }
delete env.ELECTRON_RUN_AS_NODE
const instance = await _electron.launch({
  executablePath: require("electron"),
  args: [launcher],
  env,
})
try {
  const page = await instance.firstWindow()
  await page.getByRole("button", { name: "Send code" }).waitFor()
  const state = await page.evaluate(() => window.cloudsync.state())
  if (state.watching !== null || state.authenticated || state.missingTools.length)
    throw new Error("Unexpected desktop startup state")
  await page.screenshot({ path: "/tmp/cloudsync-desktop-startup.png" })
  console.log(
    JSON.stringify({
      desktopStartup: "passed",
      missingTools: state.missingTools,
      watching: state.watching,
      authenticated: state.authenticated,
    }),
  )
} finally {
  await instance.close()
  await rm(directory, { recursive: true, force: true })
}
