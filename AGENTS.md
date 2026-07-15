# Repository Guidelines

## Project Structure & Module Organization

TFolio is a Tauri 2 desktop application with a React/TypeScript frontend and a
Rust backend.

- `src/`: frontend application code. Put reusable UI in `src/components/`,
  shared helpers in `src/lib/`, and global styles in `src/index.css`.
- `src-tauri/src/`: Rust entry points and native application logic.
- `src-tauri/capabilities/`: Tauri permission definitions.
- `src-tauri/icons/`: desktop and mobile application icons.
- `scripts/`: repository maintenance scripts, including version synchronization.
- `.github/workflows/`: GitHub Actions release automation.
- `dist/`, `node_modules/`, and `src-tauri/target/`: generated output; do not
  commit these directories.

No automated test directories are configured yet. Place frontend tests beside
their modules as `*.test.ts(x)` and Rust unit tests in the relevant source file.

## Build, Test, and Development Commands

- `bun install`: install frontend and Tauri CLI dependencies.
- `bun run tauri:dev`: run the desktop app with Vite hot reload.
- `bun run build`: type-check and create the frontend production build.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`: validate Rust code
  against the committed lockfile.
- `bun run tauri:build`: build the optimized executable without installers.
- `bun run tauri:bundle`: create platform installers.
- `bun run version:check`: verify Bun, Cargo, and Tauri versions agree.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, and no semicolons in TypeScript. Name
React components in PascalCase (`DocumentToolbar.tsx`), hooks with a `use`
prefix, and helpers in camelCase. Keep shadcn-style primitives under
`src/components/ui/`. Run `cargo fmt` for Rust; use snake_case for Rust modules
and functions and PascalCase for types. Follow the existing trailing-comma style.

## Testing Guidelines

There is currently no JavaScript test runner or coverage threshold. At minimum,
run `bun run build`, `bun run version:check`, and the locked Cargo check before a
pull request. New behavior should include focused tests when introducing a test
framework; avoid unrelated snapshot churn.

## Tauri Security Guidelines

Treat PDFs, annotations, metadata, rich text, pasted HTML, and remote content as
untrusted input.

Before merging functionality that renders untrusted content in the WebView,
loads remote resources, or introduces PDF workers, WebAssembly, blob URLs,
asset protocol URLs, or HTML rendering:

- Replace `app.security.csp: null` with a restrictive production CSP.
- Default to `'self'` and add only the specific schemes, hosts, and directives
  required by the feature.
- Do not use wildcard sources, `'unsafe-eval'`, or `'unsafe-inline'` without a
  documented technical requirement.
- Use a separate `devCsp` for Vite HMR instead of weakening the production CSP.
- Keep `object-src` and `frame-src` disabled unless embedding requires them.
- Never render untrusted HTML with `dangerouslySetInnerHTML` without an
  appropriate sanitizer.
- Review CSP and Tauri capabilities together. Grant filesystem, dialog, shell,
  and protocol permissions with the narrowest practical scopes.
- When using `convertFileSrc` or the asset protocol, allow `asset:` and
  `http://asset.localhost` only in the directives that require them.
- When using PDF workers or WebAssembly, allow `blob:` or
  `'wasm-unsafe-eval'` only when confirmed necessary.

Security-related configuration changes must pass `bun run build`,
`bun run tauri:build`, and a manual check for unexpected CSP violations in the
WebView developer console.

## Commit & Pull Request Guidelines

The short history does not establish a commit convention. Prefer concise,
imperative subjects, optionally using Conventional Commit prefixes such as
`feat:`, `fix:`, and `chore:`. Keep each commit scoped to one logical change.

Pull requests should explain the motivation, summarize implementation choices,
list verification commands, and link related issues. Include screenshots or a
short recording for visible UI changes. Do not push a release tag unless its
`vX.Y.Z` value exactly matches `package.json`; use `bun run version:bump patch`
(or `minor`, `major`, or an explicit version) to update version files together.
