<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { rowsToMap } from "../keyValueRows.js";
import { splitCommand } from "../cronJobHelpers.js";
import PanelHeader from "./PanelHeader.vue";
import KeyValueFieldset from "./KeyValueFieldset.vue";
import YamlPreview from "./YamlPreview.vue";
import {
  validateName,
  qualifiedNameError,
  labelValueError,
  LABEL_VALUE_RE,
} from "../kubeValidation.js";

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
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  onClose: () => emit("close"),
});

// ── spec helpers ────────────────────────────────────────────────────────────

function buildPayload() {
  const f = form.value;
  return {
    name: f.name.trim(),
    image: f.image.trim(),
    command: splitCommand(f.command),
    args: splitCommand(f.args),
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
  const nameErr = validateName(f.name);
  if (nameErr) return nameErr;
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
  // Validate label keys and values.
  for (const r of f.labels) {
    const k = r.key.trim();
    if (k) {
      const ke = qualifiedNameError(k);
      if (ke) return `Label: ${ke}`;
      if (r.value) {
        const le = labelValueError(k, r.value);
        if (le) return le;
      }
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
    <PanelHeader
      ref="header"
      heading-id="deploy-create-heading"
      title="Create deployment"
      :disabled="saving"
      @close="emit('close')"
    />

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
        <KeyValueFieldset
          :rows="form.labels"
          legend="Labels"
          id-prefix="dp-label"
          key-placeholder="app"
          value-placeholder="web"
          add-label="Add label"
          remove-label="label"
          key-label="Label key"
          val-label="Label value"
        />
      </div>

      <!-- Advanced options -->
      <div class="col-12">
        <details>
          <summary class="small text-body-secondary">Advanced options</summary>
          <div class="mt-2 border rounded p-2">
            <!-- Environment -->
            <KeyValueFieldset
              class="mb-3"
              :rows="form.env"
              legend="Environment variables"
              id-prefix="dp-env"
              key-placeholder="NAME"
              value-placeholder="value"
              add-label="Add variable"
              remove-label="env var"
              key-label="Env var name"
              val-label="Env var value"
            />

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
            <KeyValueFieldset
              :rows="form.nodeSelector"
              legend="Node selector"
              id-prefix="dp-node"
              add-label="Add selector"
              remove-label="node selector"
              key-label="Node selector key"
              val-label="Node selector value"
            />
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
      <YamlPreview :yaml="preview" :open="previewOpen" />
    </form>
  </section>
</template>
