const UNITS = ["B", "KiB", "MiB", "GiB"] as const

/** Binary units, matching the app's MiB size ceiling's wording. Whole bytes
    below one KiB; one fraction digit above, none once the value is wide. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const fraction = unit === 0 || value >= 100 ? 0 : 1

  return `${value.toFixed(fraction)} ${UNITS[unit]}`
}
