import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

// The commit the fonts are taken from, not a branch: a moving reference would
// change the bytes under the checksums below and break every build at once.
const FONT_COMMIT = "2894aab31764f10f29c421bdfd2340d3b382d384"
const repositoryRoot = resolve(import.meta.dirname, "..")
const outputDirectory = join(repositoryRoot, "src-tauri", "resources", "fonts")

// One fallback face for text standard fonts cannot draw; not bundled — the app
// fetches these same pinned bytes at runtime, and this copy keeps tests offline.
const fonts = [
  {
    name: "NotoSansSC.ttf",
    source: "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    host: "jsdelivr",
    bytes: 17772300,
    sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    license: { name: "LICENSE.NotoSansSC", source: "ofl/notosanssc/OFL.txt" },
  },
]

const versionPath = join(outputDirectory, "VERSION")
// The marker changes if the commit or any font changes, so editing this script
// never leaves a stale bundle in place.
const cacheMarker = [FONT_COMMIT, ...fonts.map((font) => font.name)].join("\n")

const ready =
  existsSync(versionPath) &&
  readFileSync(versionPath, "utf8").trim() === cacheMarker &&
  fonts.every((font) => existsSync(join(outputDirectory, font.name)))

if (ready) {
  console.log(`Fonts are ready in ${outputDirectory}`)
  process.exit(0)
}

// jsDelivr serves commit-pinned paths from a CDN; a source past its per-file
// ceiling falls back to GitHub's raw host, which has no such limit.
const contentUrl = (font, path) =>
  font.host === "raw"
    ? `https://raw.githubusercontent.com/google/fonts/${FONT_COMMIT}/${path}`
    : `https://cdn.jsdelivr.net/gh/google/fonts@${FONT_COMMIT}/${path}`

async function download(url, destination) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}`)
  }

  if (!response.body) {
    throw new Error(`${url} returned an empty response body`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

// Staged beside the final files: Windows runners put temp and the checkout on
// different volumes, where renameSync cannot move; this keeps the rename atomic.
mkdirSync(outputDirectory, { recursive: true })
const temporaryDirectory = mkdtempSync(
  join(outputDirectory, ".tfolio-fonts-"),
)

try {

  for (const font of fonts) {
    const stagedDownload = join(temporaryDirectory, `${font.name}.download`)
    const stagedOutput = join(temporaryDirectory, font.name)
    const stagedLicense = join(temporaryDirectory, font.license.name)

    console.log(`Downloading ${font.name} from google/fonts@${FONT_COMMIT}`)
    await download(contentUrl(font, font.source), stagedDownload)

    const bytes = new Uint8Array(await Bun.file(stagedDownload).arrayBuffer())

    if (bytes.length !== font.bytes) {
      throw new Error(
        `${font.name} size mismatch: expected ${font.bytes}, got ${bytes.length}`,
      )
    }

    const digest = createHash("sha256").update(bytes).digest("hex")

    if (digest !== font.sha256) {
      throw new Error(
        `${font.name} checksum mismatch: expected ${font.sha256}, got ${digest}`,
      )
    }

    renameSync(stagedDownload, stagedOutput)

    await download(contentUrl(font, font.license.source), stagedLicense)

    // Moved into place only once both files are whole, so an interrupted run
    // cannot leave a half-written font; the cache marker is written last too.
    renameSync(stagedOutput, join(outputDirectory, font.name))
    renameSync(stagedLicense, join(outputDirectory, font.license.name))
  }

  writeFileSync(versionPath, `${cacheMarker}\n`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}

// A face dropped from the list above must not linger where the tests read, so
// the directory is swept — only ever after the staging directory has gone.
const expected = new Set([
  ".gitkeep",
  "VERSION",
  ...fonts.flatMap((font) => [font.name, font.license.name]),
])

for (const entry of readdirSync(outputDirectory)) {
  if (!expected.has(entry)) {
    rmSync(join(outputDirectory, entry), { force: true, recursive: true })
    console.log(`Removed ${entry}, which is no longer bundled`)
  }
}

console.log(`Fonts are ready in ${outputDirectory}`)
