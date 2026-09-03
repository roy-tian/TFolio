import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { initializeI18n } from "./i18n"
import { suppressNativeContextMenu } from "./lib/contextMenu"
import { loadSettings } from "./lib/settings"
import { initializeTheme } from "./lib/theme"
import "./index.css"

async function bootstrap() {
  // Before anything else: the theme and the language are settings, and both
  // have to be settled before the first paint is made in them.
  await loadSettings()
  initializeTheme()
  suppressNativeContextMenu()

  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin")
  }

  await initializeI18n()

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
