import type { PushPayload } from "@lpr/contracts";

/**
 * The push transport (ADR-006, PLAN.md Phase 9).
 *
 * One narrow interface with two implementations: `web-push` in production, and
 * a recording fake in tests. The seam exists because of what is on the other
 * side of it — a real HTTP call to Google, Apple or Mozilla. Without it, the
 * integration tests that matter most (completion racing an in-flight reminder,
 * the cap, the post-outage guard) would either need network access or would
 * have to be written against a mock of the whole handler, which would test the
 * mock.
 *
 * ── What this interface deliberately cannot express ─────────────────────────
 * Delivery. There is no `delivered` result, because there is no such
 * observation to make (FR-15, FR-19, ADR-006). The strongest thing a push
 * service tells us is that it ACCEPTED the message, and `ACCEPTED` is what this
 * returns. Naming it anything else would let a later caller — or a dashboard
 * column, or an export header — quietly claim something untrue.
 */

/**
 * Field names follow the Web Push spec and `PushSubscription.toJSON()`, which
 * is also what `pushSubscriptionKeysSchema` in `@lpr/contracts` uses. The
 * database columns are `p256dh_key` and `auth_key`; the wire shape is this.
 */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type PushSendResult =
  /** The push service took the message. NOT a delivery receipt. */
  | { readonly outcome: "ACCEPTED"; readonly statusCode: number }
  /**
   * 404 or 410. The subscription is permanently gone — the browser was
   * uninstalled, the participant cleared their data, the endpoint expired. The
   * caller must deactivate it and must not retry this occurrence.
   */
  | { readonly outcome: "GONE"; readonly statusCode: number }
  /** Anything else. Recorded, not retried; see the job definition for why. */
  | { readonly outcome: "FAILED"; readonly statusCode: number | null; readonly detail: string };

export interface PushTransport {
  send(target: PushTarget, payload: PushPayload): Promise<PushSendResult>;
}

export interface VapidCredentials {
  readonly publicKey: string;
  readonly privateKey: string;
  /** A `mailto:` or `https:` contact the push service can reach you at. */
  readonly subject: string;
}

/**
 * The real transport.
 *
 * `web-push` is imported lazily, inside the factory, for a specific reason: the
 * worker must boot and run its sweepers on a deployment with no VAPID keys
 * configured. Push is optional (ADR-006) and a study without it is degraded,
 * not broken — so a module-level import that failed to resolve, or a library
 * that validated its configuration at import time, would take the whole
 * reconciliation loop down over an optional feature.
 */
export async function createWebPushTransport(
  credentials: VapidCredentials,
): Promise<PushTransport> {
  const webpush = (await import("web-push")).default;

  webpush.setVapidDetails(credentials.subject, credentials.publicKey, credentials.privateKey);

  return {
    async send(target, payload) {
      try {
        const response = await webpush.sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          JSON.stringify(payload),
          {
            // How long the push service should hold the message for a device
            // that is offline. Deliberately short relative to a response
            // window: a reminder that surfaces hours later, after the
            // questionnaire has closed, is worse than one that never arrives —
            // it asks the participant to do something they now cannot.
            TTL: 3600,
          },
        );

        return { outcome: "ACCEPTED", statusCode: response.statusCode };
      } catch (error) {
        const statusCode = readStatusCode(error);

        // 404 Not Found and 410 Gone are the standard "this subscription is
        // finished" answers. They are not failures to retry; they are facts to
        // record, and the caller deactivates the row on the strength of them.
        if (statusCode === 404 || statusCode === 410) {
          return { outcome: "GONE", statusCode };
        }

        return {
          outcome: "FAILED",
          statusCode,
          // Message only, never the response body. A push service's error text
          // is not somewhere participant data should be able to arrive from,
          // and this string is written to a column an operator reads.
          detail: describe(error).slice(0, 300),
        };
      }
    },
  };
}

/**
 * A transport that records instead of sending.
 *
 * Used by every integration test, and by any deployment with no VAPID keys —
 * where its job is to make the absence of push explicit in the data rather than
 * silent. A study running without keys still produces `notification_attempts`
 * rows, so a researcher can see that outreach was attempted and why nothing
 * left the building.
 */
export class RecordingPushTransport implements PushTransport {
  readonly sent: { target: PushTarget; payload: PushPayload }[] = [];
  /** Endpoints this fake should answer `GONE` for, to exercise deactivation. */
  private readonly gone = new Set<string>();
  private failNext: string | null = null;

  markGone(endpoint: string): void {
    this.gone.add(endpoint);
  }

  failNextWith(detail: string): void {
    this.failNext = detail;
  }

  send(target: PushTarget, payload: PushPayload): Promise<PushSendResult> {
    if (this.gone.has(target.endpoint)) {
      return Promise.resolve({ outcome: "GONE", statusCode: 410 });
    }

    if (this.failNext !== null) {
      const detail = this.failNext;
      this.failNext = null;
      return Promise.resolve({ outcome: "FAILED", statusCode: 500, detail });
    }

    this.sent.push({ target, payload });
    return Promise.resolve({ outcome: "ACCEPTED", statusCode: 201 });
  }

  clear(): void {
    this.sent.length = 0;
    this.gone.clear();
    this.failNext = null;
  }
}

function readStatusCode(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
