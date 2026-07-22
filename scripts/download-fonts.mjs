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
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import subsetFont from "subset-font"

// The commit the fonts are taken from, not a branch: a moving reference would
// change the bytes under the checksums below and break every build at once.
const FONT_COMMIT = "2894aab31764f10f29c421bdfd2340d3b382d384"
const repositoryRoot = resolve(import.meta.dirname, "..")
const outputDirectory = join(repositoryRoot, "src-tauri", "resources", "fonts")

// Every glyph the page-number tool ever draws: the ten digits, an em dash, and
// a space. The em dash alone forces an embedded font, so the whole label rides
// the bundled serif face — see `needs_embedded_font` in `font.rs`.
const PAGE_NUMBER_GLYPHS = "0123456789— "

// Each font pins an exact size and checksum. `subset` — the page-number serif —
// is instanced to Regular and cut to `PAGE_NUMBER_GLYPHS` before it is bundled,
// so a 60 MB variable source becomes a ~20 KB face; `bytes`/`sha256` still guard
// the whole download, not the subset. Fonts without `subset` are bundled whole
// and cut per edit at runtime (see `subset_for`). `host` is `raw` where the
// source is too large for jsDelivr's per-file ceiling.
const fonts = [
  {
    name: "NotoSansSC.ttf",
    source: "ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    host: "jsdelivr",
    bytes: 17772300,
    sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    license: { name: "LICENSE.NotoSansSC", source: "ofl/notosanssc/OFL.txt" },
  },
  {
    name: "NotoSerifSC.ttf",
    source: "ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    host: "raw",
    bytes: 59925648,
    sha256: "03a7bc54364c5702e70e92b6877da74f4f0c5a22362910c66684bcc2dc03d3d1",
    license: { name: "LICENSE.NotoSerifSC", source: "ofl/notoserifsc/OFL.txt" },
    subset: { text: PAGE_NUMBER_GLYPHS, weight: 400 },
  },
]

const versionPath = join(outputDirectory, "VERSION")
// The marker changes if the commit, any font, or any subset spec changes, so
// editing this script never leaves a stale bundle in place.
const cacheMarker = [
  FONT_COMMIT,
  ...fonts.map((font) =>
    font.subset
      ? `${font.name}\tsubset:${font.subset.text}@${font.subset.weight}`
      : font.name,
  ),
].join("\n")

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

    if (font.subset) {
      // Instance the variable source to Regular and keep only the page-number
      // glyphs, so what ships is kilobytes rather than the 60 MB source.
      // `noLayoutClosure` drops the figure/dash alternates the font's GSUB/GPOS
      // tables reach — page numbers apply no OpenType features, so only the
      // dozen cmap glyphs are ever drawn.
      const subset = await subsetFont(Buffer.from(bytes), font.subset.text, {
        targetFormat: "truetype",
        variationAxes: { wght: font.subset.weight },
        noLayoutClosure: true,
      })

      writeFileSync(stagedOutput, subset)
      console.log(`Subset ${font.name} to ${subset.length} bytes`)
    } else {
      renameSync(stagedDownload, stagedOutput)
    }

    await download(contentUrl(font, font.license.source), stagedLicense)

    // Moved into place only once both files are whole, so an interrupted run
    // cannot leave a half-written font that the checksum above would never see
    // again — the cache marker is written last for the same reason.
    renameSync(stagedOutput, join(outputDirectory, font.name))
    renameSync(stagedLicense, join(outputDirectory, font.license.name))
  }

  writeFileSync(versionPath, `${cacheMarker}\n`)
  console.log(`Fonts are ready in ${outputDirectory}`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
