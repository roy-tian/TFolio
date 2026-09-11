import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/** Lives in `settings.toml` in app data, never WebView storage. Values stay
    `unknown`: the reader may edit the file, so each feature's guard validates. */
export type Settings = {
  ui?: { theme?: unknown; language?: unknown; viewMode?: unknown }
  annotate?: { highlightColor?: unknown; rect?: unknown; textNote?: unknown }
  watermark?: unknown
  pageNumbers?: unknown
  import?: { wordConversion?: unknown }
}

/** Whether Word imports may drive the machine's own office suites. Absent is
    yes: the setting is the reader's way of opting out. */
export function wordConversionEnabled(): boolean {
  const stored = storedSettings().import?.wordConversion

  return typeof stored === "boolean" ? stored : true
}

let current: Settings = {}
/** Until the backend has answered, writing these defaults back would write
    over the reader's file with a copy of nothing. */
let loaded = false

/** Called once, before the first render, so the theme and the language are
    settled before anything is painted in them. */
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

const listeners = new Set<() => void>()

/** Woken by a local remember or another window's write; returns the
    unsubscribe function React's `useSyncExternalStore` asks for. */
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

/** Resolves to whether the file now holds them; only the migration waits
    on that, and no failure to record one may fail the gesture that earned it. */
export function rememberSettings(patch: Settings): Promise<boolean> {
  if (!loaded) {
    return Promise.resolve(false)
  }

  current = merged(current, patch)
  announce()

  return persist()
}

/** One write at a time: two changes in the same tick would race to the file
    and could leave the older of the two there. */
let writing: Promise<unknown> = Promise.resolve()

// A counter is needed because several local writes can be queued at once.
let unacknowledged = 0

function persist(): Promise<boolean> {
  unacknowledged += 1

  const written = writing.then(async () => {
    try {
      // The whole document, not the patch: a setting missing here is one the
      // reader cleared, which no far-side merge could tell from one unsent.
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

/** What 0.1.3 and earlier kept in WebView storage, folded into the file once
    and then dropped; this section goes once no install still carries the keys. */
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

  // Dropped only once the file holds them: these keys are the last copy of
  // what they carry, so a run that cannot write them must not clear them.
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

/** Clears every key this app ever kept there, not only the ones read above:
    older schemas left their own, and "nothing in the WebView" stays checkable. */
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
