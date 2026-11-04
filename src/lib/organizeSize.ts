import { rememberSettings, storedSettings } from "@/lib/settings"

/** The thumbnails' long side, smallest to largest; the status bar steps along. */
export const ORGANIZE_PAPER_WIDTHS = [120, 160, 200, 240] as const

const DEFAULT_ORGANIZE_STEP = 1

/** The file holds the long side in pixels, not the step: if the steps ever
    change, an old choice then falls back instead of becoming another size. */
export function organizeStepOf(stored: unknown): number {
  const step = ORGANIZE_PAPER_WIDTHS.findIndex((width) => width === stored)

  return step < 0 ? DEFAULT_ORGANIZE_STEP : step
}

export function readStoredOrganizeStep(): number {
  return organizeStepOf(storedSettings().ui?.organizeThumbnailSize)
}

/** Each write replaces the whole file, so a release on the size already
    stored (a thumb pressed without moving) writes nothing. */
export function storeOrganizeStep(step: number) {
  const width = ORGANIZE_PAPER_WIDTHS[step]

  if (storedSettings().ui?.organizeThumbnailSize !== width) {
    void rememberSettings({ ui: { organizeThumbnailSize: width } })
  }
}
