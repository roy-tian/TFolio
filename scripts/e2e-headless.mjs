// One Xvfb per lane, so each app is its display's only — and so focused —
// window, which focus()-driven popups need. Keep the lane math with wdio.conf.ts.
import { spawn } from "node:child_process"

const shardCount = Math.min(
  Math.max(Number(process.env.TFOLIO_E2E_SHARDS) || 4, 1),
  8,
)

const servers = []

/** Killed on every way out — run end, failed setup, interrupt during setup —
    or the displays and the bus would outlive the wrapper that started them. */
function stopServers() {
  for (const server of servers) {
    server.kill("SIGTERM")
  }
}

let run = null

// Registered before anything can fail, so an interrupt during setup still
// cleans up; once the run exists, signalling it ends this wrapper normally.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (run) {
      run.kill(signal)
      return
    }
    stopServers()
    process.exit(1)
  })
}

/** Spawned and registered for teardown before anything is awaited, so a
    failure partway through setup cannot leak the ones already started. */
function startServer(command, arguments_) {
  const server = spawn(command, arguments_, {
    stdio: ["ignore", "pipe", "inherit"],
  })
  servers.push(server)
  return server
}

/** Wires a server's failure modes to `reject`: a failed spawn reports
    through "error" rather than "exit", and either beats the timeout. */
function rejectWith(server, reject, describe) {
  server.once("error", (error) =>
    reject(new Error(`${describe}: ${error.message}`)),
  )
  server.once("exit", (code, signal) =>
    reject(new Error(`${describe} (code=${code} signal=${signal})`)),
  )
}

// A private, empty session bus: the host's wedged xdg-desktop-portal stalls
// each GTK boot a 25s D-Bus timeout, and an empty bus fails lookups at once.
async function startBus() {
  const bus = startServer("dbus-daemon", [
    "--session",
    "--print-address=1",
    "--nofork",
  ])

  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dbus-daemon never named its address")),
      15_000,
    )

    rejectWith(bus, reject, "dbus-daemon could not run")
    bus.stdout.once("data", (chunk) => {
      clearTimeout(timer)
      resolve(chunk.toString("ascii").trim())
    })
  })
  process.env.DBUS_SESSION_BUS_ADDRESS = address
  // Nothing in the suite drives accessibility, and AT-SPI's own bus lookup is
  // another per-app startup cost.
  process.env.NO_AT_BRIDGE = "1"
}

async function startXvfb() {
  const server = startServer("Xvfb", [
    "-displayfd",
    "1",
    "-nolisten",
    "tcp",
    "-screen",
    "0",
    "1280x1024x24",
  ])

  // `-displayfd 1` names the display only once the server accepts
  // connections, so the number below is one the apps can really use.
  return await new Promise((resolve, reject) => {
    let pending = ""
    const timer = setTimeout(
      () => reject(new Error("Xvfb never named its display")),
      15_000,
    )

    rejectWith(server, reject, "Xvfb could not run")
    server.stdout.on("data", (chunk) => {
      pending += chunk.toString("ascii")
      const match = pending.match(/^(\d+)\n/)
      if (match) {
        clearTimeout(timer)
        resolve(`:${match[1]}`)
      }
    })
  })
}

try {
  await startBus()

  const displays = []
  for (let index = 0; index < shardCount; index += 1) {
    displays.push(await startXvfb())
  }
  process.env.TFOLIO_E2E_DISPLAYS = displays.join(" ")

  run = spawn("bun", ["run", "test:e2e:run"], {
    stdio: "inherit",
    env: process.env,
  })

  process.exitCode = await new Promise((resolve, reject) => {
    // A death by signal carries no code, and passing that null through would
    // make an interrupted run exit 0 — success — behind this wrapper.
    run.once("error", (error) =>
      reject(new Error(`could not run the suite: ${error.message}`)),
    )
    run.once("exit", (code) => resolve(code ?? 1))
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  // Killed here, not in an exit hook: the servers' open pipes keep the event
  // loop from draining, so that hook would never fire.
  stopServers()
}
