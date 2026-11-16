import { Pencil, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { Button } from "@/components/ui/button"

/** A file's row under its name, the same over the pages and in the outline.
    The row sets a property because the count is no child of the buttons that
    take its place (see `PAPER_CONTROLS_HOST`); the keyboard's focus sets it
    too, from inside the buttons alone: WebKitGTK can keep a clicked name
    `:focus-visible`, and its row would stay lit. */
export const FILE_ROW_CLASS =
  "relative flex items-center gap-1 rounded-md pr-1 [--row-tools:0] hover:bg-sidebar-accent hover:[--row-tools:1] has-[[data-file-row-tools]_:focus-visible]:bg-sidebar-accent has-[[data-file-row-tools]_:focus-visible]:[--row-tools:1]"

/** The pressable name: as wide as the row lets it, its count at the end. */
export const FILE_ROW_NAME_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"

/** How many pages the file has, flush right, fading out under the tools. No
    narrower than the buttons that stand over it, so they cover no part of a
    long name. */
export function FileRowCount({ count, slot }: { count: number; slot: string }) {
  const { t } = useTranslation()

  return (
    <span
      className="ml-auto min-w-13 shrink-0 text-right text-xs font-normal text-muted-foreground tabular-nums opacity-[calc(1_-_var(--row-tools))]"
      data-slot={slot}
    >
      {t("sidebar.filePages", { count })}
    </span>
  )
}

/** Rename and remove, over the count, in its place while the row shows them. */
export function FileRowTools({
  name,
  onRemove,
  onRename,
  removeDisabled,
  slot,
}: {
  name: string
  onRemove: () => void
  onRename: () => void
  removeDisabled: boolean
  /** Names the parts: `<slot>-tools`, `<slot>-rename` and `<slot>-remove`. */
  slot: string
}) {
  const { t } = useTranslation()
  const renameLabel = t("sidebar.renameFile", { name })
  const removeLabel = t("sidebar.removeFile", { name })

  return (
    <div
      className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-(--row-tools)"
      data-file-row-tools
      data-slot={`${slot}-tools`}
    >
      <HintTooltip label={renameLabel}>
        <Button
          aria-label={renameLabel}
          data-slot={`${slot}-rename`}
          onClick={onRename}
          size="icon-xs"
          variant="ghost"
        >
          <Pencil />
        </Button>
      </HintTooltip>
      {/* Greyed, it says why: the file is the document's last. */}
      <HintTooltip label={removeDisabled ? t("sidebar.lastFile") : removeLabel}>
        <Button
          aria-label={removeLabel}
          className="not-disabled:hover:text-destructive"
          data-slot={`${slot}-remove`}
          disabled={removeDisabled}
          onClick={onRemove}
          size="icon-xs"
          variant="ghost"
        >
          <X />
        </Button>
      </HintTooltip>
    </div>
  )
}
