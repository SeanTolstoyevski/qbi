/*
 * Tests for kubeValidation.js — shared Kubernetes naming validators.
 */

import { describe, it, expect } from "vitest";
import {
  DNS_LABEL_RE,
  DNS_SUBDOMAIN_RE,
  LABEL_VALUE_RE,
  validateName,
  qualifiedNameError,
  labelValueError,
} from "../kubeValidation.js";

// ── DNS_LABEL_RE ────────────────────────────────────────────────────────────

describe("DNS_LABEL_RE", () => {
  it("accepts a simple lowercase name", () => {
    expect(DNS_LABEL_RE.test("my-deployment")).toBe(true);
  });

  it("accepts a single character", () => {
    expect(DNS_LABEL_RE.test("a")).toBe(true);
  });

  it("accepts digits", () => {
    expect(DNS_LABEL_RE.test("app1")).toBe(true);
  });

  it("accepts hyphens in the middle", () => {
    expect(DNS_LABEL_RE.test("my-app-v2")).toBe(true);
  });

  it("accepts names ending with a digit", () => {
    expect(DNS_LABEL_RE.test("nginx-123")).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(DNS_LABEL_RE.test("MyApp")).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(DNS_LABEL_RE.test("-myapp")).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(DNS_LABEL_RE.test("myapp-")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(DNS_LABEL_RE.test("my_app")).toBe(false);
  });

  it("rejects dots", () => {
    expect(DNS_LABEL_RE.test("my.app")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(DNS_LABEL_RE.test("")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(DNS_LABEL_RE.test("my app")).toBe(false);
  });
});

// ── DNS_SUBDOMAIN_RE ────────────────────────────────────────────────────────

describe("DNS_SUBDOMAIN_RE", () => {
  it("accepts a simple hostname", () => {
    expect(DNS_SUBDOMAIN_RE.test("example.com")).toBe(true);
  });

  it("accepts a single label", () => {
    expect(DNS_SUBDOMAIN_RE.test("myservice")).toBe(true);
  });

  it("accepts multiple subdomains", () => {
    expect(DNS_SUBDOMAIN_RE.test("a.b.c.example.com")).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(DNS_SUBDOMAIN_RE.test("Example.com")).toBe(false);
  });

  it("rejects leading dot", () => {
    expect(DNS_SUBDOMAIN_RE.test(".example.com")).toBe(false);
  });

  it("rejects trailing dot", () => {
    expect(DNS_SUBDOMAIN_RE.test("example.com.")).toBe(false);
  });

  it("rejects consecutive dots", () => {
    expect(DNS_SUBDOMAIN_RE.test("example..com")).toBe(false);
  });

  it("rejects underscore", () => {
    expect(DNS_SUBDOMAIN_RE.test("my_app.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(DNS_SUBDOMAIN_RE.test("")).toBe(false);
  });
});

// ── LABEL_VALUE_RE ──────────────────────────────────────────────────────────

describe("LABEL_VALUE_RE", () => {
  it("accepts alphanumeric", () => {
    expect(LABEL_VALUE_RE.test("web")).toBe(true);
  });

  it("accepts hyphens and underscores", () => {
    expect(LABEL_VALUE_RE.test("my-app_v2")).toBe(true);
  });

  it("accepts dots", () => {
    expect(LABEL_VALUE_RE.test("v1.2.3")).toBe(true);
  });

  it("accepts empty string (optional value)", () => {
    expect(LABEL_VALUE_RE.test("")).toBe(true);
  });

  it("accepts leading digit", () => {
    expect(LABEL_VALUE_RE.test("123app")).toBe(true);
  });

  it("rejects leading non-alphanumeric", () => {
    expect(LABEL_VALUE_RE.test("-app")).toBe(false);
  });

  it("rejects trailing non-alphanumeric", () => {
    expect(LABEL_VALUE_RE.test("app-")).toBe(false);
  });
});

// ── validateName ────────────────────────────────────────────────────────────

describe("validateName", () => {
  it("returns empty for a valid DNS label name", () => {
    expect(validateName("my-deployment")).toBe("");
  });

  it("returns empty for a name with digits and hyphens", () => {
    expect(validateName("nginx-123-prod")).toBe("");
  });

  it("returns empty for a single-character name", () => {
    expect(validateName("a")).toBe("");
  });

  it("trims whitespace before validating", () => {
    expect(validateName("  my-app  ")).toBe("");
  });

  it("returns error for empty string", () => {
    expect(validateName("")).toContain("required");
  });

  it("returns error for whitespace-only", () => {
    expect(validateName("   ")).toContain("required");
  });

  it("returns error for null/undefined", () => {
    expect(validateName(null)).toContain("required");
    expect(validateName(undefined)).toContain("required");
  });

  it("returns error for uppercase", () => {
    const err = validateName("MyApp");
    expect(err).toContain("lowercase");
  });

  it("returns error for leading hyphen", () => {
    expect(validateName("-myapp")).toContain("lowercase");
  });

  it("returns error for trailing hyphen", () => {
    expect(validateName("myapp-")).toContain("lowercase");
  });

  it("returns error for underscores", () => {
    expect(validateName("my_app")).toContain("lowercase");
  });

  it("returns error when name exceeds 63 characters", () => {
    const long = "a".repeat(64) + "bc";
    const err = validateName(long);
    expect(err).toContain("63");
  });

  it("accepts exactly 63 characters", () => {
    const name = "a" + "b".repeat(61) + "c";
    expect(name.length).toBe(63);
    expect(validateName(name)).toBe("");
  });

  it("returns error for dots (not a label)", () => {
    expect(validateName("my.app")).toContain("lowercase");
  });
});

// ── qualifiedNameError ──────────────────────────────────────────────────────

describe("qualifiedNameError", () => {
  it("returns empty for a simple label key", () => {
    expect(qualifiedNameError("app")).toBe("");
  });

  it("returns empty for a prefixed key (prefix/name)", () => {
    expect(qualifiedNameError("example.com/app")).toBe("");
  });

  it("returns empty for empty key (optional)", () => {
    expect(qualifiedNameError("")).toBe("");
  });

  it("returns error for too many slashes", () => {
    expect(qualifiedNameError("a/b/c")).toContain("too many");
  });

  it("returns error for invalid name part", () => {
    expect(qualifiedNameError("MyApp")).toContain("not a valid");
  });

  it("returns error for invalid prefix", () => {
    expect(qualifiedNameError("Invalid_Prefix/name")).toContain(
      "not a valid DNS name",
    );
  });

  it("returns error for prefix exceeding 253 characters", () => {
    const longPrefix = "a".repeat(254);
    expect(qualifiedNameError(`${longPrefix}/app`)).toContain(
      "not a valid DNS name",
    );
  });

  it("returns error for name exceeding 63 characters", () => {
    const longName = "a".repeat(64);
    expect(qualifiedNameError(`prefix/${longName}`)).toContain("not a valid");
  });
});

// ── labelValueError ─────────────────────────────────────────────────────────

describe("labelValueError", () => {
  it("returns empty for a valid label value", () => {
    expect(labelValueError("app", "web")).toBe("");
  });

  it("returns empty for alphanumeric with special chars", () => {
    expect(labelValueError("app", "my-app_v2.prod")).toBe("");
  });

  it("returns empty for empty value (optional)", () => {
    expect(labelValueError("app", "")).toBe("");
  });

  it("returns error for value exceeding 63 characters", () => {
    const long = "a".repeat(64);
    const err = labelValueError("key", long);
    expect(err).toContain("63");
  });

  it("returns error for leading hyphen", () => {
    const err = labelValueError("key", "-bad");
    expect(err).toContain("key");
    expect(err).toContain("63");
  });

  it("returns error for trailing hyphen", () => {
    const err = labelValueError("key", "bad-");
    expect(err).toContain("key");
  });

  it("includes the key name in the error message", () => {
    expect(labelValueError("my-label", "!!!")).toContain("my-label");
  });
});
