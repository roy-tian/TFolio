import { useEffect, useState } from "react"
import { Copy, Minus, Square, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { cn } from "@/lib/utils"

export function WindowControls() {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let cancelled = false
    let syncTimer: ReturnType<typeof setTimeout> | undefined
    let unlisten: (() => void) | undefined

    const syncMaximized = async () => {
      const next = await appWindow.isMaximized()

      if (!cancelled) {
        setMaximized(next)
      }
    }
    const scheduleSync = () => {
      clearTimeout(syncTimer)
      syncTimer = setTimeout(() => {
        void syncMaximized()
      }, 100)
    }

    void syncMaximized()
    void appWindow
      .onResized(scheduleSync)
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unlisten = stop
        }
      })

    return () => {
      cancelled = true
      clearTimeout(syncTimer)
      unlisten?.()
    }
  }, [])

  const maximizeLabel = maximized
    ? t("window.restore")
    : t("window.maximize")

  return (
    <div
      className="-my-px -mr-2 flex h-12 items-stretch"
      data-slot="window-controls"
    >
      <button
        aria-label={t("window.minimize")}
        className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => void getCurrentWindow().minimize()}
        title={t("window.minimize")}
        type="button"
      >
        <Minus className="size-4" />
      </button>
      <button
        aria-label={maximizeLabel}
        className="grid w-11 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => void getCurrentWindow().toggleMaximize()}
        title={maximizeLabel}
        type="button"
      >
        {maximized ? (
          <Copy className="size-3.5" />
        ) : (
          <Square className="size-3.5" />
        )}
      </button>
      <button
        aria-label={t("window.close")}
        className={cn(
          "grid w-11 place-items-center text-muted-foreground transition-colors",
          "hover:bg-red-600 hover:text-white focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
        )}
        // `close`, unlike `destroy`, emits close-requested so App's dirty-document
        // guard can stop the close and ask for confirmation.
        onClick={() => void getCurrentWindow().close()}
        title={t("window.close")}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
