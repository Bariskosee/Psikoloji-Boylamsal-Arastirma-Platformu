import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";

/**
 * The Web App Manifest, per locale (STRUCTURE.md §14, §15).
 *
 * A route rather than Next's `app/manifest.ts`, because the manifest carries
 * user-visible strings — the name under the Home Screen icon — and this
 * application is bilingual. A single manifest would put an English name on a
 * Turkish participant's phone, on the one surface they see every day and cannot
 * change.
 *
 * `start_url` is locale-specific for the same reason: the icon must open the
 * study in the language the participant installed it in, without a redirect
 * they would see as a flash of the wrong language.
 *
 * `scope` is the origin root, not the locale. The service worker's scope is
 * origin-wide, and a manifest scoped to `/tr` would treat a link to `/en`
 * — or to the handoff route `/r/:code` — as leaving the application, opening it
 * in a browser tab instead. On iOS that means leaving the installed storage
 * container, which is precisely the failure the handoff exists to repair.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common" });

  const manifest = {
    name: t("appName"),
    // What actually fits under an icon. Kept distinct from `name` so the long
    // form can stay descriptive in the install prompt.
    short_name: t("appName").split(" ")[0],
    lang: locale,
    dir: "ltr",
    start_url: `/${locale}/home`,
    scope: "/",
    /**
     * Standalone, not `fullscreen`: the participant needs the OS status bar to
     * see the time and their battery while answering, and `fullscreen` also
     * removes the swipe-down affordances people rely on.
     */
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0d4f63",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // A separate maskable icon, drawn smaller. Android crops maskable icons
      // to the launcher's shape, and reusing the `any` icon here would clip the
      // mark on every device with a circular launcher.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // Short, because the manifest is fetched on every install and the strings
      // in it are translations that may be corrected.
      "Cache-Control": "public, max-age=300",
    },
  });
}
