"use client";

import type { PushConfigResponse, PushSubscriptionSummary } from "@lpr/contracts";
import { api } from "./api";
import {
  classifyPushAvailability,
  detectPlatform,
  parseIosVersion,
  type PushAvailability,
  type PushEnvironment,
} from "./push-availability";

/**
 * The browser side of push (PLAN.md Phase 8, ADR-006, FR-16).
 *
 * Everything here is an EFFECT — asking the browser what it supports,
 * requesting permission, subscribing, telling the API. Every DECISION is in
 * `push-availability.ts`, which is why this file has no branching about iOS
 * versions or install state: it collects the facts and hands them over.
 *
 * That split is not tidiness. The iOS rules — push exists only in a
 * Home-Screen-installed application, only from 16.4, and the browser tab's
 * permission state says nothing about the installed application's — are
 * untestable in any development environment and unreproducible on a desktop.
 * Keeping them in a pure function makes them a table of unit tests instead of a
 * device someone has to borrow.
 */

export const SERVICE_WORKER_PATH = "/sw.js";

/** Read the current environment, without deciding anything about it. */
export function readPushEnvironment(vapidConfigured: boolean): PushEnvironment {
  const userAgent = navigator.userAgent;
  const platform = detectPlatform(userAgent, navigator.maxTouchPoints);

  return {
    platform,
    iosVersion: platform === "IOS" ? parseIosVersion(userAgent) : null,
    isStandalone: isStandalone(),
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : "default",
    vapidConfigured,
  };
}

/**
 * Is the application running from the Home Screen rather than a browser tab?
 *
 * Two checks, because the platforms disagree. `display-mode: standalone` is the
 * standard and is what Android reports. `navigator.standalone` is Apple's
 * older, non-standard property, and on some iOS versions it is the only one
 * that answers correctly — which matters, because iOS is the platform whose
 * answer changes what the participant is told.
 */
export function isStandalone(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

/** Ask the API whether this deployment can send push at all. */
export async function fetchPushConfig(): Promise<string | null> {
  const config = await api.get<PushConfigResponse>("/api/participant/push/config");
  return config.vapidPublicKey;
}

export function availability(environment: PushEnvironment): PushAvailability {
  return classifyPushAvailability(environment);
}

/**
 * Register the service worker.
 *
 * Returns the registration so the caller can subscribe through it. Failure is
 * returned as null rather than thrown: a browser that refuses to register a
 * worker (private mode in some browsers, a policy, an unsupported context) must
 * leave the participant able to complete every questionnaire, and an exception
 * escaping here would take the screen down with it (STRUCTURE.md §14).
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: "/" });
  } catch {
    return null;
  }
}

export type EnableOutcome =
  | { readonly ok: true; readonly subscription: PushSubscriptionSummary }
  /** The participant closed the prompt without answering. Not a refusal. */
  | { readonly ok: false; readonly reason: "DISMISSED" }
  | { readonly ok: false; readonly reason: "DENIED" }
  | { readonly ok: false; readonly reason: "FAILED" };

/**
 * Request permission and subscribe, in that order, from a user gesture.
 *
 * **Must be called from a click handler.** Browsers require a transient user
 * activation for `Notification.requestPermission()`, and FR-16 requires that
 * the participant has been given a reason first. This function does not check
 * either — it cannot — so its single caller is the button on the notifications
 * screen, which sits below the explanation.
 *
 * The order matters: permission, then subscribe, then tell the server. A
 * subscription created before permission would be a subscription the browser
 * may revoke without telling us; a server row written before the browser
 * confirmed would be a row that promises reach we do not have.
 */
export async function enablePush(vapidPublicKey: string): Promise<EnableOutcome> {
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: "FAILED" };
  }

  // "default" means the participant dismissed the prompt rather than refusing.
  // Distinguished because the remedies differ: a dismissal can simply be asked
  // again, a refusal cannot and must be sent to system settings.
  if (permission === "default") return { ok: false, reason: "DISMISSED" };
  if (permission !== "granted") return { ok: false, reason: "DENIED" };

  const registration = await registerServiceWorker();
  if (registration === null) return { ok: false, reason: "FAILED" };

  try {
    // `ready` rather than the registration itself: a worker that has just
    // installed is not yet active, and `subscribe` on an inactive registration
    // fails on some browsers with an error that reads like a permission
    // problem.
    const active = await navigator.serviceWorker.ready;

    const subscription = await active.pushManager.subscribe({
      // Non-negotiable on every current browser, and correct regardless: a
      // silent push is a push that can wake a device without the participant
      // ever knowing it happened.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(vapidPublicKey),
    });

    const json = subscription.toJSON();
    if (!json.keys?.p256dh || !json.keys.auth) return { ok: false, reason: "FAILED" };

    // Forwarded as the browser produced it. Reassembling the keys here is where
    // one gets truncated, and the failure would only appear in Phase 9, months
    // into a study, as reminders that never arrive.
    const stored = await api.post<PushSubscriptionSummary>("/api/participant/push/subscriptions", {
      endpoint: subscription.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      expirationTime: subscription.expirationTime ?? null,
    });

    return { ok: true, subscription: stored };
  } catch {
    return { ok: false, reason: "FAILED" };
  }
}

/**
 * Stop notifications on this device.
 *
 * The server is told FIRST, then the browser subscription is dropped. The other
 * order leaves a window in which the browser has forgotten the endpoint and the
 * server still holds it — and nothing could then deactivate that row, because
 * the endpoint needed to name it is gone. Phase 9 would go on selecting it for
 * every send.
 */
export async function disablePush(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return true;

    await api.delete("/api/participant/push/subscriptions", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    return true;
  } catch {
    return false;
  }
}

/**
 * Base64url from the API into the `Uint8Array` `subscribe()` demands.
 *
 * The Push API predates browsers accepting a string here, and while several now
 * do, not all of them do — including Safari, which is the platform this whole
 * phase exists for.
 */
function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));

  // Backed by an explicit ArrayBuffer, not the default `ArrayBufferLike`:
  // `applicationServerKey` is typed as a `BufferSource`, which excludes a view
  // that might sit on a SharedArrayBuffer.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
