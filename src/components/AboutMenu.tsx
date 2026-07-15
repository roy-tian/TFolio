import { useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  Info,
  Languages,
  MoreVertical,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { changeLanguage } from "@/i18n"
import type { SupportedLanguage } from "@/i18n/config"

const languageOptions: Array<{
  labelKey: "language.simplifiedChinese" | "language.english"
  value: SupportedLanguage
}> = [
  { labelKey: "language.simplifiedChinese", value: "zh-CN" },
  { labelKey: "language.english", value: "en" },
]

export function AboutMenu() {
  const { i18n, t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const menuContainerRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const activeLanguage = i18n.resolvedLanguage?.startsWith("zh")
    ? "zh-CN"
    : "en"

  const closeMenu = () => {
    setLanguageMenuOpen(false)
    setMenuOpen(false)
  }

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuContainerRef.current?.contains(event.target as Node)) {
        closeMenu()
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu()
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick)
    document.addEventListener("keydown", closeOnEscape)

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [menuOpen])

  const openAboutDialog = () => {
    closeMenu()
    dialogRef.current?.showModal()
  }

  const selectLanguage = async (language: SupportedLanguage) => {
    await changeLanguage(language)
    closeMenu()
  }

  return (
    <>
      <div className="relative" ref={menuContainerRef}>
        <Button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={t("toolbar.more")}
          onClick={() => {
            setLanguageMenuOpen(false)
            setMenuOpen((isOpen) => !isOpen)
          }}
          size="icon"
          title={t("toolbar.more")}
          variant="ghost"
        >
          <MoreVertical />
        </Button>
        {menuOpen ? (
          <div
            aria-label={t("toolbar.more")}
            className="absolute right-0 top-10 z-60 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            role="menu"
          >
            <div className="relative">
              <button
                aria-expanded={languageMenuOpen}
                aria-haspopup="menu"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => setLanguageMenuOpen((isOpen) => !isOpen)}
                onPointerEnter={() => setLanguageMenuOpen(true)}
                role="menuitem"
                type="button"
              >
                <Languages className="size-4" />
                <span className="flex-1 text-left">{t("toolbar.language")}</span>
                <ChevronLeft className="size-3.5 text-muted-foreground" />
              </button>

              {languageMenuOpen ? (
                <div
                  aria-label={t("toolbar.language")}
                  className="absolute right-full top-0 mr-1 min-w-36 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                  role="menu"
                >
                  {languageOptions.map((option) => (
                    <button
                      aria-checked={activeLanguage === option.value}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                      key={option.value}
                      onClick={() => void selectLanguage(option.value)}
                      role="menuitemradio"
                      type="button"
                    >
                      <Check
                        className={
                          activeLanguage === option.value
                            ? "size-4 opacity-100"
                            : "size-4 opacity-0"
                        }
                      />
                      {t(option.labelKey)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="my-1 h-px bg-border" role="separator" />

            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
              onClick={openAboutDialog}
              role="menuitem"
              type="button"
            >
              <Info className="size-4" />
              {t("toolbar.about")}
            </button>
          </div>
        ) : null}
      </div>

      <dialog
        aria-describedby="about-description"
        aria-labelledby="about-title"
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl bg-transparent p-0 text-foreground backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
        ref={dialogRef}
        role="dialog"
      >
        <div className="relative rounded-2xl border bg-background p-6 shadow-2xl">
          <form method="dialog">
            <Button
              aria-label={t("about.close")}
              className="absolute right-3 top-3"
              size="icon-sm"
              variant="ghost"
            >
              <X />
            </Button>
          </form>
          <div className="mb-5 grid size-12 place-items-center rounded-xl bg-foreground text-lg font-semibold text-background">
            TF
          </div>
          <h2 className="text-xl font-semibold" id="about-title">
            {t("about.title")}
          </h2>
          <p
            className="mt-2 text-sm leading-6 text-muted-foreground"
            id="about-description"
          >
            {t("about.description")}
          </p>
          <p className="mt-6 text-xs text-muted-foreground">
            {t("about.copyright")}
          </p>
        </div>
      </dialog>
    </>
  )
}
