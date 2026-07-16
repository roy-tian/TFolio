import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import "@wdio/tauri-service"

const appBinaryPath = path.resolve("src-tauri/target/debug/tfolio")
const artifactDirectory = path.resolve("artifacts/e2e")

function safeArtifactName(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./test/e2e/**/*.e2e.ts"],
  maxInstances: 1,
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
  capabilities: [
    {
      browserName: "tauri",
    },
  ],
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
  },
  afterTest: async (test, _context, result) => {
    if (result.passed) {
      return
    }

    const screenshotName = `${safeArtifactName(test.title)}.png`

    try {
      await browser.saveScreenshot(
        path.join(artifactDirectory, screenshotName),
      )
    } catch (error) {
      console.error("Could not capture GUI failure screenshot", error)
    }
  },
}
