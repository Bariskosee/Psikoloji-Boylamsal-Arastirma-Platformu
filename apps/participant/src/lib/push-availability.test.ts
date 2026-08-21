import { describe, expect, it } from "vitest";
import {
  IOS_PUSH_MIN_VERSION,
  classifyPushAvailability,
  detectPlatform,
  isRecoverable,
  mayRequestPermission,
  parseIosVersion,
  type PushEnvironment,
} from "./push-availability";

/**
 * The push availability matrix (PLAN.md Phase 8, FR-16, ADR-006).
 *
 * The iOS rows carry the weight. None of them reproduces on a development
 * machine — there is no desktop browser that behaves like Safari on an iPhone —
 * so if they are not asserted here they are asserted by a participant, months
 * into a study, by silently receiving nothing.
 */

/** A modern Android browser: everything present, nothing asked yet. */
const ANDROID: PushEnvironment = {
  platform: "ANDROID",
  iosVersion: null,
  isStandalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: "default",
  vapidConfigured: true,
};

function environment(overrides: Partial<PushEnvironment>): PushEnvironment {
  return { ...ANDROID, ...overrides };
}

describe("classifying push availability", () => {
  it("is READY on a supported browser that has not been asked", () => {
    expect(classifyPushAvailability(ANDROID)).toBe("READY");
    expect(mayRequestPermission("READY")).toBe(true);
  });

  it("is ENABLED once permission is granted", () => {
    expect(classifyPushAvailability(environment({ permission: "granted" }))).toBe("ENABLED");
  });

  it("is BLOCKED when the participant refused, and offers no button", () => {
    const availability = classifyPushAvailability(environment({ permission: "denied" }));

    expect(availability).toBe("BLOCKED");
    // The browser would refuse a second prompt anyway; showing a control that
    // cannot work is how an application teaches people it is broken.
    expect(mayRequestPermission(availability)).toBe(false);
    // Recoverable, because OS settings can undo it — the screen should say how.
    expect(isRecoverable(availability)).toBe(true);
  });

  it("is UNSUPPORTED where there is no Push API and no install to suggest", () => {
    expect(classifyPushAvailability(environment({ hasPushManager: false }))).toBe("UNSUPPORTED");
    expect(classifyPushAvailability(environment({ hasServiceWorker: false }))).toBe("UNSUPPORTED");
    expect(classifyPushAvailability(environment({ hasNotification: false }))).toBe("UNSUPPORTED");
    expect(isRecoverable("UNSUPPORTED")).toBe(false);
  });

  it("is NOT_CONFIGURED before anything else when the deployment has no VAPID key", () => {
    // Checked first deliberately: with no key nothing can ever be sent, so
    // collecting a subscription would be collecting a device identifier we have
    // already decided we will never use.
    const availability = classifyPushAvailability(
      environment({ vapidConfigured: false, permission: "granted" }),
    );

    expect(availability).toBe("NOT_CONFIGURED");
    expect(mayRequestPermission(availability)).toBe(false);
    expect(isRecoverable(availability)).toBe(false);
  });
});

describe("the iOS matrix — the reason this file exists", () => {
  const IOS_TAB: Partial<PushEnvironment> = {
    platform: "IOS",
    iosVersion: { major: 17, minor: 2 },
    isStandalone: false,
    // In a Safari tab on iOS these are genuinely absent, whatever the version.
    hasPushManager: false,
    hasNotification: false,
  };

  it("tells an iOS browser tab to install, not that it is unsupported", () => {
    // The single highest-value branch: this participant is one Add to Home
    // Screen away from full push support, and `UNSUPPORTED` — which is what a
    // pure feature check produces here — would be true and useless.
    expect(classifyPushAvailability(environment(IOS_TAB))).toBe("REQUIRES_INSTALL");
  });

  it("still says install when the tab's permission is denied", () => {
    // The tab's permission state says nothing about the installed
    // application's. Reporting BLOCKED would send them to Settings to fix
    // something that is not broken, and never mention the actual remedy.
    expect(classifyPushAvailability(environment({ ...IOS_TAB, permission: "denied" }))).toBe(
      "REQUIRES_INSTALL",
    );
  });

  it("is READY in the installed application on a supported iOS", () => {
    expect(
      classifyPushAvailability(
        environment({
          platform: "IOS",
          iosVersion: { major: 16, minor: 4 },
          isStandalone: true,
          hasPushManager: true,
          hasNotification: true,
        }),
      ),
    ).toBe("READY");
  });

  it("asks for an OS upgrade below 16.4, before suggesting an install", () => {
    // Installing on 16.3 succeeds and still yields no push. Sending someone
    // through Add to Home Screen for nothing is worse than telling them why.
    expect(
      classifyPushAvailability(environment({ ...IOS_TAB, iosVersion: { major: 16, minor: 3 } })),
    ).toBe("REQUIRES_IOS_UPGRADE");

    expect(
      classifyPushAvailability(environment({ ...IOS_TAB, iosVersion: { major: 15, minor: 7 } })),
    ).toBe("REQUIRES_IOS_UPGRADE");
  });

  it("treats exactly 16.4 as supported", () => {
    expect(IOS_PUSH_MIN_VERSION).toEqual({ major: 16, minor: 4 });
    expect(
      classifyPushAvailability(environment({ ...IOS_TAB, iosVersion: IOS_PUSH_MIN_VERSION })),
    ).toBe("REQUIRES_INSTALL");
  });

  it("lets an unreadable iOS version try rather than guessing", () => {
    // Guessing low tells someone on a current iPhone to update it; guessing
    // high sends someone on iOS 15 through an install that ends in nothing.
    expect(classifyPushAvailability(environment({ ...IOS_TAB, iosVersion: null }))).toBe(
      "REQUIRES_INSTALL",
    );
  });
});

describe("reading the platform off a user agent", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
  const IPAD_DESKTOP_MODE =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/16.4 Safari/605.1.15";
  const MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const PIXEL =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

  it("recognises an iPhone", () => {
    expect(detectPlatform(IPHONE)).toBe("IOS");
    expect(parseIosVersion(IPHONE)).toEqual({ major: 17, minor: 2 });
  });

  it("recognises an iPad that claims to be a Macintosh", () => {
    // iPadOS sends a desktop user agent. Without the touch-point check every
    // iPad participant is told their browser is unsupported and never sees the
    // install guidance that would have worked.
    expect(detectPlatform(IPAD_DESKTOP_MODE, 5)).toBe("IOS");
    expect(parseIosVersion(IPAD_DESKTOP_MODE)).toEqual({ major: 16, minor: 4 });
  });

  it("does not mistake a real Mac for an iPad", () => {
    expect(detectPlatform(MAC, 0)).toBe("OTHER");
  });

  it("recognises Android", () => {
    expect(detectPlatform(PIXEL)).toBe("ANDROID");
    expect(parseIosVersion(PIXEL)).toBeNull();
  });
});
