"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { LOCALES, type Locale, type StudyResponse } from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";

/**
 * Create a study.
 *
 * Timezone is a required, explicit choice rather than a silent default: every
 * wall-clock protocol anchor resolves in it (STRUCTURE.md §10), and a study
 * that quietly inherits the server's zone sends questionnaires at the wrong
 * hour for weeks before anyone notices.
 */
export default function NewStudyPage() {
  const t = useTranslations("studies");
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [timezone, setTimezone] = useState(guessTimezone());
  const [supportedLocales, setSupportedLocales] = useState<Locale[]>(["tr", "en"]);
  const [defaultLocale, setDefaultLocale] = useState<Locale>("tr");
  const [capacity, setCapacity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const study = await api.post<StudyResponse>("/api/studies", {
        name,
        description,
        timezone,
        defaultLocale,
        supportedLocales,
        enrollmentCapacity: capacity ? Number(capacity) : null,
      });
      router.push(`/studies/${study.id}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "VALIDATION_FAILED"
          ? t("errors.validation")
          : t("errors.create"),
      );
    } finally {
      setPending(false);
    }
  }

  function toggleLocale(locale: Locale) {
    setSupportedLocales((current) => {
      const next = current.includes(locale)
        ? current.filter((entry) => entry !== locale)
        : [...current, locale];
      // The default must stay inside the supported set — the same rule the
      // contract and the database both enforce.
      if (next.length > 0 && !next.includes(defaultLocale)) setDefaultLocale(next[0] as Locale);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("create")} description={t("createSubtitle")} />

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <ErrorBanner>{error}</ErrorBanner>

        <Card>
          <CardHeader>
            <CardTitle>{t("settings")}</CardTitle>
            <CardDescription>{t("createHint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-2">
              <Label htmlFor="name">{t("name")}</Label>
              <Input
                id="name"
                required
                autoFocus
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="description">{t("description")}</Label>
              <Textarea
                id="description"
                rows={3}
                maxLength={4000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="capacity">{t("capacity")}</Label>
              <Input
                id="capacity"
                type="number"
                min={1}
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t("capacityHint")}</p>
            </div>
          </CardContent>
        </Card>

        {/*
          The permanent choices, separated and labelled as such.
          Timezone and locales cannot be changed once the study exists, and
          previously sat in the same undifferentiated column as the name — so
          the one field with weeks of consequences looked exactly like the one
          that does not.
        */}
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t("timezone")}
              <span className="bg-warning-muted text-warning-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                {t("permanent")}
              </span>
            </CardTitle>
            <CardDescription>{t("timezoneHint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-2">
              <Label htmlFor="timezone">{t("timezone")}</Label>
              <Input
                id="timezone"
                required
                list="timezones"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
              <datalist id="timezones">
                {commonTimezones().map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </div>

            <fieldset className="grid gap-3">
              <legend className="mb-1 text-sm font-medium">{t("locales")}</legend>
              <p className="text-muted-foreground -mt-1 text-xs">{t("localesHint")}</p>
              <div className="flex flex-wrap gap-4">
                {LOCALES.map((locale) => (
                  <Label
                    key={locale}
                    htmlFor={`locale-${locale}`}
                    className="flex items-center gap-2 font-normal"
                  >
                    <Checkbox
                      id={`locale-${locale}`}
                      checked={supportedLocales.includes(locale)}
                      onCheckedChange={() => toggleLocale(locale)}
                    />
                    {locale}
                  </Label>
                ))}
              </div>

              <div className="grid max-w-48 gap-2">
                <Label htmlFor="defaultLocale">{t("defaultLocale")}</Label>
                <Select
                  value={defaultLocale}
                  onValueChange={(value) => setDefaultLocale(value as Locale)}
                >
                  <SelectTrigger id="defaultLocale" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {supportedLocales.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {locale}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </fieldset>
          </CardContent>
        </Card>

        <Button type="submit" disabled={pending || supportedLocales.length === 0}>
          {pending ? t("creating") : t("create")}
        </Button>
      </form>
    </div>
  );
}

/** The browser's own zone as a starting point — always overridable. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Istanbul";
  } catch {
    return "Europe/Istanbul";
  }
}

/**
 * A short suggestion list, not a constraint. The field accepts any valid IANA
 * identifier; the API validates it against the runtime's own tz database.
 */
function commonTimezones(): string[] {
  return [
    "Europe/Istanbul",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Amsterdam",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Australia/Sydney",
    "UTC",
  ];
}
