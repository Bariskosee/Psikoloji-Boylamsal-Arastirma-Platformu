/**
 * Can this device receive push, and if not, what should we tell the participant?
 * (PLAN.md Phase 8, ADR-006, FR-16, STRUCTURE.md §14.)
 *
 * Every branch below exists because the honest answer to "why is there no
 * Enable button?" is different in each one, and a participant who is told the
 * wrong reason takes the wrong action — or, worse, concludes the study
 * application is broken and stops opening it.
 *
 * ── Why this is a pure function, and why it is here ─────────────────────────
 * It is a decision, not an effect: the caller inspects `navigator` and
 * `Notification.permission` and hands the findings in, and everything after
 * that is a function of those findings. That makes the iOS matrix — the part
 * most likely to be wrong and least likely to be exercised in development,
 * because none of it reproduces on a desktop browser — a table of unit tests
 * rather than a device someone has to borrow.
 *
 * It is NOT in `packages/domain`, where the rest of this system's pure logic
 * lives, because the frontends are forbidden from importing that package
 * (STRUCTURE.md §3) — and rightly so: this is a decision about one browser,
 * made in that browser, with no bearing on research data. So it sits beside its
 * only caller, and is tested here.
 *
 * Nothing in this file touches `navigator`, `window`, or a clock. `push.ts`
 * does all of that and hands the results in.
 */

/**
 * The three platforms whose push story genuinely differs.
 *
 * Not an exhaustive taxonomy of operating systems — the only distinction that
 * changes what we do is "iOS, where push requires Home Screen installation and
 * a minimum OS version" versus "everything else, where the standard applies".
 */
export type DevicePlatform = "IOS" | "ANDROID" | "OTHER";

/** The browser's own three-valued permission state, named as the API names it. */
export type NotificationPermissionState = "default" | "granted" | "denied";

export interface IosVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Web Push arrived for installed PWAs in iOS 16.4 (ADR-006).
 *
 * Below it there is no `PushManager` at all, however the application is
 * launched, so the only truthful message is "update iOS, or expect to check
 * the app yourself".
 */
export const IOS_PUSH_MIN_VERSION: IosVersion = Object.freeze({ major: 16, minor: 4 });

/**
 * What the caller observed. Every field is something the browser was asked, so
 * that this function asks the browser nothing.
 */
export interface PushEnvironment {
  readonly platform: DevicePlatform;
  /** Parsed from the user agent; null when the platform is not iOS or the version is unreadable. */
  readonly iosVersion: IosVersion | null;
  /** `display-mode: standalone` — i.e. launched from the Home Screen, not a browser tab. */
  readonly isStandalone: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
  readonly permission: NotificationPermissionState;
  /** False when the deployment has no VAPID key. Push is then off for everyone. */
  readonly vapidConfigured: boolean;
}

export type PushAvailability =
  /** Permission has been granted; the app may subscribe (or already has). */
  | "ENABLED"
  /** Everything is in place and permission has not been asked for yet. */
  | "READY"
  /** The participant said no. Only they can undo it, in OS or browser settings. */
  | "BLOCKED"
  /** iOS, in a browser tab. Push exists only after Add to Home Screen. */
  | "REQUIRES_INSTALL"
  /** iOS older than 16.4. No amount of installing will help. */
  | "REQUIRES_IOS_UPGRADE"
  /** This deployment has no VAPID key, so no study on it can send anything. */
  | "NOT_CONFIGURED"
  /** The browser has no Push API and there is nothing the participant can do. */
  | "UNSUPPORTED";

/**
 * Classify, in the order the answers become useful to the participant.
 *
 * The sequence is the design. A denied permission on an iOS browser tab is
 * reported as `REQUIRES_INSTALL`, not `BLOCKED`, because the tab's permission
 * state says nothing about the installed application's — telling that
 * participant they are blocked would send them into Settings to fix something
 * that is not broken, and leave the actual remedy unmentioned.
 */
export function classifyPushAvailability(environment: PushEnvironment): PushAvailability {
  // First, because it is true regardless of the device: with no key, nothing
  // this deployment runs can send a push, and offering an Enable button would
  // collect a subscription that is guaranteed never to be used.
  if (!environment.vapidConfigured) return "NOT_CONFIGURED";

  if (environment.platform === "IOS") {
    // Version before installation: on iOS 16.3 the install still succeeds and
    // still yields no push, so "add to Home Screen" would be a wasted
    // instruction ending in the same empty result.
    if (environment.iosVersion !== null && isBelowMinimum(environment.iosVersion)) {
      return "REQUIRES_IOS_UPGRADE";
    }

    // The single highest-value branch in this file. In a Safari tab on iOS the
    // Push API is absent no matter the version, and the generic `UNSUPPORTED`
    // answer would be both true and useless — the participant is one Add to
    // Home Screen away from full support.
    if (!environment.isStandalone) return "REQUIRES_INSTALL";
  }

  // Checked after the iOS branch so that "your browser cannot do this" is only
  // ever said when it is the whole truth.
  if (!environment.hasServiceWorker || !environment.hasPushManager) return "UNSUPPORTED";
  if (!environment.hasNotification) return "UNSUPPORTED";

  if (environment.permission === "granted") return "ENABLED";
  if (environment.permission === "denied") return "BLOCKED";
  return "READY";
}

/**
 * May the interface show a control that requests permission?
 *
 * Only in `READY`. This is the guard behind FR-16 and the browsers' own rule:
 * permission is requested from a user gesture, after an explanation, and never
 * on page load. Everything else in the matrix leads to an explanation with no
 * button, because in every other state the button could not succeed.
 */
export function mayRequestPermission(availability: PushAvailability): boolean {
  return availability === "READY";
}

/**
 * Is the participant's inability to receive push something they can change?
 *
 * Drives the tone of the notifications screen, and — later — which participants
 * a researcher can usefully be shown as reachable-in-principle. `BLOCKED` is
 * recoverable: it lives in OS settings, and a participant who changes their
 * mind can. `UNSUPPORTED` and `NOT_CONFIGURED` are not, and pretending
 * otherwise produces a screen that nags about something impossible.
 */
export function isRecoverable(availability: PushAvailability): boolean {
  return (
    availability === "READY" ||
    availability === "BLOCKED" ||
    availability === "REQUIRES_INSTALL" ||
    availability === "REQUIRES_IOS_UPGRADE"
  );
}

function isBelowMinimum(version: IosVersion): boolean {
  if (version.major !== IOS_PUSH_MIN_VERSION.major) {
    return version.major < IOS_PUSH_MIN_VERSION.major;
  }
  return version.minor < IOS_PUSH_MIN_VERSION.minor;
}

/**
 * Which platform a user-agent string describes.
 *
 * User-agent sniffing is a bad habit with one good excuse, and this is it: the
 * capability we need to predict — "is this device one where push requires Home
 * Screen installation?" — has no feature detection, because the feature is
 * absent in exactly the situation we want to explain. `navigator.userAgent` is
 * the only signal that distinguishes "iOS Safari, installable" from "a browser
 * that will never support push".
 *
 * iPadOS reports itself as a Macintosh, which is why the touch-point count is
 * consulted: a Mac has none, an iPad claiming to be one has several. Without
 * it, every iPad participant would be told their browser is unsupported and
 * never see the install guidance that would have worked.
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): DevicePlatform {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "IOS";
  if (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1) return "IOS";
  if (/\bAndroid\b/.test(userAgent)) return "ANDROID";
  return "OTHER";
}

/**
 * The iOS version in a user-agent string, or null when it is not stated.
 *
 * Null is returned rather than a guess, and `classifyPushAvailability` treats
 * null as "not known to be too old". Guessing low would tell a participant on a
 * current iPhone to update their phone; guessing high would send someone on
 * iOS 15 through an install flow that ends in nothing. Declining to decide, and
 * then letting them try, is the only option that fails safely in both
 * directions.
 */
export function parseIosVersion(userAgent: string): IosVersion | null {
  // `OS 16_4 like Mac OS X` on iPhone and iPad; `Version/16.4` on the desktop-
  // mode string iPadOS sends. Underscores in the first form, dots in the second.
  const osMatch = /\bOS (\d+)[._](\d+)/.exec(userAgent);
  if (osMatch) {
    return { major: Number(osMatch[1]), minor: Number(osMatch[2]) };
  }

  const versionMatch = /\bVersion\/(\d+)\.(\d+)/.exec(userAgent);
  if (versionMatch) {
    return { major: Number(versionMatch[1]), minor: Number(versionMatch[2]) };
  }

  return null;
}
