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

beforeEach(() => {
  localStorage.clear();
});

config.global.config.warnHandler = (msg) => {
  if (msg.includes("Extraneous non-props")) return;
  console.warn(msg);
};

afterEach(() => {
  vi.restoreAllMocks();
});
