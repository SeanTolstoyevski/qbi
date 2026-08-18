import { describe, it, expect } from "vitest";
import {
  phaseBadgeClass,
  nodeStatusBadgeClass,
  jobStatusBadgeClass,
  containerReadyBadgeClass,
} from "../statusClasses.js";

describe("phaseBadgeClass", () => {
  it("maps Running to success", () => {
    expect(phaseBadgeClass("Running")).toBe("text-bg-success");
  });

  it("maps Failed to danger", () => {
    expect(phaseBadgeClass("Failed")).toBe("text-bg-danger");
  });

  it("maps Unknown to warning", () => {
    expect(phaseBadgeClass("Unknown")).toBe("text-bg-warning");
  });

  it("maps transient/informational phases to neutral gray", () => {
    expect(phaseBadgeClass("Pending")).toBe("text-bg-secondary");
    expect(phaseBadgeClass("Succeeded")).toBe("text-bg-secondary");
  });

  it("is safe for unexpected values", () => {
    expect(phaseBadgeClass("WeirdPhase")).toBe("text-bg-secondary");
  });
});

describe("nodeStatusBadgeClass", () => {
  it("maps Ready to success and NotReady to danger", () => {
    expect(nodeStatusBadgeClass("Ready")).toBe("text-bg-success");
    expect(nodeStatusBadgeClass("NotReady")).toBe("text-bg-danger");
  });

  it("maps Unknown to warning", () => {
    expect(nodeStatusBadgeClass("Unknown")).toBe("text-bg-warning");
  });
});

describe("jobStatusBadgeClass", () => {
  it("maps Complete to success and Failed to danger", () => {
    expect(jobStatusBadgeClass("Complete")).toBe("text-bg-success");
    expect(jobStatusBadgeClass("Failed")).toBe("text-bg-danger");
  });

  it("maps Suspended to attention-amber and Running to neutral gray", () => {
    expect(jobStatusBadgeClass("Suspended")).toBe("text-bg-warning");
    expect(jobStatusBadgeClass("Running")).toBe("text-bg-secondary");
  });

  it("is safe for unexpected values", () => {
    expect(jobStatusBadgeClass("WeirdStatus")).toBe("text-bg-secondary");
  });
});

describe("containerReadyBadgeClass", () => {
  it("maps ready to success and not-ready to warning", () => {
    expect(containerReadyBadgeClass(true)).toBe("text-bg-success");
    expect(containerReadyBadgeClass(false)).toBe("text-bg-warning");
  });
});
