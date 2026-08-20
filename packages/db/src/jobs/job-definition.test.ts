import { describe, expect, it } from "vitest";
import {
  DEDUPE_TO_QUEUE_POLICY,
  DEFAULT_EXPIRE_IN_SECONDS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RETRY_POLICY,
  JobDefinitionError,
  assertQueueName,
  deadLetterQueueName,
  defineJob,
  isDeadLetterQueueName,
} from "./job-definition.js";

/** Stands in for a Zod schema: the only thing a definition needs is parse(). */
const passthrough = { parse: (input: unknown) => input as { id: string } };

describe("defineJob defaults", () => {
  it("applies the ADR-004 retry policy: five retries with exponential backoff", () => {
    const job = defineJob({ name: "session.activate", payload: passthrough });

    expect(job.retry.retryLimit).toBe(5);
    expect(job.retry.retryBackoff).toBe(true);
    expect(job.retry).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("does not deduplicate unless a job asks for it", () => {
    // The alternative default would be worse: a `short` queue treats every
    // job without a key as the same job, so an unasked-for default would
    // silently collapse unrelated work.
    expect(defineJob({ name: "session.expire", payload: passthrough }).dedupe).toBe("none");
  });

  it("derives the dead-letter queue from the job name", () => {
    const job = defineJob({ name: "notification.send", payload: passthrough });

    expect(job.deadLetterQueue).toBe("notification.send.dlq");
    expect(deadLetterQueueName("notification.send")).toBe("notification.send.dlq");
    expect(isDeadLetterQueueName(job.deadLetterQueue)).toBe(true);
    expect(isDeadLetterQueueName(job.name)).toBe(false);
  });

  it("applies the default expiry and retention", () => {
    const job = defineJob({ name: "protocol.materialize", payload: passthrough });

    expect(job.expireInSeconds).toBe(DEFAULT_EXPIRE_IN_SECONDS);
    expect(job.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("is frozen, so a definition cannot drift between the two processes", () => {
    const job = defineJob({ name: "session.activate", payload: passthrough });

    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job.retry)).toBe(true);
  });
});

describe("defineJob overrides", () => {
  it("merges a partial retry policy over the default", () => {
    const job = defineJob({
      name: "subscription.prune",
      payload: passthrough,
      retry: { retryLimit: 2 },
    });

    expect(job.retry).toEqual({ retryLimit: 2, retryDelaySeconds: 30, retryBackoff: true });
  });

  it("accepts every deduplication mode and maps it to a queue policy", () => {
    expect(DEDUPE_TO_QUEUE_POLICY).toEqual({
      none: "standard",
      "while-queued": "short",
      "while-running": "singleton",
      "per-state": "stately",
    });

    const job = defineJob({
      name: "sweep.activate_due",
      payload: passthrough,
      dedupe: "while-running",
    });

    expect(DEDUPE_TO_QUEUE_POLICY[job.dedupe]).toBe("singleton");
  });
});

describe("defineJob rejects definitions that would misroute work", () => {
  it.each([
    ["an empty name", ""],
    ["an uppercase name", "Session.Activate"],
    ["a leading digit", "1session.activate"],
    ["whitespace", "session activate"],
    ["a trailing dot", "session."],
    ["a doubled dot", "session..activate"],
    ["a hyphen", "session-activate"],
    ["over 64 characters", `session.${"a".repeat(64)}`],
  ])("rejects %s", (_label, name) => {
    expect(() => defineJob({ name, payload: passthrough })).toThrow(JobDefinitionError);
  });

  it("rejects a name that collides with a dead-letter queue", () => {
    // Otherwise `x.dlq` and `x.dlq.dlq` would both exist and an operator
    // reading the ops page could not tell which queue failed.
    expect(() => defineJob({ name: "session.activate.dlq", payload: passthrough })).toThrow(
      /reserved/,
    );
  });

  it("rejects a payload schema without parse()", () => {
    expect(() =>
      defineJob({ name: "session.activate", payload: {} as { parse: (i: unknown) => unknown } }),
    ).toThrow(/parse/);
  });

  it.each([
    ["a negative retry limit", { retryLimit: -1 }],
    ["a fractional retry limit", { retryLimit: 1.5 }],
    ["a negative retry delay", { retryDelaySeconds: -5 }],
    ["backoff with a zero base delay", { retryDelaySeconds: 0, retryBackoff: true }],
  ])("rejects %s", (_label, retry) => {
    expect(() => defineJob({ name: "session.activate", payload: passthrough, retry })).toThrow(
      JobDefinitionError,
    );
  });

  it("allows a zero base delay when backoff is off", () => {
    const job = defineJob({
      name: "session.activate",
      payload: passthrough,
      retry: { retryDelaySeconds: 0, retryBackoff: false },
    });

    expect(job.retry.retryDelaySeconds).toBe(0);
  });

  it("allows retryLimit 0 for work that must never be retried", () => {
    expect(
      defineJob({ name: "session.activate", payload: passthrough, retry: { retryLimit: 0 } }).retry
        .retryLimit,
    ).toBe(0);
  });

  it.each([
    ["a zero expiry", { expireInSeconds: 0 }],
    ["a fractional expiry", { expireInSeconds: 1.5 }],
    ["a zero retention", { retentionDays: 0 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      defineJob({ name: "session.activate", payload: passthrough, ...overrides }),
    ).toThrow(JobDefinitionError);
  });
});

describe("assertQueueName", () => {
  it.each(["session.activate", "sweep.activate_due", "notification.send", "health"])(
    "accepts %s",
    (name) => {
      expect(() => assertQueueName(name)).not.toThrow();
    },
  );

  it("rejects a non-string", () => {
    expect(() => assertQueueName(undefined as unknown as string)).toThrow(JobDefinitionError);
  });
});
