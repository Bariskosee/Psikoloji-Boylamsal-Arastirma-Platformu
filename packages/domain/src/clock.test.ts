import { describe, expect, it } from "vitest";
import { fixedClock, mutableClock } from "./clock.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("fixedClock", () => {
  it("returns the supplied instant every time", () => {
    const clock = fixedClock(T0);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("mutableClock", () => {
  it("starts at the supplied instant", () => {
    expect(mutableClock(T0).now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("advances by whole days without drifting", () => {
    const clock = mutableClock(T0);
    clock.advanceBy(72 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2026-01-04T00:00:00.000Z");
  });

  it("jumps to an arbitrary instant", () => {
    const clock = mutableClock(T0);
    clock.set(new Date("2026-03-15T18:30:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-03-15T18:30:00.000Z");
  });
});
