/**
 * The participant service worker (PLAN.md Phase 8, STRUCTURE.md §14, ADR-006).
 *
 * Served from the origin root, which is why it lives in `public/` rather than
 * being a route: a service worker's scope cannot exceed the directory it was
 * served from, and this one has to cover the whole application. The
 * participant application has its own origin (ADR-009), so an origin-wide scope
 * here does not put a worker in front of anything else.
 *
 * ── What this worker does NOT do ────────────────────────────────────────────
 * It does not cache anything. Offline questionnaire completion is explicitly
 * not an MVP requirement (STRUCTURE.md §14): the autosave outbox already
 * provides resilience against transient connectivity loss, which is a
 * different and narrower guarantee, and a cache here would introduce the one
 * failure this application must never have — a participant answering a stale
 * copy of a questionnaire whose version has since been superseded.
 *
 * It does not send or display anything of its own. Phase 8 registers the `push`
 * and `notificationclick` handlers and no more; Phase 9 fills them in. They are
 * here now so that the registration, the update flow, and the permission
 * lifecycle can be exercised end to end before there is anything to send.
 */

/**
 * Where the API lives, for the best-effort event reports below.
 *
 * Injected at registration time rather than hard-coded: the participant
 * application and the API are on different origins (ADR-009), and that origin
 * differs between local development, staging and production. A service worker
 * cannot read the page's environment, so the page tells it once, on activation,
 * and it remembers.
 */
let apiBaseUrl = null;

/**
 * Install without taking over.
 *
 * `skipWaiting()` is deliberately NOT called here. A new worker that activates
 * immediately can reload the page under a participant who is halfway through a
 * questionnaire — the answers are saved, but the interruption at question 60 of
 * 100 is exactly the friction that ends a longitudinal study early. The new
 * worker waits; the page asks the participant; `SKIP_WAITING` below is how they
 * say yes.
 */
self.addEventListener("install", () => {
  // Nothing to precache — see the note above about why this worker holds no
  // cache at all.
});

self.addEventListener("activate", (event) => {
  // Claim open clients so that a worker which HAS been activated (either
  // because the participant accepted the update, or because this is the first
  // install) starts controlling the page it was installed from, rather than
  // only the next navigation.
  event.waitUntil(self.clients.claim());
});

/**
 * The page's way of saying "the participant agreed to update now".
 *
 * The only message this worker accepts. It is sent from
 * `src/components/ServiceWorkerUpdater.tsx` after an explicit tap, never
 * automatically.
 */
self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  // The page handing over the API origin. Sent on every registration, so a
  // worker that outlived a deployment learns the current one.
  if (event.data.type === "SET_API_BASE_URL" && typeof event.data.url === "string") {
    apiBaseUrl = event.data.url;
  }
});

/**
 * Report a best-effort client event (FR-19, STRUCTURE.md §9.3).
 *
 * Deliberately failure-tolerant: this is telemetry about a notification, and it
 * must never be allowed to prevent the notification itself being shown or its
 * click being handled. Everything here is wrapped and swallowed.
 *
 * `credentials: "include"` because the API authenticates the participant from
 * their continuity cookie; the service worker has no token and must not have
 * one.
 */
async function reportEvent(payload, event) {
  if (apiBaseUrl === null) return;

  try {
    await fetch(`${apiBaseUrl}/api/participant/notifications/events`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: payload.sessionId,
        kind: payload.kind,
        occurrenceIndex: payload.occurrenceIndex,
        event,
      }),
    });
  } catch {
    // Offline, or the API is down. The event is lost, which is exactly what
    // "best-effort" means and why nothing may treat these as a denominator.
  }
}

/**
 * Push (Phase 9, ADR-006, STRUCTURE.md §9.4).
 *
 * The payload carries NO research content — the server builds it from generic
 * localised strings and a session id, because payloads pass through Google's,
 * Apple's or Mozilla's infrastructure. Nothing here should ever start rendering
 * question text, and there is nothing in the payload to render.
 *
 * `showNotification` is not optional. A push handler that resolves without
 * displaying anything makes the browser show its own "this site was updated in
 * the background" notice — worse than silence, and on some platforms it costs
 * the site its push permission.
 */
self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  /**
   * A malformed or absent payload still shows something.
   *
   * The browser is going to display a notification either way — see above — so
   * the choice is between our generic string and the browser's confusing one.
   * The fallback deliberately says nothing about the study, because a payload
   * we could not parse is a payload we cannot make claims from.
   */
  const title = payload?.title ?? "Update";
  const body = payload?.body ?? "";

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag: payload?.tag ?? "session",
        // Replaces an earlier notification carrying the same tag rather than
        // stacking: a participant who missed three reminders should find one
        // waiting, not three saying the same thing.
        renotify: false,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: payload ?? {},
      });

      if (payload?.sessionId) await reportEvent(payload, "DISPLAYED");
    })(),
  );
});

/**
 * Notification click (Phase 9).
 *
 * Focuses an existing window where one exists rather than opening a second copy
 * of the application — on a phone, two tabs of the same study is a participant
 * who cannot tell which one is real, and who may answer in the stale one.
 *
 * Handles both the cold start (no client at all — the app was closed, which is
 * the ordinary case for a notification) and the already-open case.
 *
 * The deep link carries a session id and nothing else. The page it opens
 * re-authorises from the continuity credential, so a link that reached the
 * wrong person grants them nothing (STRUCTURE.md §9.4).
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data ?? {};
  const locale = data.locale === "tr" ? "tr" : "en";
  const target = data.sessionId ? `/${locale}/sessions/${data.sessionId}` : `/${locale}/home`;

  event.waitUntil(
    (async () => {
      if (data.sessionId) await reportEvent(data, "CLICKED");

      const clients = await self.clients.matchAll({
        type: "window",
        // Includes clients this worker does not yet control, which is the case
        // immediately after an update — without it, a click would open a second
        // window alongside the one the participant already had open.
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }

      // Cold start: nothing is open, which is the ordinary case for a
      // notification and the one PLAN.md asks be verified on a real device.
      await self.clients.openWindow(target);
    })(),
  );
});
