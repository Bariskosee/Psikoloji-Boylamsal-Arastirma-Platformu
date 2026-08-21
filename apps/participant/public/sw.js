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

const SW_VERSION = "phase-8";

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
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/**
 * Push (Phase 9 fills this in).
 *
 * Registered now and doing nothing but logging, so that the whole subscription
 * lifecycle — permission, subscribe, store, unsubscribe, re-subscribe — is
 * exercisable before a single notification exists.
 *
 * When this is implemented it must call `showNotification`. A push handler that
 * resolves without displaying anything causes the browser to show its own
 * "this site was updated in the background" notice, which is worse than
 * silence. Nothing sends to these subscriptions in Phase 8, so that cannot
 * happen yet.
 *
 * The payload will carry NO research content: titles and bodies are generic,
 * localised, configurable strings, because payloads pass through a third-party
 * push service (ADR-006).
 */
self.addEventListener("push", (event) => {
  console.info(
    `[sw ${SW_VERSION}] push received; Phase 8 displays nothing`,
    event.data ? "with data" : "without data",
  );
});

/**
 * Notification click (Phase 9 fills this in).
 *
 * Will focus an existing window where one exists rather than opening a second
 * copy of the application — on a phone, two tabs of the same study is a
 * participant who cannot tell which one is real.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  console.info(`[sw ${SW_VERSION}] notification click; Phase 8 navigates nowhere`);
});
