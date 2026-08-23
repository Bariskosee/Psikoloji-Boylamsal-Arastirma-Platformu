/**
 * The password-reset message, in the researcher's own language.
 *
 * ── Why this copy is here and not in `@lpr/i18n` ────────────────────────────
 * That package serves the two frontends through next-intl, which the API does
 * not run. Reaching into its catalogues from here would couple the API to a
 * frontend runtime for two strings, and the strings themselves are different in
 * kind: this text has to be readable as plain text in a mail client, with no
 * markup and no interpolated components.
 *
 * ── Why it is localised at all ──────────────────────────────────────────────
 * PLAN.md Phase 12 asks for "no untranslated string in either application", and
 * a reset email is the one message a researcher receives outside the
 * application entirely. Sending an English wall of text to a Turkish researcher
 * — about an account security event, asking them to click a link — is exactly
 * the message somebody should distrust and delete.
 *
 * The locale comes from the account, not from the browser: the request may
 * arrive from a shared machine, and the account's own setting is the better
 * guess at what the person reads.
 */

export type MailLocale = "en" | "tr";

export interface ResetEmail {
  readonly subject: string;
  readonly text: string;
}

export function resetEmail(locale: MailLocale, url: string): ResetEmail {
  return locale === "tr"
    ? {
        subject: "Araştırma platformu parolanızı sıfırlayın",
        text: [
          "Bu adresin parolasının sıfırlanması istendi.",
          "",
          "Bu istek sizden geldiyse, aşağıdaki bağlantıyı bir saat içinde açın:",
          url,
          "",
          "Bağlantı yalnızca bir kez çalışır. Kullanmanız, tüm cihazlardaki oturumlarınızı da kapatır.",
          "",
          "Bu istek sizden gelmediyse yapmanız gereken bir şey yok — parolanız değişmedi.",
          "Bu iletiyi açmadan hiç kimse bu bağlantıyı kullanamaz.",
        ].join("\n"),
      }
    : {
        subject: "Reset your research platform password",
        text: [
          "Somebody asked to reset the password for this address.",
          "",
          "If it was you, open the link below within one hour:",
          url,
          "",
          "The link works once. Using it will also sign you out everywhere.",
          "",
          "If it was not you, no action is needed — the password has not changed.",
          "Nobody can use this link without opening this message.",
        ].join("\n"),
      };
}
