/*
 * Tests for IngressCreate.vue — the create/edit-ingress panel of the
 * Networking view. One component, two modes: no ingressName prop = create,
 * ingressName prop = edit (prefilled from the live spec, name immutable).
 *
 * We cover:
 *   - focus moves to the panel heading on open
 *   - the form surface: name, ingress class options (cluster classes, custom,
 *     RBAC fallback), rules/paths rows, TLS rows, default backend
 *   - validation mirrors the backend: name, rules-or-default-backend, path
 *     slash/pathType, backend service + port, hosts, annotation keys
 *   - the create flow, including the cancelled-confirmation path
 *   - the YAML preview (validates before rendering)
 *   - edit mode: prefills the form, disables the name, blocks saving until
 *     unsupported resource backends are resolved, applies the update
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import IngressCreate from "../components/IngressCreate.vue";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    listIngressClasses: vi.fn(),
    renderIngressYaml: vi.fn(),
    createIngress: vi.fn(),
    ingressEdit: vi.fn(),
    updateIngress: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

function findBtn(w, label) {
  return w.findAll("button").find((b) => b.text().includes(label));
}

function findAria(w, label) {
  return w.findAll("button").find((b) => b.attributes("aria-label") === label);
}

// The unsupported-construct banner is also role=alert; the validation error
// paragraph comes after it in the DOM, so take the last alert.
function lastAlert(w) {
  return w.findAll('[role="alert"]').pop();
}

async function mountCreate(props = {}) {
  const w = mount(IngressCreate, {
    props: { namespace: "default", ...props },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listIngressClasses.mockResolvedValue(["nginx", "traefik"]);
  api.renderIngressYaml.mockResolvedValue("apiVersion: networking.k8s.io/v1\nkind: Ingress\n");
  api.createIngress.mockResolvedValue(true);
  api.updateIngress.mockResolvedValue(true);
});

const validCreate = {
  name: "web",
  ingressClassName: "nginx",
  rules: [
    {
      host: "example.com",
      paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80" }],
    },
  ],
  tls: [],
  defaultBackend: null,
  annotations: {},
  labels: {},
};

async function fillValid(w) {
  await w.find("#ing-create-name").setValue("web");
  await w.find("#ing-rule-host-0").setValue("example.com");
  await w.find("#ing-path-0-0").setValue("/");
  await w.find("#ing-svc-0-0").setValue("web");
  await w.find("#ing-svcport-0-0").setValue("80");
  await w.find("#ing-create-class").setValue("nginx");
}

describe("IngressCreate — focus and layout", () => {
  it("moves focus to the panel heading on open", async () => {
    const w = await mountCreate();
    expect(document.activeElement?.id).toBe("ing-create-heading");
    w.unmount();
  });

  it("starts with one rule with one path and no TLS rows", async () => {
    const w = await mountCreate();
    expect(w.find("#ing-rule-host-0").exists()).toBe(true);
    expect(w.find("#ing-path-0-0").exists()).toBe(true);
    expect(w.find("#ing-tls-hosts-0").exists()).toBe(false);
    w.unmount();
  });

  it("adds and removes rules and paths", async () => {
    const w = await mountCreate();
    await findBtn(w, "Add rule").trigger("click");
    expect(w.find("#ing-rule-host-1").exists()).toBe(true);
    await findBtn(w, "Add path").trigger("click");
    expect(w.find("#ing-path-0-1").exists()).toBe(true);
    await findAria(w, "Remove path 1 of rule 1").trigger("click");
    expect(w.find("#ing-path-0-1").exists()).toBe(false);
    await findAria(w, "Remove rule 2").trigger("click");
    expect(w.find("#ing-rule-host-1").exists()).toBe(false);
    w.unmount();
  });

  it("offers the cluster's ingress classes plus the cluster default", async () => {
    const w = await mountCreate();
    const opts = w.find("#ing-create-class").findAll("option");
    expect(opts.map((o) => o.text())).toEqual([
      "None (cluster default)",
      "nginx",
      "traefik",
      "Custom…",
    ]);
    w.unmount();
  });

  it("reveals a custom class input when Custom is chosen", async () => {
    const w = await mountCreate();
    expect(w.find("#ing-create-class-custom").exists()).toBe(false);
    await w.find("#ing-create-class").setValue("__custom__");
    expect(w.find("#ing-create-class-custom").exists()).toBe(true);
    await w.find("#ing-create-class-custom").setValue("istio");
    w.unmount();
  });

  it("falls back to a text input when classes cannot be listed", async () => {
    api.listIngressClasses.mockRejectedValue(new Error("forbidden"));
    const w = await mountCreate();
    const input = w.find("#ing-create-class");
    expect(input.element.tagName).toBe("INPUT");
    expect(w.text()).toContain("type the class name");
    w.unmount();
  });
});

describe("IngressCreate — validation", () => {
  it("requires a name", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-create-name").setValue("");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("Name is required");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects an invalid DNS label name", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-create-name").setValue("My_Ingress");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("lowercase DNS label");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("requires at least one rule or a default backend", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await findAria(w, "Remove rule 1").trigger("click");
    await w.find("form").trigger("submit");
    expect(lastAlert(w).text()).toContain("at least one rule or a default backend");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects a path that does not start with a slash", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-path-0-0").setValue("api");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain('must start with "/"');
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects a missing backend service name", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-svc-0-0").setValue("");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("backend service name is required");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects an out-of-range backend port", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-svcport-0-0").setValue("70000");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("between 1 and 65535");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects an invalid named backend port", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-svcport-0-0").setValue("HTTP_Port");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("neither a port number");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("accepts a named backend port", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-svcport-0-0").setValue("http");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalledWith("default", expect.objectContaining({
      rules: [{ host: "example.com", paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "http" }] }],
    }));
    w.unmount();
  });

  it("rejects an invalid host", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-rule-host-0").setValue("not a host!");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("Invalid host");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("accepts a wildcard host", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-rule-host-0").setValue("*.example.com");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalledWith("default", expect.objectContaining({
      rules: [{ host: "*.example.com", paths: expect.any(Array) }],
    }));
    w.unmount();
  });

  it("validates the default backend when enabled", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await findAria(w, "Remove rule 1").trigger("click");
    await w.find("#ing-db-enabled").setValue(true);
    await w.find("#ing-db-svc").setValue("web");
    await w.find("#ing-db-port").setValue("");
    await w.find("form").trigger("submit");
    expect(lastAlert(w).text()).toContain("Default backend");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects an invalid annotation key", async () => {
    const w = await mountCreate();
    await fillValid(w);
    const summary = w.find("details summary");
    await summary.trigger("click");
    await w.find("#ing-ann-key-0").setValue("bad key!");
    await w.find("form").trigger("submit");
    expect(w.find('[role="alert"]').text()).toContain("Annotation");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("IngressCreate — create flow", () => {
  it("creates with the user's choices and emits created", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalledWith("default", validCreate);
    expect(w.emitted("created")).toBeTruthy();
    w.unmount();
  });

  it("keeps the form open when the user cancels the confirmation", async () => {
    api.createIngress.mockResolvedValue(false);
    const w = await mountCreate();
    await fillValid(w);
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalled();
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });

  it("shows the error when creation fails", async () => {
    api.createIngress.mockRejectedValue(new Error("forbidden"));
    const w = await mountCreate();
    await fillValid(w);
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("forbidden");
    expect(w.emitted("created")).toBeUndefined();
    w.unmount();
  });

  it("splits comma-separated TLS hosts and drops empty TLS rows", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await findBtn(w, "Add TLS").trigger("click");
    await w.find("#ing-tls-hosts-0").setValue("a.example.com, b.example.com");
    await w.find("#ing-tls-secret-0").setValue("web-tls");
    await findBtn(w, "Add TLS").trigger("click"); // empty row: dropped
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalledWith("default", expect.objectContaining({
      tls: [{ hosts: ["a.example.com", "b.example.com"], secretName: "web-tls" }],
    }));
    w.unmount();
  });

  it("rejects an invalid TLS secret name", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await findBtn(w, "Add TLS").trigger("click");
    await w.find("#ing-tls-secret-0").setValue("Bad_Secret!");
    await w.find("form").trigger("submit");
    expect(lastAlert(w).text()).toContain("TLS:");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("rejects a host label longer than 63 characters", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-rule-host-0").setValue(`${"a".repeat(70)}.example.com`);
    await w.find("form").trigger("submit");
    expect(lastAlert(w).text()).toContain("longer than 63");
    expect(api.createIngress).not.toHaveBeenCalled();
    w.unmount();
  });

  it("includes the default backend only when enabled", async () => {
    const w = await mountCreate();
    await fillValid(w);
    await w.find("#ing-db-enabled").setValue(true);
    await w.find("#ing-db-svc").setValue("fallback");
    await w.find("#ing-db-port").setValue("8080");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createIngress).toHaveBeenCalledWith("default", expect.objectContaining({
      defaultBackend: { serviceName: "fallback", servicePort: "8080" },
    }));
    w.unmount();
  });
});

describe("IngressCreate — YAML preview", () => {
  it("renders the exact manifest and requires a valid form first", async () => {
    const w = await mountCreate();
    // Invalid form: no preview call.
    await w.find("#ing-create-name").setValue("web");
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderIngressYaml).not.toHaveBeenCalled();
    expect(w.find('[role="alert"]').text()).toBeTruthy();
    // Valid form: renders the preview.
    await w.find("#ing-rule-host-0").setValue("example.com");
    await w.find("#ing-path-0-0").setValue("/");
    await w.find("#ing-svc-0-0").setValue("web");
    await w.find("#ing-svcport-0-0").setValue("80");
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderIngressYaml).toHaveBeenCalledWith("default", expect.objectContaining({ name: "web" }));
    expect(w.text()).toContain("kind: Ingress");
    w.unmount();
  });
});

describe("IngressCreate — edit mode", () => {
  const editSpec = {
    spec: {
      name: "web",
      ingressClassName: "nginx",
      rules: [
        {
          host: "example.com",
          paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80" }],
        },
      ],
      tls: [{ hosts: ["a.example.com"], secretName: "web-tls" }],
      defaultBackend: { serviceName: "fallback", servicePort: "8080" },
      annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
      labels: { app: "web" },
    },
    unsupported: [],
  };

  it("prefills the form from the live spec and disables the name", async () => {
    api.ingressEdit.mockResolvedValue(editSpec);
    const w = await mountCreate({ ingressName: "web" });
    expect(api.ingressEdit).toHaveBeenCalledWith("default", "web");
    const nameInput = w.find("#ing-create-name");
    expect(nameInput.element.value).toBe("web");
    expect(nameInput.attributes("disabled")).toBeDefined();
    expect(w.find("#ing-rule-host-0").element.value).toBe("example.com");
    expect(w.find("#ing-svc-0-0").element.value).toBe("web");
    expect(w.find("#ing-tls-hosts-0").element.value).toBe("a.example.com");
    expect(w.find("#ing-tls-secret-0").element.value).toBe("web-tls");
    expect(w.find("#ing-db-svc").element.value).toBe("fallback");
    expect(w.find("#ing-ann-key-0").element.value).toBe("nginx.ingress.kubernetes.io/rewrite-target");
    expect(w.find("#ing-label-key-0").element.value).toBe("app");
    expect(w.find("#ing-create-class").element.value).toBe("nginx");
    w.unmount();
  });

  it("applies the update and emits saved", async () => {
    api.ingressEdit.mockResolvedValue(editSpec);
    const w = await mountCreate({ ingressName: "web" });
    await w.find("#ing-svcport-0-0").setValue("8080");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateIngress).toHaveBeenCalledWith("default", "web", expect.objectContaining({
      name: "web",
      rules: [{ host: "example.com", paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "8080" }] }],
      tls: [{ hosts: ["a.example.com"], secretName: "web-tls" }],
      defaultBackend: { serviceName: "fallback", servicePort: "8080" },
      annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
      labels: { app: "web" },
    }));
    expect(w.emitted("saved")).toBeTruthy();
    w.unmount();
  });

  it("keeps the form open when the update confirmation is cancelled", async () => {
    api.ingressEdit.mockResolvedValue(editSpec);
    api.updateIngress.mockResolvedValue(false);
    const w = await mountCreate({ ingressName: "web" });
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateIngress).toHaveBeenCalled();
    expect(w.emitted("saved")).toBeUndefined();
    w.unmount();
  });

  it("shows the unsupported banner and blocks saving until resolved", async () => {
    api.ingressEdit.mockResolvedValue({
      spec: {
        name: "res",
        ingressClassName: "",
        rules: [
          {
            host: "example.com",
            paths: [{ path: "/static", pathType: "Prefix", serviceName: "", servicePort: "" }],
          },
        ],
        tls: [],
        defaultBackend: null,
        annotations: {},
        labels: {},
      },
      unsupported: [
        "Host example.com, path /static uses a resource backend, which the form cannot express — enter a service for it or remove the row.",
      ],
    });
    const w = await mountCreate({ ingressName: "res" });
    expect(w.text()).toContain("Cannot fully edit this ingress");
    expect(w.text()).toContain("resource backend");
    // Unresolved: submit is blocked by validation.
    await w.find("form").trigger("submit");
    expect(lastAlert(w).text()).toContain("backend service name is required");
    expect(api.updateIngress).not.toHaveBeenCalled();
    // Resolved explicitly by the user: update proceeds.
    await w.find("#ing-svc-0-0").setValue("static-svc");
    await w.find("#ing-svcport-0-0").setValue("80");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateIngress).toHaveBeenCalledWith("default", "res", expect.objectContaining({
      rules: [{ host: "example.com", paths: [{ path: "/static", pathType: "Prefix", serviceName: "static-svc", servicePort: "80" }] }],
    }));
    expect(w.emitted("saved")).toBeTruthy();
    w.unmount();
  });

  it("flags a both-empty TLS block as unsupported instead of dropping it silently", async () => {
    api.ingressEdit.mockResolvedValue({
      spec: {
        name: "web",
        ingressClassName: "",
        rules: [
          {
            host: "example.com",
            paths: [{ path: "/", pathType: "Prefix", serviceName: "web", servicePort: "80" }],
          },
        ],
        tls: [{ hosts: [], secretName: "" }],
        defaultBackend: null,
        annotations: {},
        labels: {},
      },
      unsupported: [
        "A TLS block with no hosts and no secret (default certificate for all hosts) cannot be expressed in this form — enter hosts or a secret for it, or remove the row.",
      ],
    });
    const w = await mountCreate({ ingressName: "web" });
    expect(w.text()).toContain("Cannot fully edit this ingress");
    expect(w.text()).toContain("default certificate");
    // The empty TLS row loads so the user sees what the warning talks about.
    expect(w.find("#ing-tls-hosts-0").element.value).toBe("");
    w.unmount();
  });

  it("uses the custom class input when the spec class is not in the cluster list", async () => {
    api.ingressEdit.mockResolvedValue({
      spec: { ...editSpec.spec, ingressClassName: "istio" },
      unsupported: [],
    });
    const w = await mountCreate({ ingressName: "web" });
    expect(w.find("#ing-create-class").element.value).toBe("__custom__");
    expect(w.find("#ing-create-class-custom").element.value).toBe("istio");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateIngress).toHaveBeenCalledWith("default", "web", expect.objectContaining({
      ingressClassName: "istio",
    }));
    w.unmount();
  });

  it("shows the load error when the spec cannot be fetched", async () => {
    api.ingressEdit.mockRejectedValue(new Error("not found"));
    const w = await mountCreate({ ingressName: "gone" });
    expect(w.find('[role="alert"]').text()).toContain("not found");
    expect(w.find("#ing-create-name").exists()).toBe(false);
    w.unmount();
  });
});
