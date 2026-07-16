import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { initializeI18n } from "./i18n"
import "./index.css"

async function bootstrap() {
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
