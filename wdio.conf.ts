import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"

import "@wdio/tauri-service"

const appBinaryPath = path.resolve("src-tauri/target/debug/tfolio")
const artifactDirectory = path.resolve("artifacts/e2e")
const specDirectory = path.resolve("test/e2e")

// A lane is one capability — its own WebDriver port and app data directory —
// running a fixed share of the specs; TFOLIO_E2E_SHARDS=1 restores one app.
const requestedShards = Number(process.env.TFOLIO_E2E_SHARDS) || 4
const shardCount = Math.min(Math.max(requestedShards, 1), 8)

// 4445 is the embedded WebDriver's own default; the lanes take the ports after
// it, so a lone lane binds exactly where it always did.
const baseEmbeddedPort = 4445

// Each lane's own display, named by the headless wrapper, keeps every app the
// focused window a serial run has; lanes beyond the list share the launcher's.
const laneDisplays = (process.env.TFOLIO_E2E_DISPLAYS ?? "")
  .split(/\s+/)
  .filter(Boolean)

const specFiles = readdirSync(specDirectory)
  .filter((name) => name.endsWith(".e2e.ts"))
  .map((name) => path.join(specDirectory, name))

function safeArtifactName(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")
}

function shardDataDirectory(index: number) {
  return path.join(artifactDirectory, "app-data", `shard-${index}`)
}

/** Each lane's share of the specs: heaviest dealt to the least-loaded lane,
    lightest first within it, so heavy suites stagger rather than open together. */
function shardSpecs(laneCount: number) {
  const lanes = Array.from({ length: laneCount }, () => ({
    specs: [] as { file: string; weight: number }[],
    weight: 0,
  }))

  // File size stands in for run time: a proxy needing no run to learn, and
  // only a balance to settle.
  const ordered = specFiles
    .map((file) => ({ file, weight: statSync(file).size }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file))

  for (const spec of ordered) {
    const lightest = lanes.reduce((a, b) => (b.weight < a.weight ? b : a))
    lightest.specs.push(spec)
    lightest.weight += spec.weight
  }

  return lanes.map((lane) =>
    lane.specs
      .sort((a, b) => a.weight - b.weight || a.file.localeCompare(b.file))
      .map((spec) => spec.file),
  )
}

const laneSpecs = shardSpecs(shardCount)
// A lane left holding no specs gets no app at all.
const laneCount = laneSpecs.filter((specs) => specs.length > 0).length

function laneEnvironment(index: number) {
  return {
    XDG_DATA_HOME: shardDataDirectory(index),
    ...(laneDisplays[index] ? { DISPLAY: laneDisplays[index] } : {}),
  }
}

function laneCapabilities(): WebdriverIO.Capabilities[] {
  return Array.from({ length: laneCount }, (_, index) => ({
    browserName: "tauri",
    // One spec per lane at a time: without this a lane could take a second
    // worker, and both would drive the same app on the same data directory.
    "wdio:maxInstances": 1,
    // `wdio:specs`, not `specs`: both schedule, but the summary's total reads
    // only this key and would otherwise count the whole suite once per lane.
    "wdio:specs": laneSpecs[index],
    "wdio:tauriServiceOptions": {
      embeddedPort: baseEmbeddedPort + index,
      env: laneEnvironment(index),
    },
  }))
}

/** The lane this worker process runs specs on, remembered from its session so
    failure artifacts can name the lane they came from. */
let workerDataDirectory = ""

export const config: WebdriverIO.Config = {
  runner: "local",
  maxInstances: laneCount,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        backendLogLevel: "info",
        captureBackendLogs: true,
        captureFrontendLogs: true,
        driverProvider: "embedded",
        frontendLogLevel: "info",
        logDir: path.join(artifactDirectory, "logs"),
        startTimeout: 90_000,
        statusPollTimeout: 5_000,
      },
    ],
  ],
  capabilities: laneCapabilities(),
  // A timing failure a busy machine jittered into being gets one retry; a
  // real regression fails the rerun too, so flakes are absorbed, not masked.
  specFileRetries: 1,
  logLevel: "info",
  outputDir: path.join(artifactDirectory, "wdio"),
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  onPrepare: () => {
    rmSync(artifactDirectory, { force: true, recursive: true })
    mkdirSync(artifactDirectory, { recursive: true })
    for (let index = 0; index < laneCount; index += 1) {
      mkdirSync(shardDataDirectory(index), { recursive: true })
    }
  },
  beforeSession: (_config, capabilities) => {
    // The specs locate the backend's settings through `XDG_DATA_HOME` (see
    // test/e2e/helpers.ts), which the launcher's environment leaves unnamed.
    const laneOptions = (
      capabilities as {
        "wdio:tauriServiceOptions"?: { env?: { XDG_DATA_HOME?: string } }
      }
    )["wdio:tauriServiceOptions"]
    const dataDirectory = laneOptions?.env?.XDG_DATA_HOME

    if (dataDirectory) {
      process.env.XDG_DATA_HOME = dataDirectory
      workerDataDirectory = dataDirectory
    }
  },
  afterTest: async (test, _context, result) => {
    if (result.passed) {
      return
    }

    const lane = safeArtifactName(path.basename(workerDataDirectory))
    const screenshotName = `${lane}-${safeArtifactName(test.title)}.png`

    try {
      await browser.saveScreenshot(
        path.join(artifactDirectory, screenshotName),
      )
    } catch (error) {
      console.error("Could not capture GUI failure screenshot", error)
    }
  },
}
