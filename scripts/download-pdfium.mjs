import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

// src-tauri/engine/src/pdfium/engine/text_runs.rs replays this build's text
// extraction; read its header before bumping.
const PDFIUM_BUILD = "8125"
const repositoryRoot = resolve(import.meta.dirname, "..")
const outputDirectory = join(
  repositoryRoot,
  "src-tauri",
  "resources",
  "pdfium",
)

function readTargetArgument() {
  const targetIndex = process.argv.indexOf("--target")

  if (targetIndex === -1) {
    return null
  }

  const target = process.argv[targetIndex + 1]

  if (!target) {
    throw new Error("--target requires a Rust target triple")
  }

  return target
}

function platformForTarget(target) {
  if (target?.includes("apple-darwin")) {
    return "darwin"
  }

  if (target?.includes("windows")) {
    return "win32"
  }

  if (target?.includes("linux")) {
    return "linux"
  }

  return process.platform
}

function architectureForTarget(target) {
  if (target?.startsWith("aarch64")) {
    return "arm64"
  }

  if (target?.startsWith("x86_64")) {
    return "x64"
  }

  if (target?.startsWith("i686")) {
    return "ia32"
  }

  return process.arch
}

const target = readTargetArgument()
const platform = platformForTarget(target)
const architecture = architectureForTarget(target)
const packages = {
  darwin: {
    arm64: {
      asset: "pdfium-mac-arm64.tgz",
      library: "libpdfium.dylib",
      sha256: "4939bd935ac83ddc09a3a4f038bc43a19cea1660316a3667f26cb07a070e139d",
    },
    x64: {
      asset: "pdfium-mac-x64.tgz",
      library: "libpdfium.dylib",
      sha256: "8a5193535b80c7215d8932f6647ae5097465b6dba2811602c21e120c2af112b0",
    },
  },
  linux: {
    arm64: {
      asset: "pdfium-linux-arm64.tgz",
      library: "libpdfium.so",
      sha256: "8b8818f2ec57d1b213d952ca6d7f0ffeca9d0110487d0e20ad83ba918bc92efa",
    },
    x64: {
      asset: "pdfium-linux-x64.tgz",
      library: "libpdfium.so",
      sha256: "e1c3ce6e270cb5e0c20816b379ad9f2c1309972697c505f508de92bf5e7d6659",
    },
  },
  win32: {
    arm64: {
      asset: "pdfium-win-arm64.tgz",
      library: "pdfium.dll",
      sha256: "d394ba61991fb53f4d87f70988035f337d9e73f2bd2c3c1b966df8c43fcabb05",
    },
    ia32: {
      asset: "pdfium-win-x86.tgz",
      library: "pdfium.dll",
      sha256: "5aa1eb3e7de0589534245a181cb51def90d1dc76e987aea4be524a8cb3db1069",
    },
    x64: {
      asset: "pdfium-win-x64.tgz",
      library: "pdfium.dll",
      sha256: "9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b",
    },
  },
}
const selectedPackage = packages[platform]?.[architecture]

if (!selectedPackage) {
  throw new Error(
    `PDFium ${PDFIUM_BUILD} is not configured for ${platform}/${architecture}`,
  )
}

const outputPath = join(outputDirectory, selectedPackage.library)
const versionPath = join(outputDirectory, "VERSION")
const cacheMarker = `${PDFIUM_BUILD}\n${selectedPackage.asset}`

if (
  existsSync(outputPath) &&
  existsSync(versionPath) &&
  readFileSync(versionPath, "utf8").trim() === cacheMarker
) {
  console.log(`PDFium ${PDFIUM_BUILD} is ready at ${outputPath}`)
  process.exit(0)
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "tfolio-pdfium-"))
const archivePath = join(temporaryDirectory, selectedPackage.asset)
const extractionDirectory = join(temporaryDirectory, "extracted")
const downloadUrl =
  `https://github.com/bblanchon/pdfium-binaries/releases/download/` +
  `chromium%2F${PDFIUM_BUILD}/${selectedPackage.asset}`

try {
  console.log(`Downloading PDFium ${PDFIUM_BUILD} from ${downloadUrl}`)
  const response = await fetch(downloadUrl)

  if (!response.ok) {
    throw new Error(`PDFium download failed with HTTP ${response.status}`)
  }

  if (!response.body) {
    throw new Error("PDFium download returned an empty response body")
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archivePath),
  )

  const archiveDigest = createHash("sha256")
    .update(new Uint8Array(await Bun.file(archivePath).arrayBuffer()))
    .digest("hex")

  if (archiveDigest !== selectedPackage.sha256) {
    throw new Error(
      `PDFium checksum mismatch: expected ${selectedPackage.sha256}, got ${archiveDigest}`,
    )
  }

  mkdirSync(extractionDirectory)

  const extraction = spawnSync(
    "tar",
    ["-xzf", archivePath, "-C", extractionDirectory],
    { stdio: "inherit" },
  )

  if (extraction.error) {
    throw extraction.error
  }

  if (extraction.status !== 0) {
    throw new Error(`tar exited with status ${extraction.status}`)
  }

  const extractedLibrary = ["lib", "bin", ""]
    .map((directory) =>
      join(extractionDirectory, directory, selectedPackage.library),
    )
    .find(existsSync)

  if (!extractedLibrary) {
    throw new Error(`PDFium archive did not contain ${selectedPackage.library}`)
  }

  mkdirSync(outputDirectory, { recursive: true })
  copyFileSync(extractedLibrary, outputPath)
  writeFileSync(versionPath, `${cacheMarker}\n`)

  const licensePath = join(extractionDirectory, "LICENSE")

  if (existsSync(licensePath)) {
    copyFileSync(licensePath, join(outputDirectory, "LICENSE.pdfium"))
  }

  console.log(`PDFium ${PDFIUM_BUILD} is ready at ${outputPath}`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
