import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { TooltipProvider } from "@/components/ui/tooltip"
import App from "./App"
import { initializeI18n } from "./i18n"
import { suppressNativeContextMenu } from "./lib/contextMenu"
import { loadSettings, watchSettings } from "./lib/settings"
import { initializeTheme } from "./lib/theme"
import { loadWordConversionAvailability } from "./lib/wordConversion"
import "./index.css"

async function bootstrap() {
  // Before anything else: the theme and the language are settings, and both
  // have to be settled before the first paint is made in them.
  await loadSettings()
  watchSettings()
  // The wizard's Word promise is the machine's own answer; it too is settled
  // before the first window can act on it.
  await loadWordConversionAvailability()
  initializeTheme()
  suppressNativeContextMenu()

  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin")
  }

  await initializeI18n()

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </StrictMode>,
  )
}

void bootstrap()
