import { invoke } from "@tauri-apps/api/core"

let available = false

/** Asked once at boot: the backend passively detects the office suites this
    machine has, starting none of them, and the answer holds for the run. */
export async function loadWordConversionAvailability() {
  try {
    available = await invoke<boolean>("word_conversion_available")
  } catch {
    // An unreachable backend leaves the wizard taking PDFs and images only —
    // the one promise it could still keep.
  }
}

/** Whether the import wizard may accept Word documents. Settled at boot,
    before the wizard can open, because it is the machine's own state. */
export function wordConversionAvailable() {
  return available
}
