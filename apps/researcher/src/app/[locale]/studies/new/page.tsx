"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { LOCALES, type Locale, type StudyResponse } from "@lpr/contracts";
import { ApiError, api } from "@/lib/api";
import { ErrorBanner, styles } from "@/lib/ui";

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
    <div style={styles.page}>
      <h1>{t("create")}</h1>

      <form onSubmit={onSubmit} noValidate>
        <ErrorBanner>{error}</ErrorBanner>

        <div style={styles.field}>
          <label htmlFor="name" style={styles.label}>
            {t("name")}
          </label>
          <input
            id="name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={styles.input}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="description" style={styles.label}>
            {t("description")}
          </label>
          <textarea
            id="description"
            rows={3}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            style={{ ...styles.input, minHeight: 80 }}
          />
        </div>

        <div style={styles.field}>
          <label htmlFor="timezone" style={styles.label}>
            {t("timezone")}
          </label>
          <input
            id="timezone"
            required
            list="timezones"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            style={styles.input}
          />
          <datalist id="timezones">
            {commonTimezones().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <small style={{ color: "#5b6472" }}>{t("timezoneHint")}</small>
        </div>

        <fieldset style={{ ...styles.field, border: "1px solid #d8dbe0", borderRadius: 8 }}>
          <legend style={styles.label}>{t("locales")}</legend>
          {LOCALES.map((locale) => (
            <label key={locale} style={{ marginRight: 16 }}>
              <input
                type="checkbox"
                checked={supportedLocales.includes(locale)}
                onChange={() => toggleLocale(locale)}
              />{" "}
              {locale}
            </label>
          ))}
          <div style={{ marginTop: 12 }}>
            <label htmlFor="defaultLocale" style={styles.label}>
              {t("defaultLocale")}
            </label>
            <select
              id="defaultLocale"
              value={defaultLocale}
              onChange={(event) => setDefaultLocale(event.target.value as Locale)}
              style={styles.input}
            >
              {supportedLocales.map((locale) => (
                <option key={locale} value={locale}>
                  {locale}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <div style={styles.field}>
          <label htmlFor="capacity" style={styles.label}>
            {t("capacity")}
          </label>
          <input
            id="capacity"
            type="number"
            min={1}
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            style={styles.input}
          />
          <small style={{ color: "#5b6472" }}>{t("capacityHint")}</small>
        </div>

        <button
          type="submit"
          disabled={pending || supportedLocales.length === 0}
          style={styles.button}
        >
          {pending ? t("creating") : t("create")}
        </button>
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
