import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forwardError, initErrorForwarding } from "../logging.js";

function mockBackend() {
  const LogFrontend = vi.fn(() => Promise.resolve());
  window.go = { main: { Service: { LogFrontend } } };
  return LogFrontend;
}

describe("error forwarding", () => {
  let logFrontend;

  beforeEach(() => {
    logFrontend = mockBackend();
  });

  afterEach(() => {
    delete window.go;
  });

  it("forwards window error events to the backend", async () => {
    initErrorForwarding();
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "boom",
        filename: "App.vue",
        lineno: 3,
      }),
    );
    await Promise.resolve();
    expect(logFrontend).toHaveBeenCalledWith("error", "boom", "App.vue:3");
  });

  it("forwards unhandled rejections", async () => {
    initErrorForwarding();
    const ev = new Event("unhandledrejection");
    ev.reason = new Error("rejected");
    window.dispatchEvent(ev);
    await Promise.resolve();
    expect(logFrontend).toHaveBeenCalledWith(
      "error",
      "rejected",
      expect.any(String),
    );
  });

  it("does nothing when the backend binding is missing", async () => {
    delete window.go;
    expect(() => forwardError("error", "x", "")).not.toThrow();
  });

  it("survives a failing backend call", async () => {
    window.go.main.Service.LogFrontend = vi.fn(() =>
      Promise.reject(new Error("no binding")),
    );
    expect(() => forwardError("error", "x", "")).not.toThrow();
    await Promise.resolve();
  });

  it("stops forwarding after the session cap", async () => {
    vi.resetModules();
    const fresh = await import("../logging.js");
    for (let i = 0; i < 150; i++) fresh.forwardError("error", "x", "");
    expect(logFrontend).toHaveBeenCalledTimes(100);
  });
});
