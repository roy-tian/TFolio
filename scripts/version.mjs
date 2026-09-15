import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const paths = {
  packageJson: path.join(root, "package.json"),
  bunLock: path.join(root, "bun.lock"),
  cargoToml: path.join(root, "src-tauri", "Cargo.toml"),
  cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
  tauriConfig: path.join(root, "src-tauri", "tauri.conf.json"),
  website: path.join(root, "website", "index.html"),
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function fail(message) {
  console.error(`Version error: ${message}`)
  process.exit(1)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function syncBunLock({ frozen = false } = {}) {
  if (!process.versions.bun) {
    fail("the version script must be run with Bun")
  }

  const args = ["install", "--lockfile-only"]
  if (frozen) {
    args.push("--frozen-lockfile")
  }

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  })

  if (result.error) {
    fail(`could not synchronize bun.lock: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`could not synchronize bun.lock (exit code ${result.status ?? "unknown"})`)
  }
}

function parseVersion(version) {
  const match = semverPattern.exec(version)
  if (!match) {
    fail(`"${version}" is not a valid semantic version`)
  }

  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }

  if (parsed.major > 255 || parsed.minor > 255 || parsed.patch > 65535) {
    fail(
      `"${version}" exceeds Windows MSI limits (major/minor <= 255, patch <= 65535)`,
    )
  }

  return parsed
}

function nextVersion(currentVersion, requestedVersion) {
  const current = parseVersion(currentVersion)
  let version

  switch (requestedVersion) {
    case "major":
      version = `${current.major + 1}.0.0`
      break
    case "minor":
      version = `${current.major}.${current.minor + 1}.0`
      break
    case "patch":
      version = `${current.major}.${current.minor}.${current.patch + 1}`
      break
    default:
      version = requestedVersion
  }

  parseVersion(version)
  return version
}

function replaceVersion(content, pattern, version, fileName) {
  const match = pattern.exec(content)
  if (!match) {
    fail(`could not find the project version in ${fileName}`)
  }

  return content.replace(pattern, (_, prefix, suffix) => {
    return `${prefix}${version}${suffix}`
  })
}

// SVG path data is full of digit.digit.digit runs; only the page's text,
// URLs, and script carry the project version.
function websiteVersionTokens(content) {
  const withoutSvg = content.replace(/<svg[\s\S]*?<\/svg>/g, "")
  return [...withoutSvg.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g)].map(
    (match) => match[0],
  )
}

function replaceWebsiteVersion(content, currentVersion, version) {
  const pattern = new RegExp(
    `(?<![\\d.])${currentVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.])`,
    "g",
  )
  if (!pattern.test(content)) {
    fail("could not find the project version in website/index.html")
  }

  return content.replace(pattern, version)
}

function readVersions() {
  const packageJson = readJson(paths.packageJson)
  const cargoToml = fs.readFileSync(paths.cargoToml, "utf8")
  const cargoLock = fs.readFileSync(paths.cargoLock, "utf8")
  const tauriConfig = readJson(paths.tauriConfig)
  const cargoTomlMatch = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(
    cargoToml,
  )
  const cargoLockMatch =
    /^\[\[package\]\]\r?\nname = "tfolio"\r?\nversion = "([^"]+)"/m.exec(
      cargoLock,
    )

  if (!cargoTomlMatch) {
    fail("could not find [package].version in src-tauri/Cargo.toml")
  }
  if (!cargoLockMatch) {
    fail("could not find the tfolio package in src-tauri/Cargo.lock")
  }

  return {
    packageJson: packageJson.version,
    cargoToml: cargoTomlMatch[1],
    cargoLock: cargoLockMatch[1],
    tauriConfig: tauriConfig.version,
    website: websiteVersionTokens(fs.readFileSync(paths.website, "utf8")),
  }
}

function checkVersions() {
  const versions = readVersions()
  parseVersion(versions.packageJson)

  const expected = versions.packageJson
  const websiteVersions = [...new Set(versions.website)]
  const mismatches = Object.entries({
    "src-tauri/Cargo.toml": versions.cargoToml,
    "src-tauri/Cargo.lock": versions.cargoLock,
    "website/index.html": websiteVersions.join(", ") || null,
  }).filter(([, version]) => version !== expected)

  if (mismatches.length > 0) {
    const details = mismatches
      .map(([file, version]) => `${file} has ${version ?? "no version"}`)
      .join("; ")
    fail(`expected every project file to use ${expected}; ${details}`)
  }

  if (versions.tauriConfig !== "../package.json") {
    fail(
      `src-tauri/tauri.conf.json must use ../package.json as its version source, found ${versions.tauriConfig}`,
    )
  }

  if (!fs.existsSync(paths.bunLock)) {
    fail("bun.lock is missing; run bun install")
  }
  syncBunLock({ frozen: true })

  const releaseTag = process.env.RELEASE_TAG
  if (releaseTag && releaseTag !== `v${expected}`) {
    fail(`release tag ${releaseTag} does not match project version v${expected}`)
  }

  console.log(
    `Version ${expected} is consistent${releaseTag ? ` with tag ${releaseTag}` : ""}.`,
  )
}

function updateVersions(requestedVersion) {
  const packageJson = readJson(paths.packageJson)
  const currentVersion = packageJson.version
  const version = nextVersion(currentVersion, requestedVersion)

  if (version === currentVersion) {
    fail(`project version is already ${version}`)
  }

  packageJson.version = version

  const cargoToml = replaceVersion(
    fs.readFileSync(paths.cargoToml, "utf8"),
    /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(".*$)/m,
    version,
    "src-tauri/Cargo.toml",
  )
  const cargoLock = replaceVersion(
    fs.readFileSync(paths.cargoLock, "utf8"),
    /(^\[\[package\]\]\r?\nname = "tfolio"\r?\nversion = ")[^"]+(".*$)/m,
    version,
    "src-tauri/Cargo.lock",
  )
  const website = replaceWebsiteVersion(
    fs.readFileSync(paths.website, "utf8"),
    currentVersion,
    version,
  )

  fs.writeFileSync(paths.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`)
  fs.writeFileSync(paths.cargoToml, cargoToml)
  fs.writeFileSync(paths.cargoLock, cargoLock)
  fs.writeFileSync(paths.website, website)
  syncBunLock()
  console.log(`Updated project version to ${version}.`)
}

const args = process.argv.slice(2)
if (args[0] === "--check") {
  if (args.length !== 1) {
    fail("--check does not accept additional arguments")
  }
  checkVersions()
} else {
  const [requestedVersion] = args
  if (!requestedVersion || args.length !== 1) {
    fail(
      "usage: bun run version:bump <major|minor|patch|X.Y.Z>",
    )
  }

  updateVersions(requestedVersion)
}
