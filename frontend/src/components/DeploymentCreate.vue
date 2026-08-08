<script setup>
import { ref } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { copyToClipboard } from "../clipboard.js";
import { addRow, removeRow, rowsToMap } from "../keyValueRows.js";

/*
 * Create-deployment panel. It is a helper that drafts a real Deployment
 * manifest: the form feeds a spec, the backend renders the exact YAML that
 * would be applied (Preview), and creation goes through the native
 * confirmation. Same focus-managed panel architecture as the other screens.
 */

const props = defineProps({
  namespace: { type: String, required: true },
});
const emit = defineEmits(["close", "created"]);
const { announce } = useStore();

const form = ref({
  name: "",
  image: "",
  replicas: 1,
  port: "",
  protocol: "TCP",
  command: "",
  args: "",
  labels: [{ key: "", value: "" }],
  env: [{ key: "", value: "" }],
  cpuRequest: "",
  memoryRequest: "",
  cpuLimit: "",
  memoryLimit: "",
  imagePullPolicy: "", // "" = cluster default (IfNotPresent)
  updateStrategy: "", // "" = cluster default (RollingUpdate)
  nodeSelector: [{ key: "", value: "" }],
});

const preview = ref("");
const previewOpen = ref(false);
const saving = ref(false);
const error = ref("");
const headingEl = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: headingEl,
  onClose: () => emit("close"),
});

// ── spec helpers ────────────────────────────────────────────────────────────
function split(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

function buildPayload() {
  const f = form.value;
  return {
    name: f.name.trim(),
    image: f.image.trim(),
    command: split(f.command),
    args: split(f.args),
    replicas: Number(f.replicas) || 0,
    port: Number(f.port) || 0,
    protocol: f.protocol,
    labels: rowsToMap(f.labels),
    env: f.env
      .filter((e) => e.key.trim())
      .map((e) => ({ name: e.key.trim(), value: e.value })),
    resources: {
      cpuRequest: f.cpuRequest.trim(),
      memoryRequest: f.memoryRequest.trim(),
      cpuLimit: f.cpuLimit.trim(),
      memoryLimit: f.memoryLimit.trim(),
    },
    imagePullPolicy: f.imagePullPolicy,
    updateStrategy: f.updateStrategy,
    nodeSelector: rowsToMap(f.nodeSelector),
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Kubernetes quantity: digits, optional decimal, optional unit suffix.
const QUANTITY = /^\d+(\.\d+)?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

function validate() {
  const f = form.value;
  if (!f.name.trim()) return "Name is required.";
  if (!f.image.trim()) return "Image is required.";
  if (Number(f.replicas) < 0) return "Replicas must be zero or more.";
  const port = Number(f.port);
  if (port && (port < 1 || port > 65535))
    return "Port must be between 1 and 65535.";
  if (f.env.some((e) => e.key.trim() && !ENV_NAME.test(e.key.trim()))) {
    return "Environment variable names must start with a letter or underscore.";
  }
  const quantities = [
    ["cpu request", f.cpuRequest],
    ["memory request", f.memoryRequest],
    ["cpu limit", f.cpuLimit],
    ["memory limit", f.memoryLimit],
  ];
  for (const [label, q] of quantities) {
    if (q.trim() && !QUANTITY.test(q.trim())) {
      return `Invalid ${label} "${q.trim()}". Use Kubernetes quantities, e.g. 100m, 128Mi.`;
    }
  }
  return "";
}

// ── actions ─────────────────────────────────────────────────────────────────
// Preview renders the exact manifest via the backend, so what you see is what
// gets created — and what you can copy for drafting YAML elsewhere.
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
    preview.value = await api.renderDeploymentYaml(
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
    const created = await api.createDeployment(props.namespace, buildPayload());
    if (!created) return; // user cancelled the confirmation — keep the form
    announce(`Deployment ${form.value.name.trim()} created.`);
    emit("created");
  } catch (e) {
    error.value = String(e);
    announce(`Failed to create deployment: ${String(e)}`, "assertive");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="deploy-create-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2
        id="deploy-create-heading"
        ref="headingEl"
        class="h6 mb-0"
        tabindex="-1"
      >
        Create deployment
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
        <label for="dp-name" class="form-label mb-1 small">Name</label>
        <input
          id="dp-name"
          v-model="form.name"
          type="text"
          class="form-control form-control-sm"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="dp-image" class="form-label mb-1 small">Image</label>
        <input
          id="dp-image"
          v-model="form.image"
          type="text"
          class="form-control form-control-sm"
          placeholder="nginx:1.27"
          autocomplete="off"
        />
      </div>
      <div class="col-6 col-md-2">
        <label for="dp-replicas" class="form-label mb-1 small">Replicas</label>
        <input
          id="dp-replicas"
          v-model.number="form.replicas"
          type="number"
          min="0"
          class="form-control form-control-sm"
        />
      </div>
      <div class="col-6 col-md-2">
        <label for="dp-port" class="form-label mb-1 small">Port</label>
        <input
          id="dp-port"
          v-model.number="form.port"
          type="number"
          min="0"
          max="65535"
          class="form-control form-control-sm"
          placeholder="8080"
        />
      </div>
      <div class="col-12 col-md-2">
        <label for="dp-protocol" class="form-label mb-1 small">Protocol</label>
        <select
          id="dp-protocol"
          v-model="form.protocol"
          class="form-select form-select-sm"
        >
          <option value="TCP">TCP</option>
          <option value="UDP">UDP</option>
        </select>
      </div>
      <div class="col-12 col-md-6">
        <label for="dp-command" class="form-label mb-1 small"
          >Command (optional, space-separated)</label
        >
        <input
          id="dp-command"
          v-model="form.command"
          type="text"
          class="form-control form-control-sm"
          placeholder="/bin/sh"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="dp-args" class="form-label mb-1 small"
          >Args (optional, space-separated)</label
        >
        <input
          id="dp-args"
          v-model="form.args"
          type="text"
          class="form-control form-control-sm"
          placeholder="-c sleep 3600"
          autocomplete="off"
        />
      </div>

      <!-- Labels -->
      <div class="col-12">
        <fieldset>
          <legend class="h6 small text-body-secondary">Labels</legend>
          <div v-for="(row, i) in form.labels" :key="i" class="row g-2 mb-1">
            <div class="col-5">
              <label class="visually-hidden" :for="`dp-label-key-${i}`"
                >Label key</label
              >
              <input
                :id="`dp-label-key-${i}`"
                v-model="row.key"
                type="text"
                class="form-control form-control-sm"
                placeholder="key"
                autocomplete="off"
              />
            </div>
            <div class="col-5">
              <label class="visually-hidden" :for="`dp-label-value-${i}`"
                >Label value</label
              >
              <input
                :id="`dp-label-value-${i}`"
                v-model="row.value"
                type="text"
                class="form-control form-control-sm"
                placeholder="value"
                autocomplete="off"
              />
            </div>
            <div class="col-2">
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :aria-label="`Remove label ${i + 1}`"
                @click="removeRow(form.labels, i)"
              >
                Remove
              </button>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="addRow(form.labels)"
          >
            Add label
          </button>
        </fieldset>
      </div>

      <!-- Advanced options -->
      <div class="col-12">
        <details>
          <summary class="small text-body-secondary">Advanced options</summary>
          <div class="mt-2 border rounded p-2">
            <!-- Environment -->
            <fieldset class="mb-3">
              <legend class="h6 small text-body-secondary">
                Environment variables
              </legend>
              <div v-for="(row, i) in form.env" :key="i" class="row g-2 mb-1">
                <div class="col-5">
                  <label class="visually-hidden" :for="`dp-env-key-${i}`"
                    >Env var name</label
                  >
                  <input
                    :id="`dp-env-key-${i}`"
                    v-model="row.key"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="NAME"
                    autocomplete="off"
                  />
                </div>
                <div class="col-5">
                  <label class="visually-hidden" :for="`dp-env-value-${i}`"
                    >Env var value</label
                  >
                  <input
                    :id="`dp-env-value-${i}`"
                    v-model="row.value"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="value"
                    autocomplete="off"
                  />
                </div>
                <div class="col-2">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    :aria-label="`Remove env var ${i + 1}`"
                    @click="removeRow(form.env, i)"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                @click="addRow(form.env)"
              >
                Add variable
              </button>
            </fieldset>

            <!-- Resources -->
            <fieldset class="mb-3">
              <legend class="h6 small text-body-secondary">
                Resources (Kubernetes quantities, e.g. 100m, 128Mi)
              </legend>
              <div class="row g-2">
                <div class="col-6 col-md-3">
                  <label for="dp-cpu-req" class="form-label mb-1 small"
                    >CPU request</label
                  >
                  <input
                    id="dp-cpu-req"
                    v-model="form.cpuRequest"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="100m"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label for="dp-mem-req" class="form-label mb-1 small"
                    >Memory request</label
                  >
                  <input
                    id="dp-mem-req"
                    v-model="form.memoryRequest"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="128Mi"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label for="dp-cpu-lim" class="form-label mb-1 small"
                    >CPU limit</label
                  >
                  <input
                    id="dp-cpu-lim"
                    v-model="form.cpuLimit"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="500m"
                    autocomplete="off"
                  />
                </div>
                <div class="col-6 col-md-3">
                  <label for="dp-mem-lim" class="form-label mb-1 small"
                    >Memory limit</label
                  >
                  <input
                    id="dp-mem-lim"
                    v-model="form.memoryLimit"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="512Mi"
                    autocomplete="off"
                  />
                </div>
              </div>
            </fieldset>

            <!-- Strategy / pull policy / placement -->
            <div class="row g-2 mb-3">
              <div class="col-6 col-md-4">
                <label for="dp-pull" class="form-label mb-1 small"
                  >Image pull policy</label
                >
                <select
                  id="dp-pull"
                  v-model="form.imagePullPolicy"
                  class="form-select form-select-sm"
                >
                  <option value="">Default (IfNotPresent)</option>
                  <option value="Always">Always</option>
                  <option value="IfNotPresent">IfNotPresent</option>
                  <option value="Never">Never</option>
                </select>
              </div>
              <div class="col-6 col-md-4">
                <label for="dp-strategy" class="form-label mb-1 small"
                  >Update strategy</label
                >
                <select
                  id="dp-strategy"
                  v-model="form.updateStrategy"
                  class="form-select form-select-sm"
                >
                  <option value="">Default (RollingUpdate)</option>
                  <option value="RollingUpdate">RollingUpdate</option>
                  <option value="Recreate">Recreate</option>
                </select>
              </div>
            </div>

            <!-- Node selector -->
            <fieldset>
              <legend class="h6 small text-body-secondary">
                Node selector
              </legend>
              <div
                v-for="(row, i) in form.nodeSelector"
                :key="i"
                class="row g-2 mb-1"
              >
                <div class="col-5">
                  <label class="visually-hidden" :for="`dp-node-key-${i}`"
                    >Node selector key</label
                  >
                  <input
                    :id="`dp-node-key-${i}`"
                    v-model="row.key"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="key"
                    autocomplete="off"
                  />
                </div>
                <div class="col-5">
                  <label class="visually-hidden" :for="`dp-node-value-${i}`"
                    >Node selector value</label
                  >
                  <input
                    :id="`dp-node-value-${i}`"
                    v-model="row.value"
                    type="text"
                    class="form-control form-control-sm"
                    placeholder="value"
                    autocomplete="off"
                  />
                </div>
                <div class="col-2">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    :aria-label="`Remove node selector ${i + 1}`"
                    @click="removeRow(form.nodeSelector, i)"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                @click="addRow(form.nodeSelector)"
              >
                Add selector
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
        <button type="submit" class="btn btn-sm btn-primary" :disabled="saving">
          Create
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

      <!-- YAML preview: what will be created, and copyable for drafting -->
      <div v-if="previewOpen" class="col-12">
        <div class="d-flex align-items-center justify-content-between mb-1">
          <span class="small fw-semibold">Preview YAML</span>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="copyToClipboard(preview.value, 'YAML')"
          >
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
