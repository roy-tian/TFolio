// Local release pre-flight: every single-platform check CI runs, plus a real
// bundle for the current OS. Run it before tagging a release so type, lint,
// test, compile, and bundling failures surface locally instead of as a failed
// GitHub Actions run an hour later.
//
// It deliberately does NOT cover other operating systems — `tauri:bundle` here
// only proves the bundler works on whatever you are running. To validate the
// Windows MSI, macOS dmgs, and Linux packages, trigger the "Bundle dry-run"
// workflow (.github/workflows/bundle-dry-run.yml), which runs this same
// bundling step on all four release targets without publishing anything.
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

const root = path.resolve(import.meta.dirname, "..")
const manifest = "src-tauri/Cargo.toml"

const steps = [
  {
    label: "Version consistency (package.json \u2194 lockfiles)",
    bin: "bun",
    args: ["run", "version:check"],
  },
  { label: "Frontend build (tsc + vite)", bin: "bun", args: ["run", "build"] },
  { label: "Frontend unit tests", bin: "bun", args: ["run", "test"] },
  {
    label: "Rust formatting",
    bin: "cargo",
    args: ["fmt", "--manifest-path", manifest, "--", "--check"],
  },
  {
    label: "Rust clippy (warnings as errors)",
    bin: "cargo",
    args: [
      "clippy",
      "--manifest-path",
      manifest,
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    label: "Rust check",
    bin: "cargo",
    args: ["check", "--manifest-path", manifest, "--locked"],
  },
  {
    label: "Rust unit tests",
    bin: "cargo",
    args: ["test", "--manifest-path", manifest, "--locked"],
  },
  {
    label: "Bundle installers (current OS only)",
    bin: "bun",
    args: ["run", "tauri:bundle"],
  },
]

let failed = null
for (const step of steps) {
  console.log(`\n\u25b8 ${step.label}`)
  const result = spawnSync(step.bin, step.args, {
    cwd: root,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    failed = step
    break
  }
  console.log(`\u2713 ${step.label}`)
}

console.log("")
if (failed) {
  console.error(`\u2717 Pre-flight failed at: ${failed.label}`)
  console.error("  Fix the above, then re-run `bun run preflight`.")
  console.error(
    "  This only covers the current OS. Cross-platform bundling (Windows MSI,",
  )
  console.error(
    "  macOS dmg, Linux packages) is checked by the Bundle dry-run workflow.",
  )
  process.exit(1)
}

console.log("\u2713 All pre-flight checks passed locally.")
console.log(
  "  Before tagging, also run the Bundle dry-run workflow to cover the other",
)
console.log('  operating systems: Actions \u2192 "Bundle dry-run" \u2192 Run workflow.')
