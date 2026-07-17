import { useRef, useState, type KeyboardEvent } from "react"
import {
  Info,
  Monitor,
  Moon,
  Palette,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { changeLanguage } from "@/i18n"
import { resolveSupportedLanguage, type SupportedLanguage } from "@/i18n/config"
import { cn } from "@/lib/utils"
import {
  setThemePreference,
  useThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme"

type SettingsSection = "appearance" | "about"

const sections: Array<{
  value: SettingsSection
  labelKey: "settings.appearance" | "settings.about"
  icon: LucideIcon
}> = [
  { value: "appearance", labelKey: "settings.appearance", icon: Palette },
  { value: "about", labelKey: "settings.about", icon: Info },
]

const themeOptions: Array<{
  value: ThemePreference
  labelKey: "settings.themeLight" | "settings.themeSystem" | "settings.themeDark"
  icon: LucideIcon
}> = [
  { value: "light", labelKey: "settings.themeLight", icon: Sun },
  { value: "system", labelKey: "settings.themeSystem", icon: Monitor },
  { value: "dark", labelKey: "settings.themeDark", icon: Moon },
]

const mockColors: Record<
  ResolvedTheme,
  { window: string; dot: string; page: string; line: string }
> = {
  light: { window: "#ffffff", dot: "#cccccc", page: "#f1f1f1", line: "#d6d6d6" },
  dark: { window: "#1d1d1d", dot: "#6f6f6f", page: "#2c2c2c", line: "#4a4a4a" },
}

function MockSurface({
  scheme,
  className,
}: {
  scheme: ResolvedTheme
  className?: string
}) {
  const colors = mockColors[scheme]

  return (
    <div
      className={cn("flex h-full w-full flex-col gap-1 p-1.5", className)}
      style={{ backgroundColor: colors.window }}
    >
      <div className="flex items-center gap-1">
        <span
          className="size-1 rounded-full"
          style={{ backgroundColor: colors.dot }}
        />
        <span
          className="h-1 w-4 rounded-full"
          style={{ backgroundColor: colors.dot }}
        />
      </div>
      <div
        className="flex flex-1 flex-col gap-1 rounded-sm p-1.5"
        style={{ backgroundColor: colors.page }}
      >
        <span
          className="h-1 w-3/4 rounded-full"
          style={{ backgroundColor: colors.line }}
        />
        <span
          className="h-1 w-full rounded-full"
          style={{ backgroundColor: colors.line }}
        />
        <span
          className="h-1 w-2/3 rounded-full"
          style={{ backgroundColor: colors.line }}
        />
      </div>
    </div>
  )
}

function ThemeMock({ preference }: { preference: ThemePreference }) {
  const frame =
    "relative aspect-[4/3] w-full overflow-hidden rounded-md ring-1 ring-foreground/10"

  if (preference === "system") {
    return (
      <div className={frame}>
        <MockSurface scheme="light" className="absolute inset-0" />
        <div className="absolute inset-0" style={{ clipPath: "inset(0 0 0 50%)" }}>
          <MockSurface scheme="dark" />
        </div>
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-foreground/15" />
      </div>
    )
  }

  return (
    <div className={frame}>
      <MockSurface scheme={preference} />
    </div>
  )
}

export function SettingsDialog() {
  const { i18n, t } = useTranslation()
  const [section, setSection] = useState<SettingsSection>("appearance")
  const preference = useThemePreference()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const activeLanguage: SupportedLanguage =
    resolveSupportedLanguage(i18n.resolvedLanguage) ?? "en"

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight"
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft"

    if (!forward && !backward) {
      return
    }

    event.preventDefault()
    const nextIndex =
      (index + (forward ? 1 : -1) + sections.length) % sections.length
    setSection(sections[nextIndex].value)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          aria-label={t("settings.open")}
          size="icon"
          title={t("settings.open")}
          variant="outline"
        >
          <Settings />
        </Button>
      </DialogTrigger>

      <DialogContent
        className="flex h-[27rem] w-[44rem] gap-0 overflow-hidden p-0 sm:max-w-[44rem]"
        showCloseButton={false}
      >
        <DialogDescription className="sr-only">
          {t("settings.description")}
        </DialogDescription>

        <DialogClose asChild>
          <Button
            aria-label={t("settings.close")}
            className="absolute top-2 right-2 z-10"
            size="icon-sm"
            variant="ghost"
          >
            <X />
          </Button>
        </DialogClose>

        <div className="flex h-full w-40 shrink-0 flex-col gap-3 border-r bg-muted/30 p-2.5">
          <DialogTitle className="px-2 pt-1.5 text-sm font-medium">
            {t("settings.title")}
          </DialogTitle>
          <div
            aria-label={t("settings.title")}
            aria-orientation="vertical"
            className="flex flex-col gap-0.5"
            role="tablist"
          >
            {sections.map((item, index) => {
              const selected = section === item.value
              const Icon = item.icon

              return (
                <button
                  aria-controls={`settings-panel-${item.value}`}
                  aria-selected={selected}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  id={`settings-tab-${item.value}`}
                  key={item.value}
                  onClick={() => setSection(item.value)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  ref={(node) => {
                    tabRefs.current[index] = node
                  }}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  <Icon className="size-4" />
                  {t(item.labelKey)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            aria-labelledby="settings-tab-appearance"
            className="flex-1 overflow-y-auto p-6"
            hidden={section !== "appearance"}
            id="settings-panel-appearance"
            role="tabpanel"
          >
            <div className="space-y-6">
              <section className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium" id="settings-theme-label">
                    {t("settings.theme")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.themeHint")}
                  </p>
                </div>
                <RadioGroupPrimitive.Root
                  aria-labelledby="settings-theme-label"
                  className="grid grid-cols-3 gap-3"
                  onValueChange={(value) =>
                    setThemePreference(value as ThemePreference)
                  }
                  value={preference}
                >
                  {themeOptions.map((option) => {
                    const Icon = option.icon

                    return (
                      <RadioGroupPrimitive.Item
                        className="group/theme flex flex-col gap-2 rounded-lg border bg-card p-2 text-left outline-none transition-all hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:ring-2 data-checked:ring-primary/25"
                        key={option.value}
                        value={option.value}
                      >
                        <ThemeMock preference={option.value} />
                        <div className="flex items-center justify-between gap-1 px-0.5">
                          <span className="flex items-center gap-1.5 text-xs font-medium">
                            <Icon className="size-3.5" />
                            {t(option.labelKey)}
                          </span>
                          <span className="flex size-3.5 items-center justify-center rounded-full border border-input transition-colors group-data-checked/theme:border-primary group-data-checked/theme:bg-primary">
                            <RadioGroupPrimitive.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
                          </span>
                        </div>
                      </RadioGroupPrimitive.Item>
                    )
                  })}
                </RadioGroupPrimitive.Root>
              </section>

              <section className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="settings-language">
                    {t("settings.language")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.languageHint")}
                  </p>
                </div>
                <Select
                  onValueChange={(value) =>
                    void changeLanguage(value as SupportedLanguage)
                  }
                  value={activeLanguage}
                >
                  <SelectTrigger className="w-full max-w-60" id="settings-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zh-CN">
                      {t("language.simplifiedChinese")}
                    </SelectItem>
                    <SelectItem value="en">{t("language.english")}</SelectItem>
                  </SelectContent>
                </Select>
              </section>
            </div>
          </div>

          <div
            aria-labelledby="settings-tab-about"
            className="flex-1 overflow-y-auto p-6"
            hidden={section !== "about"}
            id="settings-panel-about"
            role="tabpanel"
          >
            <div className="flex h-full flex-col">
              <div className="mb-5 grid size-12 place-items-center rounded-xl bg-foreground text-lg font-semibold text-background">
                TF
              </div>
              <h3 className="text-lg font-semibold">{t("about.title")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("about.description")}
              </p>
              <p className="mt-auto pt-6 text-xs text-muted-foreground">
                {t("about.copyright")}
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
