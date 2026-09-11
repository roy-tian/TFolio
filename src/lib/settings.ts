import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/**
 * The one place the app's settings are read and written.
 *
 * They live in `settings.toml`, which `src-tauri/src/settings.rs` keeps in the
 * user's app data directory — not in this WebView's storage, which is per
 * install and goes with a cleared cache. The whole file is loaded once, before
 * anything renders, so every reader below is a plain synchronous lookup; the
 * loaded copy is kept current on the way out, so it never falls behind the
 * file.
 *
 * Values arrive as `unknown` on purpose. The file is the reader's to edit, and
 * may have been written by an older version of the app, so each setting earns
 * its way back in through the guard that belongs to the feature it is for —
 * which is also the guard that knows the palette or the slider range it has to
 * sit in. This module knows the shape of the file and nothing about what the
 * values mean.
 */
export type Settings = {
  ui?: { theme?: unknown; language?: unknown; viewMode?: unknown }
  annotate?: { highlightColor?: unknown; rect?: unknown; textNote?: unknown }
  watermark?: unknown
  pageNumbers?: unknown
  import?: { wordConversion?: unknown }
}

/** Whether the import wizard may drive the machine's own office suites to
    convert Word documents. Absent is yes: that is this version's default,
    and the setting is the reader's way of opting out. */
export function wordConversionEnabled(): boolean {
  const stored = storedSettings().import?.wordConversion

  return typeof stored === "boolean" ? stored : true
}

let current: Settings = {}
/** Whether the backend has actually answered. Until it has, this module holds
    defaults rather than the reader's settings, and writing those back would be
    writing over the file with a copy of nothing. */
let loaded = false

/** Reads the file. Called once, before the first render, so that the theme and
    the language are settled before anything is painted in them. */
export async function loadSettings() {
  loaded = false

  try {
    const stored: unknown = await invoke("settings")

    current = isSettings(stored) ? stored : {}
    loaded = true
  } catch {
    // A restricted or half-started backend leaves the app on its defaults,
    // which is every control's own fallback. The session still works.
  }

  await adoptReplacedSettings()
}

export function storedSettings(): Settings {
  return current
}

const SETTINGS_CHANGED_EVENT = "settings://changed"

// Every subscriber that renders a setting, woken by each snapshot swap.
const listeners = new Set<() => void>()

/** Subscribes to the loaded snapshot's changes — a local remember, or another
    window's write arriving — with the unsubscribe function React's
    `useSyncExternalStore` asks for. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

function announce() {
  listeners.forEach((listener) => listener())
}

// Writes replace the whole document, so other windows must update this snapshot first.
export function watchSettings() {
  void listen<unknown>(SETTINGS_CHANGED_EVENT, (event) => {
    // Pending local edits must not be replaced by an incoming snapshot.
    if (loaded && unacknowledged === 0 && isSettings(event.payload)) {
      current = event.payload
      announce()
    }
  }).catch(() => undefined)
}

/**
 * Folds `patch` into the settings and writes them out. Sections merge by field,
 * so a caller names only what it changed; a field's value is replaced whole,
 * because a style is a style and half of one is not.
 *
 * Resolves to whether the file now holds them. Only the migration below has to
 * wait for that; everywhere else remembering a setting is a convenience, and
 * no failure to record one may fail the gesture that earned it.
 */
export function rememberSettings(patch: Settings): Promise<boolean> {
  if (!loaded) {
    return Promise.resolve(false)
  }

  current = merged(current, patch)
  announce()

  return persist()
}

/** One write at a time. Each carries the settings as they stand when it goes
    out, so two changes in the same tick would otherwise race to the file and
    could leave the older of the two there. */
let writing: Promise<unknown> = Promise.resolve()

// A counter is needed because several local writes can be queued at once.
let unacknowledged = 0

function persist(): Promise<boolean> {
  unacknowledged += 1

  const written = writing.then(async () => {
    try {
      // The whole document, not the patch: this copy is the current one, and a
      // setting missing from it is one the reader cleared — which no merge on
      // the far side could tell from one this call simply did not mention.
      await invoke("set_settings", { settings: current })

      return true
    } catch {
      return false
    } finally {
      unacknowledged -= 1
    }
  })

  writing = written

  return written
}

function isSettings(value: unknown): value is Settings {
  return typeof value === "object" && value !== null
}

function merged(base: Settings, patch: Settings): Settings {
  return {
    ...base,
    ...patch,
    ui: mergedSection(base.ui, patch.ui),
    annotate: mergedSection(base.annotate, patch.annotate),
    import: mergedSection(base.import, patch.import),
  }
}

/** Absent stays absent, so an untouched section never reaches the file as an
    empty one. */
function mergedSection<Section extends object>(
  base: Section | undefined,
  patch: Section | undefined,
): Section | undefined {
  return base && patch ? { ...base, ...patch } : (patch ?? base)
}

/**
 * What 0.1.3 and earlier kept in this WebView's own storage, read once into the
 * file and then dropped — a setting the reader chose before the move is still
 * theirs, and a cleared cache no longer takes it with it. The file wins
 * wherever both hold something, being the later of the two.
 *
 * This whole section goes once no install can still be carrying those keys.
 */
async function adoptReplacedSettings() {
  // Nothing was read, so nothing can be written; the keys keep until a run that
  // can actually move them.
  if (!loaded) {
    return
  }

  const replaced = replacedSettings()

  if (!replaced) {
    forgetReplacedKeys()

    return
  }

  current = merged(replaced, current)

  // Dropped only once the file actually holds them: these keys are the last
  // copy of what they carry, so a run that cannot write them down must not be
  // the run that clears them. They keep until one can.
  if (await persist()) {
    forgetReplacedKeys()
  }
}

function replacedSettings(): Settings | undefined {
  return present({
    ui: present({
      theme: replacedText("tfolio.ui.theme"),
      language: replacedText("tfolio.ui.language"),
      viewMode: replacedText("tfolio.ui.viewMode"),
    }),
    annotate: present({
      highlightColor: replacedText("tfolio.annotate.highlightColor"),
      rect: replacedJson("tfolio.annotate.rectStyle"),
      textNote: replacedJson("tfolio.annotate.textNoteStyle"),
    }),
    watermark: replacedJson("tfolio.watermark.settings"),
  })
}

/** The entries that are actually there, or nothing at all if none of them is. */
function present<Shape extends object>(entries: Shape): Shape | undefined {
  const kept = Object.entries(entries).filter(([, value]) => value !== undefined)

  return kept.length > 0 ? (Object.fromEntries(kept) as Shape) : undefined
}

function replacedText(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined
  } catch {
    // A restricted WebView can disable storage; then there is nothing to move.
    return undefined
  }
}

function replacedJson(key: string): unknown {
  const raw = replacedText(key)

  if (raw === undefined) {
    return undefined
  }

  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * Clears every key this app has ever kept there, not only the seven read above:
 * older schemas left their own, and "the app stores nothing in the WebView" is
 * a rule worth being able to check rather than a list to keep up to date.
 */
function forgetReplacedKeys() {
  try {
    const storage = window.localStorage

    // Backwards: removing a key renumbers the ones after it.
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)

      if (key?.startsWith("tfolio.")) {
        storage.removeItem(key)
      }
    }
  } catch {
    // As above: a restricted WebView has nothing there to remove.
  }
}
