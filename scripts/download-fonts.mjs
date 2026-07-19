import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

// The commit the font is taken from, not a branch: a moving reference would
// change the bytes under the checksum below and break every build at once.
const FONT_COMMIT = "2894aab31764f10f29c421bdfd2340d3b382d384"
const repositoryRoot = resolve(import.meta.dirname, "..")
const outputDirectory = join(repositoryRoot, "src-tauri", "resources", "fonts")

// Noto Sans SC carries the CJK glyphs the text-note tool subsets per note.
// SIL Open Font License 1.1, which allows bundling as long as the licence
// travels with it — hence `license` below.
const font = {
  name: "NotoSansSC.ttf",
  source: "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
  bytes: 17772300,
  sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
  license: { name: "LICENSE.NotoSansSC", source: "ofl/notosanssc/OFL.txt" },
}

const outputPath = join(outputDirectory, font.name)
const versionPath = join(outputDirectory, "VERSION")
const cacheMarker = `${FONT_COMMIT}\n${font.name}`

if (
  existsSync(outputPath) &&
  existsSync(versionPath) &&
  readFileSync(versionPath, "utf8").trim() === cacheMarker
) {
  console.log(`Noto Sans SC is ready at ${outputPath}`)
  process.exit(0)
}

// jsDelivr rather than raw.githubusercontent: it serves a commit-pinned path
// from a CDN, so a 17 MB fetch does not lean on one host.
const downloadUrl = (path) =>
  `https://cdn.jsdelivr.net/gh/google/fonts@${FONT_COMMIT}/${path}`

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

const temporaryDirectory = mkdtempSync(join(tmpdir(), "tfolio-fonts-"))
const stagedFont = join(temporaryDirectory, font.name)
const stagedLicense = join(temporaryDirectory, font.license.name)

try {
  console.log(`Downloading ${font.name} from google/fonts@${FONT_COMMIT}`)
  await download(downloadUrl(font.source), stagedFont)

  const bytes = new Uint8Array(await Bun.file(stagedFont).arrayBuffer())

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

  await download(downloadUrl(font.license.source), stagedLicense)

  mkdirSync(outputDirectory, { recursive: true })
  // Moved into place only once both files are whole, so an interrupted download
  // cannot leave a half-written font that the checksum above would never see
  // again — the cache marker is written last for the same reason.
  renameSync(stagedFont, outputPath)
  renameSync(stagedLicense, join(outputDirectory, font.license.name))
  writeFileSync(versionPath, `${cacheMarker}\n`)

  console.log(`Noto Sans SC is ready at ${outputPath}`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
