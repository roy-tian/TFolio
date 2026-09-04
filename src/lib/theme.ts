import { useSyncExternalStore } from "react"

import { rememberSettings, storedSettings } from "@/lib/settings"

export const themePreferences = ["light", "system", "dark"] as const

export type ThemePreference = (typeof themePreferences)[number]

export type ResolvedTheme = "light" | "dark"

export const defaultThemePreference: ThemePreference = "system"

const darkModeQuery = "(prefers-color-scheme: dark)"

let preference: ThemePreference = defaultThemePreference
const listeners = new Set<() => void>()

function isThemePreference(value: unknown): value is ThemePreference {
  return themePreferences.includes(value as ThemePreference)
}

function storedPreference(): ThemePreference | null {
  const stored = storedSettings().ui?.theme

  return isThemePreference(stored) ? stored : null
}

function systemPrefersDark(): boolean {
  return window.matchMedia(darkModeQuery).matches
}

export function resolveTheme(themePreference: ThemePreference): ResolvedTheme {
  if (themePreference === "system") {
    return systemPrefersDark() ? "dark" : "light"
  }

  return themePreference
}

function applyResolvedTheme(themePreference: ThemePreference) {
  const resolved = resolveTheme(themePreference)
  const root = document.documentElement

  root.classList.toggle("dark", resolved === "dark")
  root.style.colorScheme = resolved
}

export function initializeTheme() {
  preference = storedPreference() ?? defaultThemePreference
  applyResolvedTheme(preference)

  window.matchMedia(darkModeQuery).addEventListener("change", () => {
    if (preference === "system") {
      applyResolvedTheme(preference)
    }
  })
}

export function getThemePreference(): ThemePreference {
  return preference
}

export function setThemePreference(next: ThemePreference) {
  preference = next

  rememberSettings({ ui: { theme: next } })
  applyResolvedTheme(next)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, getThemePreference)
}
