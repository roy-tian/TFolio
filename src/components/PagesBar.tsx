import { RotateCcw, RotateCw, Settings, Trash2, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { SidebarDropHint } from "@/components/SidebarFileDrop"
import { SidebarPanelTools } from "@/components/SidebarPanelTools"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
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
import { useSidebarDrop } from "@/hooks/useSidebarDrop"
import type { FileOptions } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type PagesBarProps = {
  /** How the document's files are laid out and saved; absent with one file. */
  fileOptions: FileOptions | undefined
  /** Whether each file of a document of several starts a row of its own. */
  fileRows: boolean
  /** How many of the files are folded to their names, of how many. */
  folded: { count: number; of: number }
  onDelete: () => void
  onFileOptionsChange: (change: Partial<FileOptions>) => void
  onFileRowsChange: (fileRows: boolean) => void
  /** Every file's pages folded away under its name, or shown again. */
  onFoldAll: (folded: boolean) => void
  onRotate: (degrees: 90 | 270) => void
  severalFiles: boolean
  /** The pages its buttons act on, the chosen ones or else the page being
      read: how many, the first of them, and of how many in the document. */
  targets: { count: number; first: number; of: number }
}

/** The bar over a document's pages in the sidebar: turning and removing the
    chosen pages, or the page being read, then the files' own tools. While a
    file drag offers the pages it says what a drop there does instead. */
export function PagesBar({
  fileOptions,
  fileRows,
  folded,
  onDelete,
  onFileOptionsChange,
  onFileRowsChange,
  onFoldAll,
  onRotate,
  severalFiles,
  targets,
}: PagesBarProps) {
  const { t } = useTranslation()
  const drop = useSidebarDrop()
  // One page by its number, so the reader knows which: it may be the page
  // being read rather than one chosen in the sidebar.
  const one = targets.count === 1 ? { pageNumber: targets.first } : null
  const { count } = targets
  // Laid out and saved file by file only once there are several files.
  const fileTools = severalFiles || fileOptions !== undefined
  const filesLabel = fileTools ? t("sidebar.fileOptions") : t("sidebar.fileOptionsOneFile")
  const pageActions: {
    disabled?: boolean
    icon: LucideIcon
    label: string
    onClick: () => void
    slot: string
  }[] = [
    {
      icon: RotateCcw,
      label: one ? t("pageEdit.rotatePageLeft", one) : t("pageEdit.rotateLeft", { count }),
      onClick: () => onRotate(270),
      slot: "pages-rotate-left",
    },
    {
      icon: RotateCw,
      label: one ? t("pageEdit.rotatePageRight", one) : t("pageEdit.rotateRight", { count }),
      onClick: () => onRotate(90),
      slot: "pages-rotate-right",
    },
    {
      // A document keeps one page; the backend refuses a delete of them all.
      disabled: count >= targets.of,
      icon: Trash2,
      label: one ? t("pageEdit.deletePage", one) : t("pageEdit.delete", { count }),
      onClick: onDelete,
      slot: "pages-delete",
    },
  ]

  return (
    <div className="relative flex h-9 shrink-0 border-b px-2" data-slot="pages-bar">
      <SidebarDropHint label={t("sidebar.dropFiles")} />
      {/* Hidden, not unmounted, under the drag's words: an open menu would
          lose the trigger it stands by. */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", drop && "invisible")}>
        {pageActions.map(({ disabled, icon: Icon, label, onClick, slot }) => (
          <ToolbarTooltip key={slot} label={label}>
            <Button
              aria-label={label}
              // Dimmed, not disabled, while an edit runs, which a press would
              // only be refused behind: a disabled button gives up its focus.
              className={cn(
                "in-data-[pages-busy]:cursor-wait in-data-[pages-busy]:opacity-50",
                slot === "pages-delete" && "hover:text-destructive",
              )}
              data-slot={slot}
              disabled={disabled}
              onClick={onClick}
              size="icon-sm"
              variant="ghost"
            >
              <Icon />
            </Button>
          </ToolbarTooltip>
        ))}
        <SidebarPanelTools
          fold={{
            // Only a file under its own name has pages to fold away.
            canFold: severalFiles && fileRows && folded.count < folded.of,
            canUnfold: severalFiles && fileRows && folded.count > 0,
            foldLabel: t("sidebar.foldAll"),
            onFold: onFoldAll,
            unfoldLabel: t("sidebar.unfoldAll"),
          }}
        >
          <DropdownMenu>
            <ToolbarTooltip label={filesLabel}>
              <DropdownMenuTrigger
                disabled={!fileTools}
                render={
                  <Button
                    aria-label={filesLabel}
                    data-slot="pages-file-options"
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <Settings />
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="end" className="w-auto max-w-96 min-w-56">
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
        </SidebarPanelTools>
      </div>
    </div>
  )
}
