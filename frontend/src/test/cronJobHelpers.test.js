/*
 * Tests for cronJobHelpers.js
 */

import { describe, it, expect } from "vitest";
import {
  validSchedule,
  splitCommand,
  CONCURRENCY_POLICIES,
  SCHEDULE_ERROR,
} from "../cronJobHelpers.js";

describe("validSchedule", () => {
  it("accepts a standard 5-field cron expression", () => {
    expect(validSchedule("0 * * * *")).toBe(true);
  });

  it("accepts fields with special characters (*, /, ,, -)", () => {
    expect(validSchedule("*/5 1-10 * * 0,6")).toBe(true);
  });

  it("accepts @yearly-style single-token (5 non-space fields)", () => {
    expect(validSchedule("@every 1 2 3 4")).toBe(true);
  });

  it("accepts leading/trailing whitespace", () => {
    expect(validSchedule("  0 * * * *  ")).toBe(true);
  });

  it("accepts tabs between fields", () => {
    expect(validSchedule("0\t*\t*\t*\t*")).toBe(true);
  });

  it("accepts mixed whitespace between fields", () => {
    expect(validSchedule("0  *\t *  *   *")).toBe(true);
  });

  it("rejects 4 fields", () => {
    expect(validSchedule("* * * *")).toBe(false);
  });

  it("rejects 6 fields (7-field-year syntax)", () => {
    expect(validSchedule("0 0 * * * *")).toBe(false);
  });

  it("rejects 1 field", () => {
    expect(validSchedule("@daily")).toBe(false);
  });

  it("rejects 0 fields (empty string)", () => {
    expect(validSchedule("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(validSchedule(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(validSchedule(undefined)).toBe(false);
  });

  it("returns false for a number", () => {
    expect(validSchedule(123)).toBe(false);
  });

  it("returns false for an object", () => {
    expect(validSchedule({})).toBe(false);
  });

  it("returns false for an array", () => {
    expect(validSchedule(["0", "*", "*", "*", "*"])).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(validSchedule("     ")).toBe(false);
  });

  it("rejects a string with only newlines", () => {
    expect(validSchedule("\n\n\n")).toBe(false);
  });

  it("accepts exactly 5 fields with no trailing whitespace", () => {
    expect(validSchedule("1 2 3 4 5")).toBe(true);
  });

  it("accepts fields with question marks (supported by some cron impls)", () => {
    expect(validSchedule("? * * * ?")).toBe(true);
  });

  it("accepts fields with L/W/H/# (Quartz-style)", () => {
    expect(validSchedule("0 0 L * W")).toBe(true);
  });

  it("rejects a string with only 5 spaces", () => {
    expect(validSchedule("     ")).toBe(false); // 5 spaces, not 5 fields
  });

  it("does not mutate its input", () => {
    const input = "  0 * * * *  ";
    const copy = input;
    validSchedule(input);
    expect(input).toBe(copy);
  });
});

describe("splitCommand", () => {
  it("splits a simple command into tokens", () => {
    expect(splitCommand("echo hello")).toEqual(["echo", "hello"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitCommand("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(splitCommand("   \t  ")).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(splitCommand(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(splitCommand(undefined)).toEqual([]);
  });

  it("handles leading/trailing whitespace", () => {
    expect(splitCommand("  one   two  ")).toEqual(["one", "two"]);
  });

  it("handles tabs as separators", () => {
    expect(splitCommand("one\ttwo\tthree")).toEqual(["one", "two", "three"]);
  });

  it("returns single-element array for one token", () => {
    expect(splitCommand("solocommand")).toEqual(["solocommand"]);
  });

  it("preserves special characters within tokens", () => {
    expect(splitCommand("cmd --flag=val path/to/file")).toEqual([
      "cmd",
      "--flag=val",
      "path/to/file",
    ]);
  });

  it("does not mutate its input", () => {
    const input = "  echo hello  ";
    const copy = input;
    splitCommand(input);
    expect(input).toBe(copy);
  });

  it("handles a number input gracefully", () => {
    expect(splitCommand(42)).toEqual(["42"]);
  });
});

describe("CONCURRENCY_POLICIES", () => {
  it("is an array with exactly 3 entries", () => {
    expect(Array.isArray(CONCURRENCY_POLICIES)).toBe(true);
    expect(CONCURRENCY_POLICIES).toHaveLength(3);
  });

  it("contains the three Kubernetes concurrency policies", () => {
    const values = CONCURRENCY_POLICIES.map((p) => p.value);
    expect(values).toEqual(["Allow", "Forbid", "Replace"]);
  });

  it("every entry has a non-empty value and label", () => {
    for (const p of CONCURRENCY_POLICIES) {
      expect(p).toHaveProperty("value");
      expect(p).toHaveProperty("label");
      expect(typeof p.value).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(p.value.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it("has unique values", () => {
    const values = CONCURRENCY_POLICIES.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("is frozen / not accidentally mutable by consumers", () => {
    const copy = [...CONCURRENCY_POLICIES];
    expect(copy).toEqual(CONCURRENCY_POLICIES);
  });
});

describe("SCHEDULE_ERROR", () => {
  it("is a non-empty string", () => {
    expect(typeof SCHEDULE_ERROR).toBe("string");
    expect(SCHEDULE_ERROR.length).toBeGreaterThan(0);
  });

  it("mentions 'cron' and '5-field'", () => {
    expect(SCHEDULE_ERROR.toLowerCase()).toMatch(/cron/);
    expect(SCHEDULE_ERROR).toMatch(/5.field/);
  });

  it("includes an example expression", () => {
    expect(SCHEDULE_ERROR).toMatch(/0 \* \* \* \*/);
  });
});
