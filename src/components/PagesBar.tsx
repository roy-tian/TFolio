import { useRef } from "react"
import { ChevronDown, FileStack, SlidersHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
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
import type { FileOptions } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type PagesBarProps = {
  /** How the document's files are laid out and saved; absent with one file. */
  fileOptions: FileOptions | undefined
  /** Whether each file of a document of several starts a row of its own. */
  fileRows: boolean
  /** Across the main area, over the workspace's own ground. */
  grid: boolean
  onAddFiles: () => void
  onFileOptionsChange: (change: Partial<FileOptions>) => void
  onFileRowsChange: (fileRows: boolean) => void
  severalFiles: boolean
}

/** The bar over a document's pages, down the sidebar or across the grid:
    how its files are laid out and saved, once it has several, and the way
    to add more. */
export function PagesBar({
  fileOptions,
  fileRows,
  grid,
  onAddFiles,
  onFileOptionsChange,
  onFileRowsChange,
  severalFiles,
}: PagesBarProps) {
  const { t } = useTranslation()
  const addFilesRef = useRef<HTMLSpanElement>(null)

  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b px-2",
        grid && "bg-background",
      )}
      data-slot="pages-bar"
    >
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
      {/* Down a narrow sidebar a long language's words are cut short: the
          hint then says them whole. */}
      <HintTooltip cutShort={addFilesRef} label={t("sidebar.addFiles")}>
        <Button
          className="ml-auto min-w-0 shrink"
          data-slot="pages-add-files"
          onClick={onAddFiles}
          size="sm"
          variant="ghost"
        >
          <FileStack />
          <span className="truncate" ref={addFilesRef}>
            {t("sidebar.addFiles")}
          </span>
        </Button>
      </HintTooltip>
    </div>
  )
}
