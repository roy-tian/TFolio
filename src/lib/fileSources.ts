import { invoke } from "@tauri-apps/api/core"

import type { NoticeChannel } from "@/hooks/useNotices"
import { workspaceOwner, type NoticeKind } from "@/lib/notices"
import { isWordPath } from "@/lib/openSources"
import type { OrganizeSourceInfo } from "@/lib/organize"
import { fileNameFromPath } from "@/lib/pdf"

/**
 * Reads files for their pages into the window's source list, which the
 * organize workspace and a document's added files both take pages from. An
 * office suite may take minutes, so a conversion offers Stop in the corner;
 * files that could not be read are named there. Resolves to those read.
 */
export async function readFileSources(
  paths: string[],
  notices: NoticeChannel,
): Promise<OrganizeSourceInfo[]> {
  const raise = (kind: NoticeKind, values: Record<string, string | number>) =>
    notices.raise({ kind, owner: workspaceOwner, values })
  const converting = paths.some(isWordPath)

  if (converting) {
    notices.raise({
      action: { kind: "organizeAddStop" },
      kind: "organizeAdding",
      owner: workspaceOwner,
    })
  }

  try {
    const infos = await invoke<OrganizeSourceInfo[]>("add_organize_sources", { paths })
    const refused = infos.filter((info) => info.id === undefined)

    if (refused.length > 0) {
      raise(
        refused.some((info) => info.error === "converterMissing")
          ? "organizeConverterMissing"
          : "organizeUnreadable",
        {
          count: refused.length,
          names: refused.map((info) => fileNameFromPath(info.path)).join(", "),
        },
      )
    }

    return infos.filter((info) => info.id !== undefined && info.pages.length > 0)
  } catch (error) {
    raise(
      String(error).includes("at most") ? "organizeTooManyFiles" : "organizeUnreadable",
      { count: paths.length, names: paths.map(fileNameFromPath).join(", ") },
    )

    return []
  } finally {
    if (converting) {
      notices.retract(workspaceOwner, ["organizeAdding"])
    }
  }
}
