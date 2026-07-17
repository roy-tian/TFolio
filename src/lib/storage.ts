/**
 * Reads `key` back, or null if `guard` rejects it — what is in storage may come
 * from an older version of the app, or a reader with a console open.
 */
export function readStored<Value>(
  key: string,
  guard: (value: unknown) => value is Value,
): Value | null {
  try {
    const stored = window.localStorage.getItem(key)

    return guard(stored) ? stored : null
  } catch {
    // A restricted WebView can disable storage. The active session still works.
    return null
  }
}

export function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A restricted WebView can disable storage. The active session still works.
  }
}
