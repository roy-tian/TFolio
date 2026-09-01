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

// One bundled face, for text a PDF's own standard fonts cannot draw — notes and
// watermarks that leave Latin-1. It is bundled whole and cut per edit at runtime
// (see `subset_for`). Page numbers take no bundled font at all: `font.rs`
// resolves a 宋体 or another serif from the system the app is running on.
//
// Each font pins an exact size and checksum, and `host` is `raw` where a source
// is too large for jsDelivr's per-file ceiling.
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

// jsDelivr serves a commit-pinned path from a CDN, so an ordinary fetch does not
// lean on one host; a source past its per-file ceiling falls back to GitHub's
// own raw host, which has no such limit.
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

// Keep staging beside the final files: Windows runners put the OS temp folder
// on C: and the checked-out repository on D:, where renameSync() cannot move a
// file across volumes. A sibling directory preserves the atomic final rename.
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
    // cannot leave a half-written font that the checksum above would never see
    // again — the cache marker is written last for the same reason.
    renameSync(stagedOutput, join(outputDirectory, font.name))
    renameSync(stagedLicense, join(outputDirectory, font.license.name))
  }

  writeFileSync(versionPath, `${cacheMarker}\n`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}

// The whole directory is bundled into the app, so a face this script no longer
// manages — one dropped from the list above — must not be left behind for the
// installer to ship. Only ever after the staging directory has gone.
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
