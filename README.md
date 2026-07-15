# TFolio

TFolio is a PDF editor by Roy Tian, built with Rust, Tauri 2, React, and shadcn/ui.

## Development

```powershell
bun install
bun run tauri:dev
```

## Internationalization

The UI currently supports Simplified Chinese (`zh-CN`) and English (`en`). The
app uses the saved preference first, then the operating-system language, and
falls back to Simplified Chinese. Language resources live in
`src/i18n/locales/`; English defines the typed translation-key schema, so other
locales are checked for missing or misspelled keys at build time.

Use `useTranslation()` in React components instead of hard-coding user-facing
text. Add supported locales in `src/i18n/config.ts` and expose language controls
only when the product UI calls for them.

Run the focused locale-selection tests with `bun run test`.

## Build the executable

```powershell
bun run tauri:build
```

The executable is written to `src-tauri/target/release/tfolio.exe` on Windows.

## Build installers

```powershell
bun run tauri:bundle
```

## Versioning

`package.json` is the source of truth for the application version. Tauri reads it
directly, while the version command keeps `bun.lock`, `Cargo.toml`, and
`Cargo.lock` in sync.

Use a semantic version or an increment name:

```powershell
bun run version:bump patch
bun run version:bump minor
bun run version:bump major
bun run version:bump 1.2.3
```

Review the changed files and verify them before committing:

```powershell
bun run version:check
```

## GitHub Release

The release workflow builds installers for Windows x64, Linux x64, macOS Intel,
and macOS Apple Silicon. A pushed `vX.Y.Z` tag creates a GitHub Release, generates
release notes, and uploads all platform bundles. Pre-release SemVer tags such as
`v1.2.3-rc.1` are published as GitHub pre-releases.

Create a release from the commit that contains the matching version change:

```powershell
bun run version:bump patch
git add package.json bun.lock src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin HEAD
git push origin v0.1.1
```

The tag and `package.json` version must match exactly. For example, tag `v0.1.1`
must point to a commit whose package version is `0.1.1`; the workflow rejects a
mismatch before creating release assets.

## License

TFolio is available under the [MIT License](LICENSE).
