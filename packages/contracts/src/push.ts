import { z } from "zod";

/**
 * Push subscriptions and the install handoff (PLAN.md Phase 8, ADR-006, ADR-007).
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * The VAPID **private** key, and the push endpoint itself on every response
 * shape. The endpoint is a per-device URL at a push service: it is
 * re-identifying data (STRUCTURE.md §11.1), it lives in the `identity` schema,
 * and nothing that a researcher UI or an export could reach may carry it. The
 * participant's own settings screen does not need it either — "this device is
 * receiving notifications" is the fact it has to show, and an opaque
 * subscription id plus a timestamp says that without publishing the endpoint.
 *
 * The handoff code is the one secret in this file that appears in a URL, and
 * ADR-007 sets out why that is acceptable for this artefact and for nothing
 * else: single-use, 24-hour TTL, rate-limited, and worth nothing once redeemed.
 */

/**
 * Which storage container a credential was minted in (ADR-007, STRUCTURE.md §11.4).
 *
 * On iOS the Home-Screen application and the Safari tab can hold separate
 * cookie stores, so a participant who enrolled in Safari and then installed
 * would present as a new person. Recording where each credential was born is
 * what lets a researcher see, before the data is lost, which participants have
 * only ever been reachable in a browser tab.
 */
export const CREDENTIAL_CONTEXTS = ["BROWSER", "INSTALLED"] as const;
export const credentialContextSchema = z.enum(CREDENTIAL_CONTEXTS);
export type CredentialContext = z.infer<typeof credentialContextSchema>;

/**
 * A push endpoint URL.
 *
 * Bounded because it is stored and indexed, and because an unbounded string
 * arriving at an unauthenticated-adjacent endpoint is a cheap way to fill a
 * table. Push services issue endpoints well under this; 2048 is the
 * conventional URL ceiling rather than a limit anyone will meet.
 *
 * `https` only. A push endpoint is a capability URL — anyone holding it can ask
 * the push service to wake this participant's device — and accepting a plain
 * `http` one would mean handing that capability to the network.
 */
export const pushEndpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), {
    message: "A push endpoint must be an https URL",
  });

/**
 * The two keys the browser derives for message encryption.
 *
 * They are the participant's half of the ECDH exchange that makes a push
 * payload unreadable to the push service carrying it. Base64url, and validated
 * as such here so a malformed pair is refused at registration rather than
 * discovered by a send failing in Phase 9.
 */
const base64UrlSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);

export const pushSubscriptionKeysSchema = z.object({
  p256dh: base64UrlSchema,
  auth: base64UrlSchema,
});

/**
 * What the browser hands us from `PushManager.subscribe()`.
 *
 * Shaped to match the `PushSubscription.toJSON()` the client already has, so
 * the participant app forwards it rather than reassembling it — reassembly is
 * where a key gets truncated and the failure only appears months later, when a
 * reminder does not arrive.
 */
export const registerPushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: pushSubscriptionKeysSchema,
  /**
   * Milliseconds since the epoch, when the push service has told the browser
   * this subscription will stop working. Almost always null — Chrome and
   * Firefox leave it unset — which is why expiry cannot be the only way a dead
   * subscription is noticed.
   */
  expirationTime: z.number().int().positive().nullable().default(null),
});

export type RegisterPushSubscriptionRequest = z.infer<typeof registerPushSubscriptionSchema>;

/**
 * One registered device, as the participant's own settings screen sees it.
 *
 * No endpoint, no keys. The id is this row's primary key, which the client
 * needs only to say "remove this one".
 */
export const pushSubscriptionSummarySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /**
   * Where the credential that registered it was minted. A participant looking
   * at "Safari" against their only subscription is being told, truthfully, that
   * notifications will stop if they clear that browser.
   */
  credentialContext: credentialContextSchema,
});

export type PushSubscriptionSummary = z.infer<typeof pushSubscriptionSummarySchema>;

export const pushSubscriptionListSchema = z.object({
  subscriptions: z.array(pushSubscriptionSummarySchema),
});

export type PushSubscriptionListResponse = z.infer<typeof pushSubscriptionListSchema>;

/**
 * What the client needs before it can subscribe at all.
 *
 * `vapidPublicKey` is null when the deployment has no VAPID key configured. The
 * client must treat that as "push is unavailable here" and carry on — a study
 * running without push is a degraded study, not a broken one (ADR-006), and the
 * onboarding screen has to be able to say so rather than failing silently at
 * the moment the participant taps Enable.
 */
export const pushConfigSchema = z.object({
  vapidPublicKey: z.string().nullable(),
});

export type PushConfigResponse = z.infer<typeof pushConfigSchema>;

export const unregisterPushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
});

export type UnregisterPushSubscriptionRequest = z.infer<typeof unregisterPushSubscriptionSchema>;

/**
 * The install handoff code (STRUCTURE.md §11.4).
 *
 * 128 bits, hex. Hex rather than the Crockford base-32 used for recovery codes
 * because nobody types this one — it is a link the participant taps inside the
 * freshly installed application — so the alphabet only has to be URL-safe and
 * unambiguous in a path segment.
 */
export const handoffCodeSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const handoffMintResponseSchema = z.object({
  code: handoffCodeSchema,
  expiresAt: z.string(),
});

export type HandoffMintResponse = z.infer<typeof handoffMintResponseSchema>;

export const handoffRedeemRequestSchema = z.object({
  code: handoffCodeSchema,
});

export type HandoffRedeemRequest = z.infer<typeof handoffRedeemRequestSchema>;
