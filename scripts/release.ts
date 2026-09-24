import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

const root = path.resolve(import.meta.dirname, "..")
const versionFiles = [
  "package.json",
  "bun.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
]
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

type CommandOptions = {
  allowedStatuses?: number[]
  capture?: boolean
  env?: NodeJS.ProcessEnv
}

function fail(message: string): never {
  console.error(`Release error: ${message}`)
  process.exit(1)
}

function command(
  bin: string,
  args: string[],
  {
    allowedStatuses = [0],
    capture = false,
    env = process.env,
  }: CommandOptions = {},
) {
  const result = spawnSync(bin, args, {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: capture ? "pipe" : "inherit",
  })

  if (result.error) {
    fail(`could not run ${bin} ${args.join(" ")}: ${result.error.message}`)
  }

  const status = result.status ?? -1
  if (!allowedStatuses.includes(status)) {
    const details =
      capture && result.stderr.trim()
        ? `: ${result.stderr.trim()}`
        : ` (exit code ${status})`
    fail(`${bin} ${args.join(" ")} failed${details}`)
  }

  return {
    status,
    stdout: capture ? result.stdout.trim() : "",
  }
}

function git(args: string[], options?: CommandOptions) {
  return command("git", args, options)
}

function parseArgs(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log("usage: bun scripts/release.ts <version> [--push]")
    process.exit(0)
  }

  const unknownOption = args.find(
    (arg) => arg.startsWith("-") && arg !== "--push",
  )
  if (unknownOption) {
    fail(`unknown option ${unknownOption}`)
  }

  const push = args.includes("--push")
  const versions = args.filter((arg) => arg !== "--push")
  if (versions.length !== 1 || args.length !== (push ? 2 : 1)) {
    fail("usage: bun scripts/release.ts <version> [--push]")
  }

  const version = versions[0]
  const match = semverPattern.exec(version)
  if (!match) {
    fail(`"${version}" is not a valid bare semantic version`)
  }

  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (major > 255 || minor > 255 || patch > 65535) {
    fail(
      `"${version}" exceeds Windows MSI limits (major/minor <= 255, patch <= 65535)`,
    )
  }

  return { push, version }
}

function readMainBranch(currentBranch: string) {
  const remoteHead = git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowedStatuses: [0, 1], capture: true },
  )

  if (remoteHead.status === 0) {
    if (!remoteHead.stdout.startsWith("origin/")) {
      fail(`unexpected origin HEAD reference ${remoteHead.stdout}`)
    }
    return remoteHead.stdout.slice("origin/".length)
  }

  if (currentBranch === "main" || currentBranch === "master") {
    return currentBranch
  }

  fail("could not identify the main branch from origin/HEAD")
}

function ensureTagIsAvailable(tag: string, push: boolean) {
  const localTag = git(
    ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
    { allowedStatuses: [0, 1], capture: true },
  )
  if (localTag.status === 0) {
    fail(`tag ${tag} already exists locally`)
  }

  if (!push) {
    return
  }

  const remoteTag = git(
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { allowedStatuses: [0, 2], capture: true },
  )
  if (remoteTag.status === 0) {
    fail(`tag ${tag} already exists on origin`)
  }
}

function refreshAndCheckUpstream(branch: string) {
  const upstream = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { capture: true },
  ).stdout
  if (upstream !== `origin/${branch}`) {
    fail(`expected ${branch} to track origin/${branch}, found ${upstream}`)
  }

  git(["fetch", "--quiet", "origin"])
  const counts = git(
    ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
    { capture: true },
  ).stdout
  const [behind, ahead] = counts.split(/\s+/).map(Number)
  if (behind > 0) {
    const divergence = ahead > 0 ? " and has diverged" : ""
    fail(`${branch} is ${behind} commit(s) behind ${upstream}${divergence}`)
  }
}

function checkVersionChanges() {
  const changed = git(["diff", "--name-only"], { capture: true }).stdout
    .split("\n")
    .filter(Boolean)
  const unexpected = changed.filter((file) => !versionFiles.includes(file))

  if (unexpected.length > 0) {
    fail(`version bump changed unexpected files: ${unexpected.join(", ")}`)
  }
  if (changed.length === 0) {
    fail("version bump produced no changes")
  }

  return changed
}

function readCurrentVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
  if (typeof packageJson.version !== "string") {
    fail("package.json does not contain a version")
  }

  return packageJson.version
}

function main() {
  if (!process.versions.bun) {
    fail("the release script must be run with Bun")
  }

  const { push, version } = parseArgs(process.argv.slice(2))
  const tag = `v${version}`
  const branch = git(["branch", "--show-current"], { capture: true }).stdout
  if (!branch) {
    fail("releases cannot be cut from a detached HEAD")
  }

  const mainBranch = readMainBranch(branch)
  if (branch !== mainBranch) {
    fail(`releases must be cut from ${mainBranch}, not ${branch}`)
  }

  const status = git(["status", "--porcelain"], { capture: true }).stdout
  if (status) {
    fail("the working tree must be clean before cutting a release")
  }

  ensureTagIsAvailable(tag, push)
  if (push) {
    refreshAndCheckUpstream(branch)
  }

  const currentVersion = readCurrentVersion()
  if (currentVersion !== version) {
    command(process.execPath, ["scripts/version.mjs", version])
  }
  command(process.execPath, ["scripts/version.mjs", "--check"], {
    env: { ...process.env, RELEASE_TAG: tag },
  })

  if (currentVersion !== version) {
    const changed = checkVersionChanges()
    git(["add", "--", ...versionFiles])
    const staged = git(["diff", "--cached", "--name-only"], {
      capture: true,
    }).stdout
      .split("\n")
      .filter(Boolean)
    if (staged.join("\n") !== changed.join("\n")) {
      fail("staged release files do not match the version bump")
    }

    git([
      "commit",
      "-m",
      `chore(release): ${version}`,
      "-m",
      `- bump synchronized package and Cargo metadata to ${version}`,
    ])
  }
  // No local tag: the Release workflow creates it when it publishes, so a
  // failed build never leaves a tag pointing at an unreleased commit.
  if (push) {
    git(["push", "origin", `refs/heads/${branch}`])
  }

  const dispatch = `gh workflow run release.yml --ref ${branch}`
  console.log(
    push
      ? `Pushed ${branch} for ${tag}. Publish it with: ${dispatch}`
      : `Prepared ${tag} on ${branch}. Push it, then publish with: ${dispatch}`,
  )
}

main()
