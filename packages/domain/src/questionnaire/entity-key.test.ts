import { describe, expect, it } from "vitest";
import { ENTITY_KEY_BYTES, generateOptionKey, generateQuestionKey } from "./entity-key.js";

function bytes(fill: (index: number) => number, length = ENTITY_KEY_BYTES): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => fill(index));
}

describe("generateQuestionKey / generateOptionKey", () => {
  it("produces a stable, prefixed, fixed-length key from fixed bytes", () => {
    const key = generateQuestionKey(bytes(() => 0));
    expect(key).toBe("q_0000000000");
    expect(generateQuestionKey(bytes(() => 0))).toBe(key);
  });

  it("uses distinct prefixes for questions and options", () => {
    const input = bytes((i) => i);
    expect(generateQuestionKey(input).startsWith("q_")).toBe(true);
    expect(generateOptionKey(input).startsWith("o_")).toBe(true);
  });

  it("varies with the input bytes", () => {
    const a = generateQuestionKey(bytes(() => 1));
    const b = generateQuestionKey(bytes(() => 2));
    expect(a).not.toBe(b);
  });

  it("throws when fewer bytes are supplied than required", () => {
    expect(() => generateQuestionKey(bytes(() => 0, ENTITY_KEY_BYTES - 1))).toThrow();
  });

  it("only emits characters from the lowercase alphanumeric alphabet", () => {
    const key = generateQuestionKey(bytes((i) => i * 37));
    expect(key).toMatch(/^q_[0-9a-z]{10}$/);
  });
});
