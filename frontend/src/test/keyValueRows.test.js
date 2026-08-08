import { describe, it, expect } from "vitest";
import { addRow, removeRow, rowsToMap } from "../keyValueRows.js";

describe("addRow", () => {
  it("appends an empty key-value row to the array", () => {
    const rows = [{ key: "a", value: "1" }];
    addRow(rows);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ key: "", value: "" });
  });

  it("adds to an empty array", () => {
    const rows = [];
    addRow(rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: "", value: "" });
  });

  it("does not affect existing rows", () => {
    const rows = [{ key: "x", value: "y" }];
    addRow(rows);
    expect(rows[0]).toEqual({ key: "x", value: "y" });
  });

  it("mutates the original array in place", () => {
    const rows = [];
    const result = addRow(rows);
    expect(result).toBeUndefined(); // no return value
    expect(rows).toHaveLength(1);
  });
});

describe("removeRow", () => {
  it("removes the row at the given index", () => {
    const rows = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
      { key: "c", value: "3" },
    ];
    removeRow(rows, 1);
    expect(rows).toEqual([
      { key: "a", value: "1" },
      { key: "c", value: "3" },
    ]);
  });

  it("removes the first row", () => {
    const rows = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    removeRow(rows, 0);
    expect(rows).toEqual([{ key: "b", value: "2" }]);
  });

  it("removes the last row", () => {
    const rows = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    removeRow(rows, 1);
    expect(rows).toEqual([{ key: "a", value: "1" }]);
  });

  it("removes the only row, leaving an empty array", () => {
    const rows = [{ key: "a", value: "1" }];
    removeRow(rows, 0);
    expect(rows).toEqual([]);
  });
});

describe("rowsToMap", () => {
  it("converts rows to a plain object", () => {
    const rows = [
      { key: "app", value: "web" },
      { key: "env", value: "prod" },
    ];
    expect(rowsToMap(rows)).toEqual({ app: "web", env: "prod" });
  });

  it("trims keys", () => {
    const rows = [{ key: "  app ", value: "web" }];
    expect(rowsToMap(rows)).toEqual({ app: "web" });
  });

  it("skips rows with empty keys", () => {
    const rows = [
      { key: "", value: "should-be-skipped" },
      { key: "valid", value: "kept" },
      { key: "   ", value: "also-skipped" },
    ];
    expect(rowsToMap(rows)).toEqual({ valid: "kept" });
  });

  it("returns empty object for empty array", () => {
    expect(rowsToMap([])).toEqual({});
  });

  it("returns empty object when all keys are blank", () => {
    const rows = [
      { key: "", value: "a" },
      { key: "   ", value: "b" },
    ];
    expect(rowsToMap(rows)).toEqual({});
  });

  it("does not mutate the input array", () => {
    const rows = [{ key: "a", value: "1" }];
    const copy = [...rows];
    rowsToMap(rows);
    expect(rows).toEqual(copy);
  });
});
