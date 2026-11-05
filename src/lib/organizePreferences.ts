import { defaultOrganizeOptions, type OrganizeOptions } from "@/lib/organize"
import { rememberSettings, storedSettings } from "@/lib/settings"

/** The choices a new plan starts from: the reader's last. A watermark and page
    numbers belong to one PDF, so they are never kept. */
export type OrganizePreferences = Pick<
  OrganizeOptions,
  "bookmarks" | "normalizeA4" | "smartPadding"
>

const preferenceNames = ["bookmarks", "normalizeA4", "smartPadding"] as const

/** The file is the reader's to edit: anything not a boolean is the default. */
export function organizePreferencesOf(stored: unknown): OrganizePreferences {
  const section = (typeof stored === "object" && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >

  return Object.fromEntries(
    preferenceNames.map((name) => {
      const value = section[name]

      return [name, typeof value === "boolean" ? value : defaultOrganizeOptions[name]]
    }),
  ) as OrganizePreferences
}

export function storedOrganizePreferences(): OrganizePreferences {
  return organizePreferencesOf(storedSettings().organize)
}

/** Only the choices `options` changes: each write replaces the whole file, and
    another window may have made the others since. */
export function storeOrganizePreferences(options: Partial<OrganizeOptions>) {
  const stored = storedOrganizePreferences()
  const changed = preferenceNames.filter(
    (name) => options[name] !== undefined && options[name] !== stored[name],
  )

  if (changed.length > 0) {
    void rememberSettings({
      organize: Object.fromEntries(changed.map((name) => [name, options[name]])),
    })
  }
}
