import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import IngressDetail from "../components/IngressDetail.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    getIngressDetail: vi.fn(),
    getResourceYaml: vi.fn(),
    deleteIngress: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

const healthy = {
  ingress: {
    name: "web",
    namespace: "default",
    class: "nginx",
    age: "2d",
    addresses: ["1.2.3.4", "lb.example.com"],
    tls: [
      { hosts: ["a.example.com"], secretName: "web-tls", secretStatus: "ok" },
    ],
    rules: [
      {
        host: "a.example.com",
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            serviceName: "web",
            servicePort: "80",
            status: "ok",
            readyEndpoints: 2,
          },
        ],
      },
    ],
    defaultBackend: null,
    annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
    issues: [],
  },
  events: [],
  eventsError: "",
};

const broken = {
  ingress: {
    ...healthy.ingress,
    addresses: [],
    tls: [
      {
        hosts: ["a.example.com"],
        secretName: "missing-tls",
        secretStatus: "missing",
      },
    ],
    rules: [
      {
        host: "a.example.com",
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            serviceName: "gone",
            servicePort: "8080",
            status: "no-service",
            readyEndpoints: 0,
          },
        ],
      },
    ],
    issues: [
      "No external address assigned yet. The load balancer may still be provisioning.",
      'TLS secret "missing-tls" not found in this namespace (hosts: a.example.com).',
      'Host a.example.com, path / routes to service "gone", which does not exist in this namespace.',
    ],
  },
  events: [
    {
      type: "Warning",
      reason: "Sync",
      message: "Error syncing to load balancer",
      count: 3,
      lastSeen: "2m",
    },
  ],
  eventsError: "",
};

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  vi.clearAllMocks();
  api.getResourceYaml.mockResolvedValue(
    "apiVersion: networking.k8s.io/v1\nkind: Ingress\n",
  );
});

function mountDetail(name = "web") {
  return mount(IngressDetail, {
    props: { namespace: "default", name },
    attachTo: document.body,
  });
}

describe("IngressDetail - rendering", () => {
  it("renders a healthy ingress with addresses, TLS and backend health", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    expect(api.getIngressDetail).toHaveBeenCalledWith("default", "web");
    expect(w.text()).toContain("Ingress: web");
    expect(w.text()).toContain("1.2.3.4");
    expect(w.text()).toContain("lb.example.com");
    expect(w.text()).toContain("present");
    expect(w.text()).toContain("ok (2 ready)");
    expect(w.text()).toContain("rewrite-target=/");
    expect(w.text()).not.toContain("Issues");
    w.unmount();
  });

  it("renders the issue list and per-backend warnings for a broken ingress", async () => {
    api.getIngressDetail.mockResolvedValue(broken);
    const w = mountDetail();
    await flushPromises();
    expect(w.text()).toContain("Issues");
    expect(w.text()).toContain("No external address assigned yet");
    expect(w.text()).toContain("missing-tls");
    expect(w.text()).toContain("service missing");
    w.unmount();
  });

  it("renders events and highlights warnings", async () => {
    api.getIngressDetail.mockResolvedValue(broken);
    const w = mountDetail();
    await flushPromises();
    expect(w.text()).toContain("Error syncing to load balancer");
    expect(w.text()).toContain("Warning");
    w.unmount();
  });

  it("shows a note when events are not readable instead of failing", async () => {
    api.getIngressDetail.mockResolvedValue({
      ...healthy,
      events: [],
      eventsError: "events is forbidden",
    });
    const w = mountDetail();
    await flushPromises();
    expect(w.text()).toContain("Events unavailable");
    expect(w.text()).toContain("Ingress: web");
    w.unmount();
  });

  it("renders an ingress with no rules without crashing", async () => {
    // Regression: an ingress that routes nothing must show the explanatory
    // note, not throw on a null/empty rules array.
    api.getIngressDetail.mockResolvedValue({
      ingress: { ...healthy.ingress, rules: [], defaultBackend: null },
      events: [],
      eventsError: "",
    });
    const w = mountDetail();
    await flushPromises();
    expect(w.text()).toContain("forwards no traffic");
    w.unmount();
  });
});

describe("IngressDetail - actions", () => {
  it("opens the YAML sub-view for the ingress", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "YAML").trigger("click");
    await flushPromises();
    expect(api.getResourceYaml).toHaveBeenCalledWith(
      "default",
      "Ingress",
      "web",
    );
    expect(w.text()).toContain("kind: Ingress");
    w.unmount();
  });

  it("returns focus to the YAML button when the YAML sub-view closes", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    const yamlBtn = findBtn(w, "YAML");
    await yamlBtn.trigger("click");
    await flushPromises();
    const closes = w.findAll("button").filter((b) => b.text() === "Close");
    await closes[closes.length - 1].trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(yamlBtn.element);
    w.unmount();
  });

  it("emits close from the Close button", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "Close").trigger("click");
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });

  it("deletes the ingress via the API and emits deleted on success", async () => {
    api.deleteIngress.mockResolvedValue(true);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.deleteIngress).toHaveBeenCalledWith("default", "web");
    expect(w.emitted("deleted")).toBeTruthy();
    w.unmount();
  });

  it("does not emit deleted when the user cancels the confirmation", async () => {
    api.deleteIngress.mockResolvedValue(false); // native dialog cancelled
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.deleteIngress).toHaveBeenCalledWith("default", "web");
    expect(w.emitted("deleted")).toBeFalsy();
    w.unmount();
  });

  it("disables Delete while the YAML sub-view is open", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "YAML").trigger("click");
    await flushPromises();
    const del = w.findAll("button").find((b) => b.text().includes("Delete"));
    expect(del.attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("shows an error and keeps the panel open when deletion fails", async () => {
    api.deleteIngress.mockRejectedValue(new Error("forbidden"));
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(w.emitted("deleted")).toBeFalsy();
    expect(w.text()).toContain("forbidden"); // panel shows the raw error
    w.unmount();
  });
});

describe("IngressDetail - edit", () => {
  it("emits edit with the ingress name", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "Edit").trigger("click");
    expect(w.emitted("edit")).toEqual([["web"]]);
    w.unmount();
  });

  it("disables Edit while the YAML sub-view is open", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    await findBtn(w, "YAML").trigger("click");
    const edit = w.findAll("button").find((b) => b.text().includes("Edit"));
    expect(edit.attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

function findBtn(w, label) {
  return w.findAll("button").find((b) => b.text().includes(label));
}

describe("IngressDetail - refresh and Escape", () => {
  it("reloads the detail via the refresh button", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    api.getIngressDetail.mockClear();
    await findBtn(w, "Refresh ingress details").trigger("click");
    await flushPromises();
    expect(api.getIngressDetail).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("closes the panel on Escape only when the YAML sub-view is closed", async () => {
    api.getIngressDetail.mockResolvedValue(healthy);
    const w = mountDetail();
    await flushPromises();
    // Open the YAML sub-view: Escape must not close the whole panel there.
    await findBtn(w, "YAML").trigger("click");
    await flushPromises();
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeUndefined();
    // Close the sub-view via its own Close button (last one in the DOM).
    const closes = w.findAll("button").filter((b) => b.text() === "Close");
    await closes[closes.length - 1].trigger("click");
    await flushPromises();
    // Now Escape closes the panel.
    await w.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});
