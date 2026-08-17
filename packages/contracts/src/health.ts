import { z } from "zod";

/** Liveness: the process is up and serving. Says nothing about dependencies. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** One dependency's reachability, as reported by /ready. */
export const dependencyCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * Readiness: every dependency this process needs is reachable.
 * Returns HTTP 503 when `ready` is false, so a load balancer can drain traffic.
 */
export const readyResponseSchema = z.object({
  ready: z.boolean(),
  service: z.string(),
  checks: z.array(dependencyCheckSchema),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
