import { describe, it, expect } from "vitest";
import { applyLogTemplate, extractJsonFields } from "../logTemplate.js";

describe("applyLogTemplate - basic reordering", () => {
  it("puts the template fields first in template order", () => {
    const line = '{"ts":1,"level":"info","msg":"hello"}';
    const { text, reason } = applyLogTemplate(line, ["msg", "level", "ts"]);
    expect(reason).toBe("ok");
    expect(text).toBe('{"msg":"hello", "level":"info", "ts":1}');
  });

  it("appends fields missing from the template in their original order", () => {
    const line = '{"ts":1,"extra":{"a":1},"msg":"x"}';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('{"msg":"x", "ts":1, "extra":{"a":1}}');
  });

  it("ignores template fields the line does not have", () => {
    const { text } = applyLogTemplate('{"msg":"x","ts":1}', [
      "missing",
      "msg",
      "also-missing",
    ]);
    expect(text).toBe('{"msg":"x", "ts":1}');
  });

  it("returns the original line when no template field overlaps", () => {
    const line = '{"a":1,"b":2}';
    const { text, reason } = applyLogTemplate(line, ["msg", "ts"]);
    expect(reason).toBe("no-overlap");
    expect(text).toBe(line);
  });

  it("reorders an empty object trivially as no-overlap", () => {
    const { text, reason } = applyLogTemplate("{}", ["msg"]);
    expect(reason).toBe("no-overlap");
    expect(text).toBe("{}");
  });
});

describe("applyLogTemplate - byte preservation", () => {
  it("keeps big integers exactly as written (no JS number rounding)", () => {
    const line = '{"id":9007199254740993,"msg":"x"}';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('{"msg":"x", "id":9007199254740993}');
    // The rounded value must not appear anywhere.
    expect(text).not.toContain("9007199254740992");
  });

  it("keeps nested values byte-for-byte, including their inner spacing", () => {
    const line = '{"ts": 1, "data": {"a" : 2, "b": [1, 2]}, "msg":"m"}';
    const { text } = applyLogTemplate(line, ["msg", "data"]);
    // Only the top-level spacing around ":" is normalised; the nested object
    // keeps every interior byte, including its own "a" : 2 spacing.
    expect(text).toBe('{"msg":"m", "data":{"a" : 2, "b": [1, 2]}, "ts":1}');
  });

  it("handles escaped quotes, braces and backslashes inside strings", () => {
    const line = String.raw`{"msg":"a } { \"quoted\" \\ end","ts":1}`;
    const { text, reason } = applyLogTemplate(line, ["msg", "ts"]);
    expect(reason).toBe("ok");
    expect(text).toBe(String.raw`{"msg":"a } { \"quoted\" \\ end", "ts":1}`);
  });

  it("keeps unicode strings intact", () => {
    const line = '{"msg":"héllo 🌍","ts":1}';
    const { text } = applyLogTemplate(line, ["msg", "ts"]);
    expect(text).toBe('{"msg":"héllo 🌍", "ts":1}');
  });

  it("normalises only top-level spacing, not value content", () => {
    const line = '{ "ts" : 1 , "msg" : "x" }';
    const { text } = applyLogTemplate(line, ["msg", "ts"]);
    expect(text).toBe('{"msg":"x", "ts":1}');
  });

  it("keeps duplicate keys in their original relative order", () => {
    const line = '{"a":1,"a":2,"msg":"m"}';
    const { text } = applyLogTemplate(line, ["msg", "a"]);
    expect(text).toBe('{"msg":"m", "a":1, "a":2}');
  });
});

describe("applyLogTemplate - surrounded JSON", () => {
  it("keeps an RFC3339 timestamp prefix (Kubernetes Timestamps option)", () => {
    const line = '2024-06-01T10:00:00.000000000Z {"ts":1,"msg":"m"}';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('2024-06-01T10:00:00.000000000Z {"msg":"m", "ts":1}');
  });

  it("keeps a klog-style prefix and a trailing suffix", () => {
    const line = 'I0714 10:00:00.000000 1 file.go:123] {"ts":1,"msg":"m"} done';
    const { text } = applyLogTemplate(line, ["msg"]);
    expect(text).toBe(
      'I0714 10:00:00.000000 1 file.go:123] {"msg":"m", "ts":1} done',
    );
  });
});

describe("applyLogTemplate - non-JSON fallbacks", () => {
  it("leaves plain text untouched", () => {
    const line = "this is a plain log line";
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("not-json");
    expect(text).toBe(line);
  });

  it("leaves invalid JSON untouched", () => {
    const line = '{broken json, "msg":"x"';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("not-json");
    expect(text).toBe(line);
  });

  it("leaves JSON arrays and scalars untouched", () => {
    for (const line of ["[1,2,3]", "42", '"just a string"', "null"]) {
      const { text, reason } = applyLogTemplate(line, ["msg"]);
      expect(reason).toBe("not-json");
      expect(text).toBe(line);
    }
  });

  it("leaves empty and whitespace-only lines untouched", () => {
    for (const line of ["", "   "]) {
      const { text, reason } = applyLogTemplate(line, ["msg"]);
      expect(reason).toBe("not-json");
      expect(text).toBe(line);
    }
  });

  it("does not confuse braces inside a non-JSON prefix", () => {
    const line = "elapsed={cpu=1} plain text";
    const { text, reason } = applyLogTemplate(line, ["cpu"]);
    expect(reason).toBe("not-json");
    expect(text).toBe(line);
  });

  it("treats a missing fieldOrder as no template", () => {
    const line = '{"ts":1,"msg":"x"}';
    const { text, reason } = applyLogTemplate(line, undefined);
    expect(reason).toBe("no-overlap");
    expect(text).toBe(line);
  });
});

describe("applyLogTemplate - large lines", () => {
  it("handles a line whose value approaches the log chunk size", () => {
    const payload = "x".repeat(70000);
    const line = `{"msg":"${payload}","ts":1}`;
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe(`{"msg":"${payload}", "ts":1}`);
  });
});

describe("applyLogTemplate - extra edge cases", () => {
  it("keeps whitespace surrounding the JSON object", () => {
    const line = '   {"ts":1,"msg":"m"}   ';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('   {"msg":"m", "ts":1}   ');
  });

  it("matches unicode-escaped keys while preserving their raw bytes", () => {
    const line = String.raw`{"\u006d\u0073\u0067":"m","ts":1}`;
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe(String.raw`{"\u006d\u0073\u0067":"m", "ts":1}`);
  });

  it("keeps an empty-string key in the tail", () => {
    const line = '{"":"v","msg":"m"}';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('{"msg":"m", "":"v"}');
  });

  it("treats a whitespace-only object as no-overlap", () => {
    const { text, reason } = applyLogTemplate("{  }", ["msg"]);
    expect(reason).toBe("no-overlap");
    expect(text).toBe("{  }");
  });

  it("tolerates duplicate entries in the template field order", () => {
    const line = '{"ts":1,"msg":"m","level":"i"}';
    const { text, reason } = applyLogTemplate(line, ["msg", "msg", "ts"]);
    expect(reason).toBe("ok");
    expect(text).toBe('{"msg":"m", "ts":1, "level":"i"}');
  });

  it("handles a string value ending in an escaped backslash", () => {
    const line = String.raw`{"msg":"trail\\","ts":1}`;
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe(String.raw`{"msg":"trail\\", "ts":1}`);
  });

  it("reorders the JSON object inside an array element", () => {
    const line = '[{"ts":1,"msg":"m"}]';
    const { text, reason } = applyLogTemplate(line, ["msg"]);
    expect(reason).toBe("ok");
    expect(text).toBe('[{"msg":"m", "ts":1}]');
  });
});

describe("extractJsonFields", () => {
  it("returns the top-level keys in original order, deduplicated", () => {
    const got = extractJsonFields('{"ts":1,"msg":"m","ts":2,"nested":{"b":1}}');
    expect(got.keys).toEqual(["ts", "msg", "nested"]);
    expect(got.sample).toBe('{"ts":1,"msg":"m","ts":2,"nested":{"b":1}}');
  });

  it("extracts only the JSON object from a prefixed line", () => {
    const got = extractJsonFields('2024-01-01T00:00:00Z {"msg":"m","ts":1}');
    expect(got.keys).toEqual(["msg", "ts"]);
    expect(got.sample).toBe('{"msg":"m","ts":1}');
  });

  it("returns null for lines without a JSON object", () => {
    for (const line of ["plain text", "[1,2]", "", "{broken"]) {
      expect(extractJsonFields(line)).toBeNull();
    }
  });
});
