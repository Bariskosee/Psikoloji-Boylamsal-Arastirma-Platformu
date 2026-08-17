import { describe, expect, it } from "vitest";
import { describeDbError } from "./client.js";

/**
 * A readiness failure with no stated reason is the worst kind: it appears
 * exactly when someone is trying to diagnose an outage. Every branch here must
 * produce a non-empty string.
 */
describe("describeDbError", () => {
  it("uses a plain error message", () => {
    expect(describeDbError(new Error("connection terminated"))).toBe("connection terminated");
  });

  it("unwraps AggregateError, whose own message is empty", () => {
    const ipv4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const ipv6 = Object.assign(new Error("connect ECONNREFUSED ::1:5432"), {
      code: "ECONNREFUSED",
    });
    const aggregate = new AggregateError([ipv4, ipv6]);

    expect(aggregate.message).toBe("");
    const described = describeDbError(aggregate);
    expect(described).toContain("ECONNREFUSED");
    expect(described).toContain("127.0.0.1");
    expect(described).toContain("::1");
  });

  it("deduplicates identical inner messages", () => {
    const aggregate = new AggregateError([new Error("same"), new Error("same")]);
    expect(describeDbError(aggregate)).toBe("same");
  });

  it("falls back to the error code when the message is empty", () => {
    const bare = Object.assign(new Error(""), { code: "ETIMEDOUT" });
    expect(describeDbError(bare)).toBe("Error: ETIMEDOUT");
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const input of [undefined, null, "", 0, {}, new Error(""), new AggregateError([])]) {
      expect(describeDbError(input)).not.toBe("");
    }
  });
});
