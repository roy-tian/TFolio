import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const masters = path.join(root, "src/assets/brand")
const output = path.join(root, "src-tauri/icons")
const scratchRoot = path.join(root, "artifacts/icons")
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(path.join(scratchRoot, "generate-"))
process.on("exit", () => rmSync(scratch, { force: true, recursive: true }))
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
mkdirSync(output, { recursive: true })

for (const name of ["app-large", "app-small", "file-large", "file-small", "file-tiny"]) {
  const result = spawnSync(process.execPath, [
    "run", "tauri", "icon", path.join(masters, name + ".png"),
    "--output", path.join(scratch, name),
    ...sizes.flatMap((size) => ["--png", String(size)]),
  ], { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function png(kind, size, scale = 1) {
  const variant = kind === "app"
    ? size <= 64 ? "app-small" : "app-large"
    : size <= 20 ? "file-tiny" : size <= 64 ? "file-small" : "file-large"
  return readFileSync(path.join(scratch, variant, `${size * scale}x${size * scale}.png`))
}

function writeIco(kind, filename) {
  const frames = sizes.filter((size) => size <= 256).map((size) => ({
    size, data: png(kind, size),
  }))
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    header[entry] = header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  writeFileSync(path.join(output, filename), Buffer.concat([header, ...frames.map((f) => f.data)]))
}

function writeIcns(kind, filename) {
  // Retina frames choose artwork by logical size, so 16pt still uses the tiny PDF.
  const formats = [
    ["icp4", 16, 1], ["icp5", 32, 1], ["icp6", 64, 1],
    ["ic07", 128, 1], ["ic08", 256, 1], ["ic09", 512, 1],
    ["ic10", 512, 2], ["ic11", 16, 2], ["ic12", 32, 2],
    ["ic13", 128, 2], ["ic14", 256, 2],
  ]
  const chunks = formats.map(([tag, size, scale]) => {
    const data = png(kind, size, scale)
    const header = Buffer.alloc(8)
    header.write(tag, 0, "ascii")
    header.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([header, data])
  })
  const header = Buffer.alloc(8)
  header.write("icns", 0, "ascii")
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  writeFileSync(path.join(output, filename), Buffer.concat([header, ...chunks]))
}

for (const [size, filename] of [
  [32, "32x32.png"], [64, "64x64.png"], [128, "128x128.png"],
  [256, "128x128@2x.png"], [512, "icon.png"],
]) {
  writeFileSync(path.join(output, filename), png("app", size))
}
writeIco("app", "icon.ico")
writeIcns("app", "icon.icns")
writeIco("file", "pdf.ico")
writeIcns("file", "pdf.icns")

const websiteAssets = path.join(root, "website/assets")
// The website is optional in checkouts; its two brand images share these masters.
if (existsSync(websiteAssets)) {
  copyFileSync(path.join(output, "64x64.png"), path.join(websiteAssets, "icon.png"))
  copyFileSync(path.join(output, "64x64.png"), path.join(websiteAssets, "favicon-64.png"))
}
