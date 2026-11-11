import { ChevronDown, SlidersHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"

import { SidebarPanelTools } from "@/components/SidebarPanelTools"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePagesDrop } from "@/hooks/usePagesDrop"
import type { FileOptions } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type PagesBarProps = {
  /** How the document's files are laid out and saved; absent with one file. */
  fileOptions: FileOptions | undefined
  /** Whether each file of a document of several starts a row of its own. */
  fileRows: boolean
  /** How many of the files are folded to their names, of how many. */
  folded: { count: number; of: number }
  onFileOptionsChange: (change: Partial<FileOptions>) => void
  onFileRowsChange: (fileRows: boolean) => void
  /** Every file's pages folded away under its name, or shown again. */
  onFoldAll: (folded: boolean) => void
  severalFiles: boolean
}

/** The bar over a document's pages in the sidebar: how its files are laid
    out and saved, once it has several, then the panel's own tools. While a
    file drag offers the pages it says what a drop there does instead. */
export function PagesBar({
  fileOptions,
  fileRows,
  folded,
  onFileOptionsChange,
  onFileRowsChange,
  onFoldAll,
  severalFiles,
}: PagesBarProps) {
  const { t } = useTranslation()
  const drop = usePagesDrop()

  return (
    <div className="relative flex h-9 shrink-0 border-b px-2" data-slot="pages-bar">
      {drop ? (
        <p
          className={cn(
            "pointer-events-none absolute inset-0 grid place-items-center px-2 text-xs font-medium",
            drop === "over" ? "text-foreground" : "text-muted-foreground",
          )}
          data-slot="pages-drop-hint"
        >
          <span className="max-w-full truncate">{t("sidebar.dropFiles")}</span>
        </p>
      ) : null}
      {/* Hidden, not unmounted, under the drag's words: an open menu would
          lose the trigger it stands by. */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-1", drop && "invisible")}>
        {/* In words, not icons: two of these change what a Save As writes,
            which no glyph says, and they stand apart from the one that only
            changes how the pages are laid out here. */}
        {severalFiles || fileOptions ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="min-w-0 shrink"
                  data-slot="pages-file-options"
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <SlidersHorizontal />
              <span className="truncate">{t("sidebar.fileOptions")}</span>
              <ChevronDown className="size-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-auto max-w-96 min-w-56">
              {severalFiles ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("sidebar.optionsView")}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={fileRows}
                    data-action="file-rows"
                    onCheckedChange={onFileRowsChange}
                  >
                    {t("sidebar.fileRows")}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
              ) : null}
              {severalFiles && fileOptions ? <DropdownMenuSeparator /> : null}
              {fileOptions ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("sidebar.optionsSave")}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={fileOptions.smartPadding}
                    data-action="smart-padding"
                    onCheckedChange={(smartPadding) => onFileOptionsChange({ smartPadding })}
                  >
                    {t("sidebar.smartPadding")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={fileOptions.perFileBookmarks}
                    data-action="file-bookmarks"
                    onCheckedChange={(perFileBookmarks) =>
                      onFileOptionsChange({ perFileBookmarks })
                    }
                  >
                    {t("sidebar.fileBookmarks")}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <SidebarPanelTools
          fold={{
            // Only a file under its own name has pages to fold away.
            canFold: severalFiles && fileRows && folded.count < folded.of,
            canUnfold: severalFiles && fileRows && folded.count > 0,
            foldLabel: t("sidebar.foldAll"),
            onFold: onFoldAll,
            unfoldLabel: t("sidebar.unfoldAll"),
          }}
        />
      </div>
    </div>
  )
}
