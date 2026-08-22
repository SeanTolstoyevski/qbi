<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { rowsToMap } from "../keyValueRows.js";
import PanelHeader from "./PanelHeader.vue";
import KeyValueFieldset from "./KeyValueFieldset.vue";
import YamlPreview from "./YamlPreview.vue";
import Combobox from "./Combobox.vue";
import {
  DNS_LABEL_RE,
  DNS_SUBDOMAIN_RE,
  LABEL_VALUE_RE,
  validateName,
  qualifiedNameError,
  labelValueError,
} from "../kubeValidation.js";

/*
 * Create/edit-ingress panel (Networking view). One component, two modes:
 * props.ingressName absent = create, present = edit (prefilled from the live
 * spec, name immutable). The user chooses everything — ingress class, host
 * rules, path types, backend service+port, TLS, default backend, annotations,
 * labels; nothing is inferred. Preview renders the exact YAML that will be
 * applied. Validation mirrors the backend so typos fail fast in the UI.
 *
 * Edit replaces the form-owned fields (class, rules, TLS, default backend,
 * annotations, labels) exactly as shown. Constructs the form cannot express
 * (resource backends) are loaded as rows with empty service fields plus a
 * warning banner, so the user must resolve them explicitly before saving —
 * nothing is dropped silently.
 */

const props = defineProps({
  namespace: { type: String, required: true },
  ingressName: { type: String, default: null }, // null = create mode
  opener: { type: Object, default: null },
});

const emit = defineEmits(["close", "created", "saved"]);
const { announce } = useStore();

const isEdit = computed(() => !!props.ingressName);

const form = ref({
  name: "",
  rules: [
    {
      host: "",
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "", servicePort: "" },
      ],
    },
  ],
  tls: [],
  defaultBackend: { enabled: false, serviceName: "", servicePort: "" },
  annotations: [{ key: "", value: "" }],
  labels: [{ key: "", value: "" }],
});

const classes = ref([]);
const classesError = ref("");
const classChoice = ref(""); // "" | class name | "__custom__"
const customClassName = ref("");

// Combobox choices for the ingress class: cluster default, discovered
// classes, and the sentinel that reveals the free-text custom-class input.
const classOptions = computed(() => [
  { value: "", label: "None (cluster default)" },
  ...classes.value.map((c) => ({ value: c, label: c })),
  { value: "__custom__", label: "Custom…" },
]);

// PathType values match the k8s API enum (networking.k8s.io/v1).
const PATH_TYPES = ["Prefix", "Exact", "ImplementationSpecific"];

const effectiveClass = computed(() => {
  if (classesError.value) return customClassName.value.trim();
  return classChoice.value === "__custom__"
    ? customClassName.value.trim()
    : classChoice.value;
});

// Edit-mode state.
const loading = ref(false);
const loadError = ref("");
const unsupported = ref([]); // constructs the form cannot express

// Shared panel state.
const preview = ref("");
const previewOpen = ref(false);
const saving = ref(false);
const error = ref("");
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  opener: props.opener,
  onClose: () => emit("close"),
});

onMounted(async () => {
  try {
    classes.value = (await api.listIngressClasses()) || [];
  } catch (e) {
    classesError.value = String(e);
    classChoice.value = "__custom__";
  }
  if (isEdit.value) await loadEdit();
});

async function loadEdit() {
  loading.value = true;
  loadError.value = "";
  try {
    const edit = await api.ingressEdit(props.namespace, props.ingressName);
    const s = edit.spec;
    form.value.name = s.name || "";
    form.value.rules =
      s.rules && s.rules.length
        ? s.rules.map((r) => ({
            host: r.host || "",
            paths:
              r.paths && r.paths.length
                ? r.paths.map((p) => ({
                    path: p.path || "",
                    pathType: p.pathType || "Prefix",
                    serviceName: p.serviceName || "",
                    servicePort: p.servicePort || "",
                  }))
                : [
                    {
                      path: "/",
                      pathType: "Prefix",
                      serviceName: "",
                      servicePort: "",
                    },
                  ],
          }))
        : [
            {
              host: "",
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  serviceName: "",
                  servicePort: "",
                },
              ],
            },
          ];
    form.value.tls = (s.tls || []).map((t) => ({
      hosts: (t.hosts || []).join(", "),
      secretName: t.secretName || "",
    }));
    form.value.defaultBackend = s.defaultBackend
      ? {
          enabled: true,
          serviceName: s.defaultBackend.serviceName || "",
          servicePort: s.defaultBackend.servicePort || "",
        }
      : { enabled: false, serviceName: "", servicePort: "" };
    form.value.annotations = toRows(s.annotations);
    form.value.labels = toRows(s.labels);
    unsupported.value = edit.unsupported || [];

    if (s.ingressClassName) {
      if ((classes.value || []).includes(s.ingressClassName)) {
        classChoice.value = s.ingressClassName;
      } else {
        classChoice.value = "__custom__";
        customClassName.value = s.ingressClassName;
      }
    }
  } catch (e) {
    loadError.value = String(e);
    announce(`Failed to load ingress: ${loadError.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

function toRows(m) {
  const rows = Object.entries(m || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [{ key: "", value: "" }];
}

// ── row helpers ─────────────────────────────────────────────────────────────
function addRule() {
  form.value.rules.push({
    host: "",
    paths: [
      { path: "/", pathType: "Prefix", serviceName: "", servicePort: "" },
    ],
  });
}
function removeRule(i) {
  form.value.rules.splice(i, 1);
}
function addPath(rule) {
  rule.paths.push({
    path: "/",
    pathType: "Prefix",
    serviceName: "",
    servicePort: "",
  });
}
function removePath(rule, i) {
  rule.paths.splice(i, 1);
}
function addTls() {
  form.value.tls.push({ hosts: "", secretName: "" });
}
function removeTls(i) {
  form.value.tls.splice(i, 1);
}

// ── spec helpers ────────────────────────────────────────────────────────────
function buildPayload() {
  const f = form.value;
  return {
    name: f.name.trim(),
    ingressClassName: effectiveClass.value,
    rules: f.rules.map((r) => ({
      host: r.host.trim(),
      paths: r.paths.map((p) => ({
        path: p.path.trim(),
        pathType: p.pathType,
        serviceName: p.serviceName.trim(),
        servicePort: p.servicePort.trim(),
      })),
    })),
    tls: f.tls
      .map((t) => ({
        hosts: t.hosts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        secretName: t.secretName.trim(),
      }))
      .filter((t) => t.hosts.length > 0 || t.secretName),
    defaultBackend: f.defaultBackend.enabled
      ? {
          serviceName: f.defaultBackend.serviceName.trim(),
          servicePort: f.defaultBackend.servicePort.trim(),
        }
      : null,
    annotations: rowsToMap(f.annotations),
    labels: rowsToMap(f.labels),
  };
}

// ── validation (mirrors the backend so typos fail fast in the UI) ───────────
const PORT_NAME_RE = /^[a-z][a-z0-9-]*$/;

function portError(port) {
  if (!port) return "Backend port is required (a number or a named port).";
  if (/^\d+$/.test(port)) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "Backend port must be a number between 1 and 65535, or a named port.";
    }
    return "";
  }
  if (!PORT_NAME_RE.test(port) || port.length > 15) {
    return `Backend port "${port}" is neither a port number (1-65535) nor a valid service port name.`;
  }
  return "";
}

function hostError(host) {
  if (!host) return "";
  if (host.length > 253) return `Host "${host}" is too long.`;
  if (host.startsWith("*.")) {
    if (!DNS_SUBDOMAIN_RE.test(host.slice(2))) {
      return `Invalid host "${host}". Use a hostname like example.com or a wildcard like *.example.com.`;
    }
  } else if (!DNS_SUBDOMAIN_RE.test(host)) {
    return `Invalid host "${host}". Use a hostname like example.com or a wildcard like *.example.com.`;
  }
  // Each label of a DNS name is limited to 63 characters.
  const labels = (host.startsWith("*.") ? host.slice(2) : host).split(".");
  if (labels.some((l) => l.length > 63)) {
    return `Host "${host}" has a label longer than 63 characters.`;
  }
  return "";
}

function secretNameError(secret) {
  if (!secret) return "";
  if (secret.length > 253) return `Secret name "${secret}" is too long.`;
  if (!DNS_SUBDOMAIN_RE.test(secret)) {
    return `Secret name "${secret}" is not a valid Kubernetes name.`;
  }
  return "";
}

function validate() {
  const f = form.value;
  const nameErr = validateName(f.name);
  if (nameErr) return nameErr;

  if (f.rules.length === 0 && !f.defaultBackend.enabled) {
    return "An ingress needs at least one rule or a default backend.";
  }
  for (let ri = 0; ri < f.rules.length; ri++) {
    const rule = f.rules[ri];
    const h = hostError(rule.host.trim());
    if (h) return `Rule ${ri + 1}: ${h}`;
    if (rule.paths.length === 0)
      return `Rule ${ri + 1} needs at least one path.`;
    for (let pi = 0; pi < rule.paths.length; pi++) {
      const p = rule.paths[pi];
      if (!["Prefix", "Exact", "ImplementationSpecific"].includes(p.pathType)) {
        return `Rule ${ri + 1}: path type is required (Prefix, Exact or ImplementationSpecific).`;
      }
      const path = p.path.trim();
      if (path === "" && p.pathType !== "ImplementationSpecific") {
        return `Rule ${ri + 1}: path must start with "/" (use "/" for the root).`;
      }
      if (path !== "" && !path.startsWith("/")) {
        return `Rule ${ri + 1}: path "${path}" must start with "/" (use "/" for the root).`;
      }
      if (!p.serviceName.trim()) {
        return `Rule ${ri + 1}, path "${path || "/"}": a backend service name is required.`;
      }
      const pe = portError(p.servicePort.trim());
      if (pe) return `Rule ${ri + 1}, path "${path || "/"}": ${pe}`;
    }
  }
  for (const t of f.tls) {
    for (const h of t.hosts
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const he = hostError(h);
      if (he) return `TLS: ${he}`;
    }
    const se = secretNameError(t.secretName.trim());
    if (se) return `TLS: ${se}`;
  }
  if (f.defaultBackend.enabled) {
    if (!f.defaultBackend.serviceName.trim())
      return "Default backend: a service name is required.";
    const pe = portError(f.defaultBackend.servicePort.trim());
    if (pe) return `Default backend: ${pe}`;
  }
  for (const r of f.annotations) {
    const k = r.key.trim();
    if (k) {
      const ke = qualifiedNameError(k);
      if (ke) return `Annotation: ${ke}`;
    }
  }
  for (const r of f.labels) {
    const k = r.key.trim();
    if (k) {
      const ke = qualifiedNameError(k);
      if (ke) return `Label: ${ke}`;
      if (!LABEL_VALUE_RE.test(r.value) || r.value.length > 63) {
        return labelValueError(k, r.value);
      }
    }
  }
  // Validate ingress class name when it's a custom value or the API errored.
  if (
    effectiveClass.value &&
    (classChoice.value === "__custom__" || classesError.value)
  ) {
    if (
      !DNS_SUBDOMAIN_RE.test(effectiveClass.value) ||
      effectiveClass.value.length > 253
    ) {
      return `Ingress class "${effectiveClass.value}" is not a valid name.`;
    }
  }
  return "";
}

// ── actions ─────────────────────────────────────────────────────────────────
async function togglePreview() {
  error.value = "";
  const v = validate();
  if (v) {
    error.value = v;
    announce(v, "assertive");
    return;
  }
  if (previewOpen.value) {
    previewOpen.value = false;
    return;
  }
  try {
    preview.value = await api.renderIngressYaml(
      props.namespace,
      buildPayload(),
    );
    previewOpen.value = true;
  } catch (e) {
    error.value = String(e);
  }
}

async function submit() {
  error.value = "";
  const v = validate();
  if (v) {
    error.value = v;
    announce(v, "assertive");
    return;
  }
  saving.value = true;
  try {
    const payload = buildPayload();
    if (isEdit.value) {
      const applied = await api.updateIngress(
        props.namespace,
        props.ingressName,
        payload,
      );
      if (!applied) return;
      announce(`Ingress ${props.ingressName} updated.`);
      emit("saved");
    } else {
      const created = await api.createIngress(props.namespace, payload);
      if (!created) return; // user cancelled the confirmation — keep the form
      announce(`Ingress ${form.value.name.trim()} created.`);
      emit("created");
    }
  } catch (e) {
    error.value = String(e);
    announce(
      isEdit.value
        ? `Failed to update ingress: ${String(e)}`
        : `Failed to create ingress: ${String(e)}`,
      "assertive",
    );
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="ing-create-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <PanelHeader
      ref="header"
      heading-id="ing-create-heading"
      :title="isEdit ? `Edit ingress: ${ingressName}` : 'Create ingress'"
      :disabled="saving"
      @close="emit('close')"
    />

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="loadError" class="text-danger small" role="alert">
      {{ loadError }}
    </p>

    <template v-else>
      <div
        v-if="unsupported.length"
        class="alert alert-warning py-2"
        role="alert"
      >
        <h3 class="h6">Cannot fully edit this ingress</h3>
        <ul class="mb-0 small">
          <li v-for="(u, i) in unsupported" :key="i">{{ u }}</li>
        </ul>
        <p class="small mb-0 mt-2">
          Resolve each item in the form (enter a service or remove the row), or
          use the YAML view if you need to keep them.
        </p>
      </div>

      <form class="row g-2" @submit.prevent="submit">
        <div class="col-12 col-md-6">
          <label for="ing-create-name" class="form-label mb-1 small"
            >Name</label
          >
          <input
            id="ing-create-name"
            v-model="form.name"
            type="text"
            class="form-control form-control-sm"
            :disabled="isEdit"
            autocomplete="off"
          />
          <span v-if="isEdit" class="small text-body-secondary">
            Name cannot be changed after creation.
          </span>
        </div>
        <div class="col-12 col-md-6">
          <label for="ing-create-class" class="form-label mb-1 small"
            >Ingress class</label
          >
          <template v-if="classesError">
            <input
              id="ing-create-class"
              v-model="customClassName"
              type="text"
              class="form-control form-control-sm"
              placeholder="nginx"
              autocomplete="off"
            />
            <span class="small text-body-secondary">
              Ingress classes could not be listed — type the class name.
            </span>
          </template>
          <template v-else>
            <Combobox
              id="ing-create-class"
              v-model="classChoice"
              :options="classOptions"
              readonly
            />
            <div v-if="classChoice === '__custom__'" class="mt-1">
              <label class="visually-hidden" for="ing-create-class-custom"
                >Custom ingress class</label
              >
              <input
                id="ing-create-class-custom"
                v-model="customClassName"
                type="text"
                class="form-control form-control-sm"
                placeholder="nginx"
                autocomplete="off"
              />
            </div>
          </template>
        </div>

        <div class="col-12">
          <fieldset>
            <legend class="h6 small text-body-secondary">
              Rules — host and path routing to backend services
            </legend>
            <div
              v-for="(rule, ri) in form.rules"
              :key="ri"
              class="border rounded p-2 mb-2"
            >
              <div class="row g-2 align-items-end mb-1">
                <div class="col-12 col-md-7">
                  <label class="visually-hidden" :for="`ing-rule-host-${ri}`"
                    >Host for rule {{ ri + 1 }} (empty = all hosts)</label
                  >
                  <input
                    :id="`ing-rule-host-${ri}`"
                    v-model="rule.host"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="Host — example.com or *.example.com (empty = all hosts)"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary w-100"
                    @click="addPath(rule)"
                  >
                    Add path
                  </button>
                </div>
                <div class="col-6 col-md-2">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary w-100"
                    :aria-label="`Remove rule ${ri + 1}`"
                    @click="removeRule(ri)"
                  >
                    Remove rule
                  </button>
                </div>
              </div>

              <div
                v-for="(p, pi) in rule.paths"
                :key="pi"
                class="row g-2 mb-1 align-items-end"
              >
                <div class="col-6 col-md-2">
                  <label class="visually-hidden" :for="`ing-path-${ri}-${pi}`"
                    >Path for rule {{ ri + 1 }}</label
                  >
                  <input
                    :id="`ing-path-${ri}-${pi}`"
                    v-model="p.path"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="/"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label
                    class="visually-hidden"
                    :for="`ing-pathtype-${ri}-${pi}`"
                    >Path type for rule {{ ri + 1 }}</label
                  >
                  <Combobox
                    :id="`ing-pathtype-${ri}-${pi}`"
                    v-model="p.pathType"
                    :options="PATH_TYPES"
                    readonly
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label class="visually-hidden" :for="`ing-svc-${ri}-${pi}`"
                    >Backend service for rule {{ ri + 1 }}</label
                  >
                  <input
                    :id="`ing-svc-${ri}-${pi}`"
                    v-model="p.serviceName"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="Service name"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-2">
                  <label
                    class="visually-hidden"
                    :for="`ing-svcport-${ri}-${pi}`"
                    >Backend port for rule {{ ri + 1 }}</label
                  >
                  <input
                    :id="`ing-svcport-${ri}-${pi}`"
                    v-model="p.servicePort"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="Port or name"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-2">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary w-100"
                    :aria-label="`Remove path ${pi + 1} of rule ${ri + 1}`"
                    @click="removePath(rule, pi)"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              @click="addRule"
            >
              Add rule
            </button>
          </fieldset>
        </div>

        <div class="col-12">
          <fieldset>
            <legend class="h6 small text-body-secondary">
              TLS — certificate secrets for the hosts they cover (empty secret =
              controller default certificate)
            </legend>
            <div
              v-for="(t, ti) in form.tls"
              :key="ti"
              class="row g-2 mb-1 align-items-end"
            >
              <div class="col-6 col-md-5">
                <label class="visually-hidden" :for="`ing-tls-hosts-${ti}`"
                  >TLS hosts (comma-separated)</label
                >
                <input
                  :id="`ing-tls-hosts-${ti}`"
                  v-model="t.hosts"
                  type="text"
                  class="form-control form-control-sm"
                  placeholder="Hosts (comma-separated; empty = all hosts)"
                  autocomplete="off"
                />
              </div>
              <div class="col-6 col-md-5">
                <label class="visually-hidden" :for="`ing-tls-secret-${ti}`"
                  >TLS secret name</label
                >
                <input
                  :id="`ing-tls-secret-${ti}`"
                  v-model="t.secretName"
                  type="text"
                  class="form-control form-control-sm"
                  placeholder="Secret name (empty = default certificate)"
                  autocomplete="off"
                />
              </div>
              <div class="col-6 col-md-2">
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary w-100"
                  :aria-label="`Remove TLS block ${ti + 1}`"
                  @click="removeTls(ti)"
                >
                  Remove
                </button>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              @click="addTls"
            >
              Add TLS
            </button>
          </fieldset>
        </div>

        <div class="col-12">
          <fieldset>
            <legend class="h6 small text-body-secondary">
              Default backend — catch-all for requests matching no rule
            </legend>
            <div class="row g-2 align-items-end">
              <div class="col-12 col-md-3 d-flex align-items-center">
                <div class="form-check mb-0">
                  <input
                    id="ing-db-enabled"
                    v-model="form.defaultBackend.enabled"
                    class="form-check-input"
                    type="checkbox"
                  />
                  <label class="form-check-label small" for="ing-db-enabled"
                    >Use a default backend</label
                  >
                </div>
              </div>
              <template v-if="form.defaultBackend.enabled">
                <div class="col-6 col-md-3">
                  <label class="visually-hidden" for="ing-db-svc"
                    >Default backend service</label
                  >
                  <input
                    id="ing-db-svc"
                    v-model="form.defaultBackend.serviceName"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="Service name"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label class="visually-hidden" for="ing-db-port"
                    >Default backend port</label
                  >
                  <input
                    id="ing-db-port"
                    v-model="form.defaultBackend.servicePort"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="Port or name"
                    autocomplete="off"
                  />
                </div>
              </template>
            </div>
          </fieldset>
        </div>

        <div class="col-12">
          <details>
            <summary class="small text-body-secondary">
              Advanced options
            </summary>
            <div class="mt-2 border rounded p-2">
              <KeyValueFieldset
                :rows="form.annotations"
                legend="Annotations — controller configuration (e.g. nginx rewrite, cert-manager issuer)"
                id-prefix="ing-ann"
                key-placeholder="nginx.ingress.kubernetes.io/rewrite-target"
                value-placeholder="/"
                add-label="Add annotation"
                remove-label="annotation"
                key-label="Annotation key"
                val-label="Annotation value"
              />

              <KeyValueFieldset
                class="mt-3"
                :rows="form.labels"
                legend="Labels"
                id-prefix="ing-label"
                key-placeholder="app"
                value-placeholder="web"
                add-label="Add label"
                remove-label="label"
                key-label="Label key"
                val-label="Label value"
              />
            </div>
          </details>
        </div>

        <div class="col-12 d-flex align-items-center gap-2">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :disabled="saving"
            @click="togglePreview"
          >
            {{ previewOpen ? "Hide preview" : "Preview YAML" }}
          </button>
          <button
            type="submit"
            class="btn btn-sm btn-primary"
            :disabled="saving"
          >
            {{ isEdit ? "Apply" : "Create" }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :disabled="saving"
            @click="emit('close')"
          >
            Cancel
          </button>
        </div>
        <p v-if="error" class="text-danger small" role="alert">{{ error }}</p>

        <YamlPreview :yaml="preview" :open="previewOpen" />
      </form>
    </template>
  </section>
</template>
