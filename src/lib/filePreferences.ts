import { rememberSettings, storedSettings } from "@/lib/settings"

/** How the next document files are added to lays them out and saves them:
    the reader's last choices. Kept in the settings file's `organize` section,
    the name it had when another workspace made the same choices. */
export type FilePreferences = {
  bookmarks: boolean
  smartPadding: boolean
}

const defaultFilePreferences: FilePreferences = { bookmarks: true, smartPadding: true }

const preferenceNames = ["bookmarks", "smartPadding"] as const

/** The file is the reader's to edit: anything not a boolean is the default. */
export function filePreferencesOf(stored: unknown): FilePreferences {
  const section = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >

  return Object.fromEntries(
    preferenceNames.map((name) => {
      const value = section[name]

      return [name, typeof value === "boolean" ? value : defaultFilePreferences[name]]
    }),
  ) as FilePreferences
}

export function storedFilePreferences(): FilePreferences {
  return filePreferencesOf(storedSettings().organize)
}

/** Only the choices `changes` names: each write replaces the whole file, and
    another window may have made the others since. */
export function storeFilePreferences(changes: Partial<FilePreferences>) {
  const stored = storedFilePreferences()
  const changed = preferenceNames.filter(
    (name) => changes[name] !== undefined && changes[name] !== stored[name],
  )

  if (changed.length > 0) {
    void rememberSettings({
      organize: Object.fromEntries(changed.map((name) => [name, changes[name]])),
    })
  }
}
