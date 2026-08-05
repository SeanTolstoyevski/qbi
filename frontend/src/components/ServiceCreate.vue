<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";

/*
 * Create-service panel (Networking view). A Service is a sibling of the
 * Deployment in the namespace: it selects pods by label. The user chooses
 * everything — type, selector, ports, node ports, affinity, IPs; nothing is
 * inferred for them. Preview renders the exact YAML that will be applied.
 */

const props = defineProps({
  namespace: { type: String, required: true },
  openerId: { type: String, default: null }, // id of the trigger button for focus return
});
const emit = defineEmits(["close", "created"]);
const { announce } = useStore();

const form = ref({
  name: "",
  type: "ClusterIP",
  selector: [{ key: "", value: "" }],
  ports: [{ name: "", port: "", targetPort: "", protocol: "TCP", nodePort: "" }],
  sessionAffinity: "",
  clusterIP: "",
  externalIPs: [""],
});

const preview = ref("");
const previewOpen = ref(false);
const saving = ref(false);
const error = ref("");
const headingEl = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: headingEl,
  openerId: props.openerId,
  onClose: () => emit("close"),
});

// The node port only means something for NodePort/LoadBalancer types; it is
// shown then, and empty means the cluster picks one.
const showNodePort = computed(
  () => form.value.type === "NodePort" || form.value.type === "LoadBalancer"
);

// ── row helpers ─────────────────────────────────────────────────────────────
function addRow(rows) {
  rows.push({ key: "", value: "" });
}
function removeRow(rows, i) {
  rows.splice(i, 1);
}
function addPort() {
  form.value.ports.push({ name: "", port: "", targetPort: "", protocol: "TCP", nodePort: "" });
}
function removePort(i) {
  form.value.ports.splice(i, 1);
}
function addExternalIP() {
  form.value.externalIPs.push("");
}
function removeExternalIP(i) {
  form.value.externalIPs.splice(i, 1);
}

// ── spec helpers ────────────────────────────────────────────────────────────
function rowsToMap(rows) {
  const out = {};
  for (const r of rows) {
    if (r.key.trim()) out[r.key.trim()] = r.value;
  }
  return out;
}

function buildPayload() {
  const f = form.value;
  return {
    name: f.name.trim(),
    type: f.type,
    selector: rowsToMap(f.selector),
    ports: f.ports
      .filter((p) => p.port !== "" && p.port != null)
      .map((p) => ({
        name: p.name.trim(),
        port: Number(p.port),
        targetPort: p.targetPort.trim(),
        protocol: p.protocol,
        nodePort: Number(p.nodePort) || 0,
      })),
    sessionAffinity: f.sessionAffinity,
    clusterIP: f.clusterIP.trim(),
    externalIPs: f.externalIPs.map((s) => s.trim()).filter(Boolean),
  };
}

// ── validation (mirrors the backend so typos fail fast in the UI) ───────────
function validate() {
  const f = form.value;
  if (!f.name.trim()) return "Name is required.";
  const ports = f.ports.filter((p) => p.port !== "" && p.port != null);
  if (ports.length === 0) return "At least one port is required.";
  for (const p of ports) {
    const port = Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "Service ports must be whole numbers between 1 and 65535.";
    }
    const target = p.targetPort.trim();
    if (target && !/^\d+$/.test(target) && !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(target)) {
      return `Invalid target port "${target}". Use a number or a named port.`;
    }
    if (p.protocol && !["TCP", "UDP", "SCTP"].includes(p.protocol)) {
      return "Protocol must be TCP, UDP or SCTP.";
    }
    const nodePort = Number(p.nodePort);
    if (nodePort && (nodePort < 30000 || nodePort > 32767)) {
      return "Node ports must be between 30000 and 32767 (or empty to auto-assign).";
    }
  }
  if (f.selector.some((s) => !s.key.trim() && (s.value.trim() || false))) {
    return "Selector rows need a key.";
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
    preview.value = await api.renderServiceYaml(props.namespace, buildPayload());
    previewOpen.value = true;
  } catch (e) {
    error.value = String(e);
  }
}

async function copyPreview() {
  try {
    await navigator.clipboard.writeText(preview.value);
    announce("YAML copied to clipboard.");
  } catch {
    announce("Copy failed.", "assertive");
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
    const created = await api.createService(props.namespace, buildPayload());
    if (!created) return; // user cancelled the confirmation — keep the form
    announce(`Service ${form.value.name.trim()} created.`);
    emit("created");
  } catch (e) {
    error.value = String(e);
    announce(`Failed to create service: ${String(e)}`, "assertive");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="svc-create-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="svc-create-heading" ref="headingEl" class="h6 mb-0" tabindex="-1">
        Create service
      </h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="saving"
        @click="emit('close')"
      >
        Close
      </button>
    </div>

    <form class="row g-2" @submit.prevent="submit">
      <div class="col-12 col-md-6">
        <label for="svc-name" class="form-label mb-1 small">Name</label>
        <input
          id="svc-name"
          v-model="form.name"
          type="text"
          class="form-control form-control-sm"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="svc-type" class="form-label mb-1 small">Type</label>
        <select id="svc-type" v-model="form.type" class="form-select form-select-sm">
          <option value="ClusterIP">ClusterIP (internal only)</option>
          <option value="NodePort">NodePort (external via node IP)</option>
          <option value="LoadBalancer">LoadBalancer (cloud)</option>
        </select>
      </div>

      <!-- Selector -->
      <div class="col-12">
        <fieldset>
          <legend class="h6 small text-body-secondary">
            Selector — pods matching ALL these labels receive traffic
          </legend>
          <div v-for="(row, i) in form.selector" :key="i" class="row g-2 mb-1">
            <div class="col-5">
              <label class="visually-hidden" :for="`svc-sel-key-${i}`">Selector key</label>
              <input
                :id="`svc-sel-key-${i}`"
                v-model="row.key"
                type="text"
                class="form-control form-control-sm"
                placeholder="app"
                autocomplete="off"
              />
            </div>
            <div class="col-5">
              <label class="visually-hidden" :for="`svc-sel-value-${i}`">Selector value</label>
              <input
                :id="`svc-sel-value-${i}`"
                v-model="row.value"
                type="text"
                class="form-control form-control-sm"
                placeholder="gitea"
                autocomplete="off"
              />
            </div>
            <div class="col-2">
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :aria-label="`Remove selector ${i + 1}`"
                @click="removeRow(form.selector, i)"
              >
                Remove
              </button>
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="addRow(form.selector)">
            Add selector
          </button>
        </fieldset>
      </div>

      <!-- Ports -->
      <div class="col-12">
        <fieldset>
          <legend class="h6 small text-body-secondary">Ports</legend>
          <div v-for="(p, i) in form.ports" :key="i" class="row g-2 mb-1 align-items-end">
            <div class="col-6 col-md-3">
              <label class="visually-hidden" :for="`svc-port-${i}`">Service port</label>
              <input
                :id="`svc-port-${i}`"
                v-model.number="p.port"
                type="number"
                min="1"
                max="65535"
                class="form-control form-control-sm"
                placeholder="Port"
              />
            </div>
            <div class="col-6 col-md-3">
              <label class="visually-hidden" :for="`svc-target-${i}`">Target port</label>
              <input
                :id="`svc-target-${i}`"
                v-model="p.targetPort"
                type="text"
                class="form-control form-control-sm"
                placeholder="Target (default: port)"
                autocomplete="off"
              />
            </div>
            <div class="col-6 col-md-2">
              <label class="visually-hidden" :for="`svc-proto-${i}`">Protocol</label>
              <select :id="`svc-proto-${i}`" v-model="p.protocol" class="form-select form-select-sm">
                <option value="TCP">TCP</option>
                <option value="UDP">UDP</option>
                <option value="SCTP">SCTP</option>
              </select>
            </div>
            <div v-if="showNodePort" class="col-6 col-md-2">
              <label class="visually-hidden" :for="`svc-nodeport-${i}`">Node port (empty = auto)</label>
              <input
                :id="`svc-nodeport-${i}`"
                v-model.number="p.nodePort"
                type="number"
                min="30000"
                max="32767"
                class="form-control form-control-sm"
                placeholder="Node port"
              />
            </div>
            <div class="col-12 col-md-2">
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :aria-label="`Remove port ${i + 1}`"
                @click="removePort(i)"
              >
                Remove
              </button>
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="addPort">
            Add port
          </button>
        </fieldset>
      </div>

      <!-- Advanced -->
      <div class="col-12">
        <details>
          <summary class="small text-body-secondary">Advanced options</summary>
          <div class="mt-2 border rounded p-2">
            <div class="row g-2 mb-3">
              <div class="col-6 col-md-4">
                <label for="svc-affinity" class="form-label mb-1 small">Session affinity</label>
                <select id="svc-affinity" v-model="form.sessionAffinity" class="form-select form-select-sm">
                  <option value="">None (default)</option>
                  <option value="ClientIP">ClientIP (stick to one pod)</option>
                </select>
              </div>
              <div class="col-6 col-md-4">
                <label for="svc-clusterip" class="form-label mb-1 small"
                  >Cluster IP (empty = auto)</label
                >
                <input
                  id="svc-clusterip"
                  v-model="form.clusterIP"
                  type="text"
                  class="form-control form-control-sm"
                  placeholder="10.96.0.10"
                  autocomplete="off"
                />
              </div>
            </div>

            <fieldset>
              <legend class="h6 small text-body-secondary">External IPs</legend>
              <div v-for="(ip, i) in form.externalIPs" :key="i" class="row g-2 mb-1">
                <div class="col-10">
                  <label class="visually-hidden" :for="`svc-extip-${i}`">External IP</label>
                  <input
                    :id="`svc-extip-${i}`"
                    v-model="form.externalIPs[i]"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="1.2.3.4"
                    autocomplete="off"
                  />
                </div>
                <div class="col-2">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    :aria-label="`Remove external IP ${i + 1}`"
                    @click="removeExternalIP(i)"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="addExternalIP">
                Add IP
              </button>
            </fieldset>
          </div>
        </details>
      </div>

      <!-- Actions -->
      <div class="col-12 d-flex align-items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="saving"
          @click="togglePreview"
        >
          {{ previewOpen ? "Hide preview" : "Preview YAML" }}
        </button>
        <button type="submit" class="btn btn-sm btn-primary" :disabled="saving">Create</button>
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

      <!-- YAML preview -->
      <div v-if="previewOpen" class="col-12">
        <div class="d-flex align-items-center justify-content-between mb-1">
          <span class="small fw-semibold">Preview YAML</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="copyPreview">
            Copy
          </button>
        </div>
        <pre
          role="document"
          class="small font-monospace border rounded p-2 mb-0"
          style="max-height: 20rem; overflow: auto; white-space: pre"
        >{{ preview }}</pre>
      </div>
    </form>
  </section>
</template>
