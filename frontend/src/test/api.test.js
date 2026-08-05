/*
 * Tests for api.js — the Wails wrapper with friendly error mapping.
 *
 * The service() function wraps every Wails-bound method once so raw client-go
 * errors ("Forbidden", "context deadline exceeded") become short, actionable
 * messages for a screen-reader user. We install throwaway Service objects and
 * assert the mapped messages.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { api } from "../api.js";

// Install a fresh Service object with the given methods for one test.
function installService(methods) {
  window.go.main.Service = methods;
}

beforeEach(() => {
  window.go.main.Service = {};
});

describe("api — friendly error mapping", () => {
  it("maps Forbidden to a permission message", async () => {
    installService({ ListPods: () => Promise.reject(new Error("pods is forbidden")) });
    await expect(api.listPods("default")).rejects.toThrow(
      "You don't have permission to access this resource."
    );
  });

  it("maps context deadline exceeded to a timeout message", async () => {
    installService({ ListNamespaces: () => Promise.reject(new Error("context deadline exceeded")) });
    await expect(api.listNamespaces()).rejects.toThrow("The request timed out.");
  });

  it("maps connection refused to a connectivity message", async () => {
    installService({ ListNodes: () => Promise.reject(new Error("dial tcp: connection refused")) });
    await expect(api.listNodes()).rejects.toThrow("Cannot reach the cluster.");
  });

  it("maps not found to a deleted-resource message", async () => {
    installService({ GetPod: () => Promise.reject(new Error('pods "x" not found')) });
    await expect(api.getPod("default", "x")).rejects.toThrow("The resource was not found.");
  });

  it("maps metrics-server 'not available yet' to an unavailable-metrics message", async () => {
    installService({
      // Real error from metrics-server before its first collection cycle.
      GetPodMetrics: () => Promise.reject(new Error("metrics not available yet")),
    });
    await expect(api.getPodMetrics("default", "x")).rejects.toThrow(
      "Live usage metrics are unavailable"
    );
  });

  it("passes through unrecognized errors verbatim", async () => {
    installService({ ListSecrets: () => Promise.reject(new Error("boom: something unexpected")) });
    await expect(api.listSecrets("default")).rejects.toThrow("boom: something unexpected");
  });

  it("resolved values pass through unwrapped", async () => {
    installService({ ListPods: () => Promise.resolve([{ name: "p1" }]) });
    await expect(api.listPods("default")).resolves.toEqual([{ name: "p1" }]);
  });
});
