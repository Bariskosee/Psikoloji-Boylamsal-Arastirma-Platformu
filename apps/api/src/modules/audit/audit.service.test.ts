import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, redact } from "./audit.service.js";

describe("redact", () => {
  it("keeps ordinary context, which is the point of metadata", () => {
    expect(redact({ from: "DRAFT", to: "ACTIVE", fields: ["name"] })).toEqual({
      from: "DRAFT",
      to: "ACTIVE",
      fields: ["name"],
    });
  });

  it("removes credentials whatever their casing", () => {
    expect(redact({ password: "hunter2", NewPassword: "x", token: "t" })).toEqual({
      password: "[redacted]",
      NewPassword: "[redacted]",
      token: "[redacted]",
    });
  });

  it("removes response payloads, which must never enter the trail", () => {
    // STRUCTURE.md §6: an audit row records that an action happened, never
    // what a participant answered.
    expect(redact({ answers: [1, 2, 3], response: "x", value: 7 })).toEqual({
      answers: "[redacted]",
      response: "[redacted]",
      value: "[redacted]",
    });
  });

  it("removes push subscription material nested one level down", () => {
    expect(redact({ subscription: { endpoint: "https://push", keys: { p256dh: "k" } } })).toEqual({
      subscription: { endpoint: "[redacted]", keys: "[redacted]" },
    });
  });

  it("stops recursing rather than following a deep structure forever", () => {
    // Four levels are kept; anything deeper is dropped rather than walked, so
    // a cyclic or hostile structure cannot turn one audit write into a hang.
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    expect(redact(deep)).toEqual({ a: { b: { c: { d: {} } } } });
  });
});

describe("audit cursor", () => {
  const occurredAt = new Date("2026-08-18T09:30:00.000Z");
  const id = "6f1c9a0e-2c1a-4a1e-9a0e-2c1a4a1e9a0e";

  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(occurredAt, id))).toEqual({ occurredAt, id });
  });

  it("carries the id as a tie-break, so same-millisecond events cannot be skipped", () => {
    // Two events in one millisecond would make a timestamp-only cursor
    // ambiguous — and a paginated audit log that skips a row is worse than a
    // slow one.
    expect(encodeCursor(occurredAt, "a")).not.toBe(encodeCursor(occurredAt, "b"));
  });

  it("treats a malformed cursor as the first page rather than an error", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(Buffer.from("garbage", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("nonsense|id", "utf8").toString("base64url"))).toBeNull();
  });
});
