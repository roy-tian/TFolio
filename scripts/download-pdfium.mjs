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

const PDFIUM_BUILD = "7881"
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
      sha256: "52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40",
    },
    x64: {
      asset: "pdfium-mac-x64.tgz",
      library: "libpdfium.dylib",
      sha256: "6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b",
    },
  },
  linux: {
    arm64: {
      asset: "pdfium-linux-arm64.tgz",
      library: "libpdfium.so",
      sha256: "ee7f7b7d5468958336a818c1cd580bdd20972846b7377b13f9a923d92d1d4674",
    },
    x64: {
      asset: "pdfium-linux-x64.tgz",
      library: "libpdfium.so",
      sha256: "1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d",
    },
  },
  win32: {
    arm64: {
      asset: "pdfium-win-arm64.tgz",
      library: "pdfium.dll",
      sha256: "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84",
    },
    ia32: {
      asset: "pdfium-win-x86.tgz",
      library: "pdfium.dll",
      sha256: "cf02980c66a93eef007cfff861fe79d291f3c3dcd43258abf6e3099b682e7ec6",
    },
    x64: {
      asset: "pdfium-win-x64.tgz",
      library: "pdfium.dll",
      sha256: "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08",
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
