import { useRef, type KeyboardEvent } from "react"
import {
  FileSignature,
  Info,
  Monitor,
  Moon,
  Palette,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react"
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { useTranslation } from "react-i18next"

import appLargeIcon from "@/assets/brand/app-large.svg"
import { AboutUpdate } from "@/components/AboutUpdate"
import { LanguagePicker } from "@/components/LanguagePicker"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  isSignatureHandling,
  storeSignatureHandling,
  useSignatureHandling,
  type SignatureHandling,
} from "@/lib/signatureHandling"
import { cn } from "@/lib/utils"
import {
  setThemePreference,
  useThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme"

export type SettingsSection = "appearance" | "signatures" | "about"

const sections: Array<{
  value: SettingsSection
  labelKey: "settings.appearance" | "settings.signatures" | "settings.about"
  icon: LucideIcon
}> = [
  { value: "appearance", labelKey: "settings.appearance", icon: Palette },
  { value: "signatures", labelKey: "settings.signatures", icon: FileSignature },
  { value: "about", labelKey: "settings.about", icon: Info },
]

const signatureOptions: Array<{
  value: SignatureHandling
  labelKey: "settings.signatureAsk" | "settings.signatureFlatten" | "settings.signatureKeep"
}> = [
  { value: "ask", labelKey: "settings.signatureAsk" },
  { value: "flatten", labelKey: "settings.signatureFlatten" },
  { value: "keep", labelKey: "settings.signatureKeep" },
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

type SettingsDialogProps = {
  onOpenChange: (open: boolean) => void
  onSectionChange: (section: SettingsSection) => void
  open: boolean
  section: SettingsSection
}

export function SettingsDialog({
  onOpenChange,
  onSectionChange,
  open,
  section,
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const preference = useThemePreference()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const appearanceRef = useRef<HTMLDivElement>(null)
  const signaturesRef = useRef<HTMLDivElement>(null)
  const aboutRef = useRef<HTMLDivElement>(null)
  const signatureHandling = useSignatureHandling()

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
    onSectionChange(sections[nextIndex].value)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex h-[27rem] w-[47rem] gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]"
        showCloseButton={false}
      >
        <DialogDescription className="sr-only">
          {t("settings.description")}
        </DialogDescription>

        <DialogClose
          render={
            <Button
              aria-label={t("settings.close")}
              className="absolute top-2 right-2 z-10"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <X />
        </DialogClose>

        <div className="flex h-full max-w-60 min-w-40 shrink-0 flex-col gap-3 border-r bg-muted/30 p-2.5">
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
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  id={`settings-tab-${item.value}`}
                  key={item.value}
                  onClick={() => onSectionChange(item.value)}
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
            className="overlay-scroll-viewport flex-1 overflow-y-auto p-6"
            hidden={section !== "appearance"}
            id="settings-panel-appearance"
            ref={appearanceRef}
            role="tabpanel"
          >
            <div className="flex flex-col gap-6">
              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium" id="settings-theme-label">
                    {t("settings.theme")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.themeHint")}
                  </p>
                </div>
                <RadioGroup
                  aria-labelledby="settings-theme-label"
                  className="grid grid-cols-3 gap-3"
                  onValueChange={(value) => setThemePreference(value)}
                  value={preference}
                >
                  {themeOptions.map((option) => {
                    const Icon = option.icon

                    return (
                      <Radio.Root
                        className="group/theme flex flex-col gap-2 rounded-lg border bg-card p-2 text-left outline-none transition-all hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:ring-2 data-checked:ring-primary/25"
                        key={option.value}
                        value={option.value}
                      >
                        <ThemeMock preference={option.value} />
                        {/* From the top, so a name on two lines in a narrow window leaves
                            its icon and its mark where the other cards have theirs. */}
                        <div className="flex items-start justify-between gap-1 px-0.5">
                          <span className="flex min-w-0 items-start gap-1.5 text-xs leading-3.5 font-medium">
                            <Icon className="size-3.5 shrink-0" />
                            {t(option.labelKey)}
                          </span>
                          <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-input transition-colors group-data-checked/theme:border-primary group-data-checked/theme:bg-primary">
                            <Radio.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
                          </span>
                        </div>
                      </Radio.Root>
                    )
                  })}
                </RadioGroup>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="settings-language">
                    {t("settings.language")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.languageHint")}
                  </p>
                </div>
                <LanguagePicker id="settings-language" />
              </section>
            </div>
          </div>

          <div
            aria-labelledby="settings-tab-signatures"
            className="overlay-scroll-viewport flex-1 overflow-y-auto p-6"
            hidden={section !== "signatures"}
            id="settings-panel-signatures"
            ref={signaturesRef}
            role="tabpanel"
          >
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium" id="settings-signatures-label">
                  {t("settings.signatureHandling")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.signatureHandlingHint")}
                </p>
              </div>
              <RadioGroup
                aria-labelledby="settings-signatures-label"
                className="flex flex-col gap-2"
                onValueChange={(value) => {
                  if (isSignatureHandling(value)) {
                    storeSignatureHandling(value)
                  }
                }}
                value={signatureHandling}
              >
                {signatureOptions.map((option) => (
                  <Radio.Root
                    className="group/signature flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm outline-none transition-all hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary"
                    data-signature-handling={option.value}
                    key={option.value}
                    value={option.value}
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-input transition-colors group-data-checked/signature:border-primary group-data-checked/signature:bg-primary">
                      <Radio.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
                    </span>
                    {t(option.labelKey)}
                  </Radio.Root>
                ))}
              </RadioGroup>
            </section>
          </div>

          <div
            aria-labelledby="settings-tab-about"
            className="overlay-scroll-viewport flex-1 overflow-y-auto p-6"
            hidden={section !== "about"}
            id="settings-panel-about"
            ref={aboutRef}
            role="tabpanel"
          >
            <div className="flex h-full flex-col">
              <img alt="" className="mb-5 size-20" draggable={false} src={appLargeIcon} />
              <h3 className="text-lg font-semibold">{t("about.title")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("about.description")}
              </p>
              <p className="mt-auto pt-6 text-xs text-muted-foreground">
                {t("about.version", { version: __APP_VERSION__ })}{" "}
                {open && section === "about" ? <AboutUpdate /> : null}
              </p>
              <p className="pt-2 text-xs text-muted-foreground">
                {t("about.copyright")}
              </p>
            </div>
          </div>
          {/* The shown panel fills this box; the hidden one has none. */}
          <OverlayScrollbars
            viewportRef={
              section === "about"
                ? aboutRef
                : section === "signatures"
                  ? signaturesRef
                  : appearanceRef
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
