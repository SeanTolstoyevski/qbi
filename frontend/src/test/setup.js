/*
 * Global test setup — runs once before every test file.
 *
 * Responsibilities:
 *   1. Stub the Wails runtime globals (window.go, window.runtime) that the
 *      real app receives from the Wails shell. Without these stubs, any import
 *      of api.js would throw at module load time.
 *   2. Reset per-test mocks automatically so tests never bleed into each other.
 *   3. Provide a small helper (mockApi) that individual tests can import to
 *      override specific api calls without re-stubbing everything.
 */

import { vi, beforeEach, afterEach } from "vitest";
import { config } from "@vue/test-utils";

// ---------------------------------------------------------------------------
// Wails global stubs
// Every api.js call goes through window.go.main.Service.<Method>. We install
// a Proxy so any method called on it returns a resolved Promise by default.
// Individual tests can override specific methods via vi.spyOn or mockApi().
// ---------------------------------------------------------------------------
const serviceProxy = new Proxy(
  {},
  {
    get(_, method) {
      return vi.fn().mockResolvedValue(undefined);
    },
  },
);

Object.assign(window, {
  go: { main: { Service: serviceProxy } },
  runtime: {
    EventsOn: vi.fn(),
    EventsOff: vi.fn(),
    EventsEmit: vi.fn(),
  },
});

// ---------------------------------------------------------------------------
// localStorage stub (happy-dom provides one but resetting it between tests
// prevents store state from leaking).
// ---------------------------------------------------------------------------
beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Vue Test Utils global config — suppress the "extraneous non-props" warning
// that fires when Bootstrap classes appear on component roots, keeping test
// output clean so real failures stand out.
// ---------------------------------------------------------------------------
config.global.config.warnHandler = (msg) => {
  if (msg.includes("Extraneous non-props")) return;
  console.warn(msg);
};

// ---------------------------------------------------------------------------
// Auto-restore all vi.spyOn / vi.fn mocks after each test so per-test setup
// in individual files does not need explicit cleanup.
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});
