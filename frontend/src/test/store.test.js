/*
 * Tests for store.js
 *
 * The store is a module singleton, so we re-import it fresh in each test via
 * Vitest's module isolation. We test:
 *   - announce()  : sets status + statusKind, resets before re-announcing
 *   - setConnection() : populates state, recalls last namespace from storage
 *   - setNamespace()  : updates state and persists to localStorage
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Re-import the module fresh for every test to avoid singleton state leaking.
async function freshStore() {
  vi.resetModules();
  const mod = await import("../store.js");
  return mod.useStore();
}

describe("store — announce()", () => {
  it("sets status and defaults to polite", async () => {
    const { state, announce } = await freshStore();
    // announce resets to '' then sets via rAF; we flush rAF with a tick.
    announce("hello");
    await new Promise((r) => requestAnimationFrame(r));
    expect(state.status).toBe("hello");
    expect(state.statusKind).toBe("polite");
  });

  it("sets assertive kind for errors", async () => {
    const { state, announce } = await freshStore();
    announce("boom", "assertive");
    await new Promise((r) => requestAnimationFrame(r));
    expect(state.statusKind).toBe("assertive");
  });

  it("re-announces the same message by first clearing to empty", async () => {
    const { state, announce } = await freshStore();
    announce("same");
    await new Promise((r) => requestAnimationFrame(r));
    expect(state.status).toBe("same");

    // Calling again with the same text should first set '' then the text,
    // so the aria-live region always fires a mutation event.
    announce("same");
    // After the synchronous reset, status is ''
    expect(state.status).toBe("");
    await new Promise((r) => requestAnimationFrame(r));
    expect(state.status).toBe("same");
  });
});

describe("store — flash()", () => {
  it("sets the flash message and bumps the sequence", async () => {
    const { state, flash } = await freshStore();
    expect(state.flashMsg).toBe("");
    expect(state.flashSeq).toBe(0);

    flash("Pod web copied.");
    expect(state.flashMsg).toBe("Pod web copied.");
    expect(state.flashSeq).toBe(1);

    // A second flash replaces the message — the seq bump restarts the UI timer.
    flash("YAML copied.");
    expect(state.flashMsg).toBe("YAML copied.");
    expect(state.flashSeq).toBe(2);
  });

  it("clearFlash empties the message", async () => {
    const { state, flash, clearFlash } = await freshStore();
    flash("hi");
    clearFlash();
    expect(state.flashMsg).toBe("");
  });
});

describe("store — setConnection()", () => {
  it("marks connected and stores context", async () => {
    const { state, setConnection } = await freshStore();
    setConnection({ name: "prod", namespace: "default" });
    expect(state.connected).toBe(true);
    expect(state.context.name).toBe("prod");
  });

  it("recalls a previously remembered namespace for the same context", async () => {
    // Seed localStorage as if the user had previously selected 'kube-system'.
    localStorage.setItem(
      "qba.lastNamespace",
      JSON.stringify({ prod: "kube-system" }),
    );
    const { state, setConnection } = await freshStore();
    setConnection({ name: "prod", namespace: "default" });
    // Should prefer the remembered namespace over the kubeconfig default.
    expect(state.namespace).toBe("kube-system");
  });

  it("falls back to the context default namespace when nothing is remembered", async () => {
    const { state, setConnection } = await freshStore();
    setConnection({ name: "dev", namespace: "my-ns" });
    expect(state.namespace).toBe("my-ns");
  });

  it("bumps the connection epoch on every successful connect", async () => {
    const { state, setConnection } = await freshStore();
    expect(state.connectionEpoch).toBe(0);

    setConnection({ name: "prod", namespace: "default" });
    expect(state.connectionEpoch).toBe(1);

    // Reconnect to the SAME context with identical values must still bump:
    // components watch the epoch so this is what forces them to reload.
    setConnection({ name: "prod", namespace: "default" });
    expect(state.connectionEpoch).toBe(2);
  });
});

describe("store — clearConnection()", () => {
  it("tears down connected state so no cluster view stays alive", async () => {
    const { state, setConnection, setNamespace, clearConnection } =
      await freshStore();
    setConnection({ name: "prod", namespace: "default" });
    setNamespace("kube-system");
    expect(state.connected).toBe(true);

    clearConnection();
    expect(state.connected).toBe(false);
    expect(state.context).toBeNull();
    expect(state.namespace).toBeNull();
  });

  it("leaves the connection epoch untouched (only successful connects bump it)", async () => {
    const { state, setConnection, clearConnection } = await freshStore();
    setConnection({ name: "prod", namespace: "default" });
    const epoch = state.connectionEpoch;
    clearConnection();
    expect(state.connectionEpoch).toBe(epoch);
  });
});

describe("store — setNamespace()", () => {
  it("updates state.namespace", async () => {
    const { state, setConnection, setNamespace } = await freshStore();
    setConnection({ name: "dev", namespace: "default" });
    setNamespace("monitoring");
    expect(state.namespace).toBe("monitoring");
  });

  it("persists the selection to localStorage keyed by context", async () => {
    const { setConnection, setNamespace } = await freshStore();
    setConnection({ name: "staging", namespace: "default" });
    setNamespace("logging");
    const stored = JSON.parse(
      localStorage.getItem("qba.lastNamespace") || "{}",
    );
    expect(stored.staging).toBe("logging");
  });
});
