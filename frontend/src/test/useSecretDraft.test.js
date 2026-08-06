/*
 * Tests for useSecretDraft.js — the shared row/validation logic behind the
 * secret form editor (create and edit). Pure functions, no mounting needed.
 *
 * We cover:
 *   - base64 validity checking (the base64 mode contract: the UI validates,
 *     the backend validates again at patch time)
 *   - seeding drafts from a detail in both value modes
 *   - validation errors: empty/invalid/duplicate keys, no keys, bad base64
 *   - change computation: adds, edits, deletes, binary preservation, and the
 *     base64-mode difference
 *   - the review summary counts
 */

import { describe, it, expect } from "vitest";
import {
  isValidBase64,
  newRow,
  seedRows,
  validateRows,
  rowsToMap,
  buildChanges,
  summarizeChanges,
} from "../useSecretDraft.js";

describe("isValidBase64", () => {
  it("accepts standard base64 including padding and the empty string", () => {
    expect(isValidBase64("")).toBe(true);
    expect(isValidBase64("YWRtaW4=")).toBe(true); // "admin"
    expect(isValidBase64("czNjcmV0")).toBe(true); // "s3cret" (no padding)
    expect(isValidBase64("aGVsbG8gd29ybGQ=")).toBe(true);
    expect(isValidBase64("aGk=")).toBe(true);
  });

  it("rejects non-base64 text, whitespace and wrong padding", () => {
    expect(isValidBase64("hello")).toBe(false);
    expect(isValidBase64("not base64!!")).toBe(false);
    expect(isValidBase64("YWRtaW4=")).toBe(true);
    expect(isValidBase64("Y WRtaW4=")).toBe(false);
    expect(isValidBase64("YQ=")).toBe(false); // length not multiple of 4
    expect(isValidBase64("YWRtaW4===")).toBe(false); // too much padding
  });
});

describe("seedRows", () => {
  const entries = [
    { key: "user", value: "admin", base64: "YWRtaW4=", isBinary: false },
    {
      key: "cert",
      value: "<11 bytes of binary data>",
      base64: "aGVsbG8gd29ybGQ=",
      isBinary: true,
    },
  ];

  it("seeds decoded values in transparent mode", () => {
    const rows = seedRows(entries, "transparent");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: "user",
      value: "admin",
      isNew: false,
      deleted: false,
    });
    expect(rows[1].value).toBe("<11 bytes of binary data>");
  });

  it("seeds raw base64 values in base64 mode", () => {
    const rows = seedRows(entries, "base64");
    expect(rows[0].value).toBe("YWRtaW4=");
    expect(rows[1].value).toBe("aGVsbG8gd29ybGQ=");
  });
});

describe("validateRows", () => {
  const base = () => [newRow({ key: "user", value: "admin", isNew: true })];

  it("passes a well-formed draft in transparent mode", () => {
    expect(validateRows(base(), "transparent")).toBe("");
  });

  it("requires valid base64 in base64 mode even for an otherwise good draft", () => {
    expect(validateRows(base(), "base64")).toMatch(/not valid base64/);
  });

  it("rejects an empty key name", () => {
    expect(
      validateRows([newRow({ key: "", value: "x" })], "transparent"),
    ).toMatch(/name/);
  });

  it("rejects keys with invalid characters", () => {
    expect(
      validateRows([newRow({ key: "bad key!", value: "x" })], "transparent"),
    ).toMatch(/invalid/i);
  });

  it("rejects duplicate keys", () => {
    const rows = base();
    rows.push(newRow({ key: "user", value: "other" }));
    expect(validateRows(rows, "transparent")).toMatch(/Duplicate/);
  });

  it("rejects a draft with every key removed", () => {
    const rows = base();
    rows[0].deleted = true;
    expect(validateRows(rows, "transparent")).toMatch(/at least one key/);
  });

  it("validates base64 in base64 mode only", () => {
    const rows = base();
    rows[0].value = "not base64!!";
    expect(validateRows(rows, "base64")).toMatch(/not valid base64/);
    expect(validateRows(rows, "transparent")).toBe(""); // transparent never checks
  });
});

describe("rowsToMap", () => {
  it("collects active rows, skipping deleted and empty keys", () => {
    const rows = [
      newRow({ key: "a", value: "1" }),
      newRow({ key: "b", value: "2" }),
    ];
    rows[1].deleted = true;
    rows.push(newRow({ key: " ", value: "3" }));
    expect(rowsToMap(rows)).toEqual({ a: "1" });
  });
});

describe("buildChanges", () => {
  const original = [
    { key: "keep", value: "same", base64: "c2FtZQ==", isBinary: false },
    { key: "edit", value: "old", base64: "b2xk", isBinary: false },
    { key: "bin", value: "<2 bytes>", base64: "aGk=", isBinary: true },
  ];

  it("reports only what changed in transparent mode", () => {
    const rows = seedRows(original, "transparent");
    rows.find((r) => r.key === "edit").value = "new";
    const changes = buildChanges(rows, original, "transparent");
    expect(changes).toEqual([{ key: "edit", value: "new", delete: false }]);
  });

  it("preserves binary values untouched in transparent mode", () => {
    const rows = seedRows(original, "transparent");
    rows.find((r) => r.key === "bin").value = "changed"; // user cannot, but guard anyway
    const changes = buildChanges(rows, original, "transparent");
    expect(changes.find((c) => c.key === "bin")).toBeUndefined();
  });

  it("diffs against base64 and allows binary edits in base64 mode", () => {
    const rows = seedRows(original, "base64");
    rows.find((r) => r.key === "bin").value = "aGVsbG8="; // "hello"
    rows.find((r) => r.key === "keep").value = "c2FtZQ=="; // unchanged
    const changes = buildChanges(rows, original, "base64");
    expect(changes).toEqual([{ key: "bin", value: "aGVsbG8=", delete: false }]);
  });

  it("adds new rows and deletes marked rows", () => {
    const rows = seedRows(original, "transparent");
    rows.find((r) => r.key === "keep").deleted = true;
    rows.push(newRow({ key: "fresh", value: "new" }));
    const changes = buildChanges(rows, original, "transparent");
    expect(changes).toContainEqual({ key: "keep", value: "", delete: true });
    expect(changes).toContainEqual({
      key: "fresh",
      value: "new",
      delete: false,
    });
  });

  it("produces no changes when nothing differs", () => {
    const rows = seedRows(original, "transparent");
    expect(buildChanges(rows, original, "transparent")).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  const original = [{ key: "a", value: "1", isBinary: false }];

  it("counts adds, changes and deletes and lists each key", () => {
    const changes = [
      { key: "a", value: "2", delete: false },
      { key: "b", value: "1", delete: false },
      { key: "c", value: "", delete: true },
    ];
    const s = summarizeChanges(changes, original);
    expect(s.added).toBe(1);
    expect(s.changed).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.list.map((l) => l.key)).toEqual(["a", "b", "c"]);
    expect(s.list.map((l) => l.kind)).toEqual(["change", "add", "delete"]);
  });
});
