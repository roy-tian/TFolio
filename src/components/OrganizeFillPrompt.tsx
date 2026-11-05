import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { FillAnswer, FillPrompt } from "@/hooks/useOrganizeFill"

type OrganizeFillPromptProps = {
  onAnswer: (answer: FillAnswer) => void
  open: boolean
  prompt: FillPrompt | null
}

/** What bringing the viewer's file into the organize workspace asks first:
    whether to start the workspace over, and what to do with unsaved changes
    organize, which reads the file on disk, would not see. */
export function OrganizeFillPrompt({ onAnswer, open, prompt }: OrganizeFillPromptProps) {
  const { t } = useTranslation()
  const offerSave = prompt?.kind === "unsaved" && prompt.canSave

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(null)
        }
      }}
      open={open}
    >
      <AlertDialogContent data-slot="organize-fill-prompt">
        {prompt?.kind === "startOver" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("organize.startOverTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("organize.startOverDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("organize.fillCancel")}</AlertDialogCancel>
              <AlertDialogAction
                data-action="start-over"
                onClick={() => onAnswer("confirm")}
              >
                {t("organize.startOverConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : prompt ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("organize.fillUnsavedTitle", { name: prompt.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {prompt.canSave
                  ? t("organize.fillUnsavedDescription")
                  : t("organize.fillCopyOnlyDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* Stacked: three choices this long fit no row in every language. */}
            <AlertDialogFooter className={offerSave ? "sm:flex-col-reverse" : undefined}>
              <AlertDialogCancel>
                {prompt.via === "switch"
                  ? t("organize.fillSkip")
                  : t("organize.fillCancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                data-action="add-saved"
                onClick={() => onAnswer("saved")}
                variant={offerSave ? "outline" : "default"}
              >
                {t("organize.fillSaved")}
              </AlertDialogAction>
              {offerSave ? (
                <AlertDialogAction data-action="save-and-add" onClick={() => onAnswer("save")}>
                  {t("organize.fillSave")}
                </AlertDialogAction>
              ) : null}
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
