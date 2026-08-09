<script setup>
import { ref, nextTick, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { newRow, validateRows, rowsToMap } from "../useSecretDraft.js";
import SecretKeyRows from "./SecretKeyRows.vue";
import { validateName } from "../kubeValidation.js";
import PanelHeader from "./PanelHeader.vue";

/*
 * Create-secret panel, opened from the "New secret" button in the tab
 * toolbar. Two editing surfaces, chosen with tabs:
 *
 *   Form — name, type and key/value rows. Values are plain text in
 *          transparent mode and raw base64 in base64 mode; the backend
 *          validates base64 at create time.
 *   YAML — a starter manifest the user edits directly (stringData in
 *          transparent mode, data/base64 in base64 mode), applied verbatim.
 *
 * Same focus-managed panel architecture as the other create screens: focus
 * moves to the heading on open and returns to the New-secret button on close.
 */

const props = defineProps({
  namespace: { type: String, required: true },
  // "transparent" | "base64"
  mode: { type: String, default: "transparent" },
});
const emit = defineEmits(["close", "created"]);
const { announce } = useStore();

const view = ref("form"); // "form" | "yaml"

const form = ref({ name: "", type: "" });
const draft = ref([newRow({ isNew: true })]);
const saving = ref(false);
const error = ref("");
const header = ref(null);

const yamlText = ref("");
const yamlSaving = ref(false);
const yamlError = ref("");

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  onClose: () => emit("close"),
});

// Common secret types offered in the type input's datalist. The field is a
// free-text input so unusual types can still be typed.
const SECRET_TYPES = [
  "Opaque",
  "kubernetes.io/tls",
  "kubernetes.io/basic-auth",
  "kubernetes.io/dockerconfigjson",
  "kubernetes.io/ssh-auth",
  "kubernetes.io/service-account-token",
];

const isTls = ref(false);
function watchType() {
  isTls.value = form.value.type === "kubernetes.io/tls";
}

// A clean starter manifest for the YAML surface, in the current value mode:
// stringData (plain text) in transparent mode, data (base64) in base64 mode.
function starterYaml() {
  if (props.mode === "base64") {
    return `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
data:
  # Values are raw base64 here — encode plain text yourself, e.g.:
  #   printf 'value' | base64
  username: cXVpY2s=
  password: cGFzcw==
`;
  }
  return `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
stringData:
  # Plain text — Kubernetes encodes these for you.
  username: admin
  password: change-me
`;
}

function selectView(v) {
  view.value = v;
  if (v === "yaml" && yamlText.value === "") {
    yamlText.value = starterYaml();
    nextTick(() => document.getElementById("secret-create-yaml")?.focus());
  } else if (v === "form") {
    nextTick(() => document.getElementById("secret-create-name")?.focus());
  }
}

// ── row helpers (mirror the edit panel) ────────────────────────────────────
function addKey() {
  const row = newRow({ isNew: true });
  draft.value.push(row);
  nextTick(() => document.getElementById(`secret-key-${row.id}`)?.focus());
}
function toggleDelete(row) {
  row.deleted = !row.deleted;
}

// ── form create ────────────────────────────────────────────────────────────
async function submitForm() {
  error.value = "";
  const name = form.value.name.trim();
  const nameErr = validateName(name);
  if (nameErr) {
    error.value = nameErr;
    announce(nameErr, "assertive");
    return;
  }
  const err = validateRows(draft.value, props.mode);
  if (err) {
    error.value = err;
    announce(err, "assertive");
    return;
  }
  saving.value = true;
  try {
    const created = await api.createSecret(
      props.namespace,
      { name, type: form.value.type.trim(), data: rowsToMap(draft.value) },
      props.mode,
    );
    if (!created) return; // user cancelled the confirmation — keep the form
    announce(`Secret ${name} created.`);
    emit("created");
  } catch (e) {
    error.value = String(e);
    announce(`Failed to create secret: ${error.value}`, "assertive");
  } finally {
    saving.value = false;
  }
}

// ── YAML create ────────────────────────────────────────────────────────────
async function submitYaml() {
  yamlError.value = "";
  if (!yamlText.value.trim()) {
    yamlError.value = "The manifest is empty.";
    announce(yamlError.value, "assertive");
    return;
  }
  yamlSaving.value = true;
  try {
    const created = await api.createSecretFromYaml(
      props.namespace,
      yamlText.value,
    );
    if (!created) return; // user cancelled the confirmation — keep editing
    announce("Secret created from YAML.");
    emit("created");
  } catch (e) {
    yamlError.value = String(e);
    announce(`Failed to create secret: ${yamlError.value}`, "assertive");
  } finally {
    yamlSaving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="secret-create-heading"
    class="h-100"
    @keydown="onKeydown"
  >
    <PanelHeader
      ref="header"
      heading-id="secret-create-heading"
      title="New secret"
      :disabled="saving || yamlSaving"
      @close="emit('close')"
    />

    <div
      role="tablist"
      aria-label="Create secret editor"
      class="nav nav-tabs mb-2"
    >
      <button
        id="secret-create-tab-form"
        type="button"
        role="tab"
        class="nav-link text-capitalize"
        :class="{ active: view === 'form' }"
        :tabindex="view === 'form' ? 0 : -1"
        :aria-selected="view === 'form'"
        :aria-controls="'secret-create-panel-form'"
        @click="selectView('form')"
      >
        Form
      </button>
      <button
        id="secret-create-tab-yaml"
        type="button"
        role="tab"
        class="nav-link text-capitalize"
        :class="{ active: view === 'yaml' }"
        :tabindex="view === 'yaml' ? 0 : -1"
        :aria-selected="view === 'yaml'"
        :aria-controls="'secret-create-panel-yaml'"
        @click="selectView('yaml')"
      >
        YAML
      </button>
    </div>

    <!-- ── FORM ─────────────────────────────────────────────────────── -->
    <div
      v-show="view === 'form'"
      id="secret-create-panel-form"
      role="tabpanel"
      aria-labelledby="secret-create-tab-form"
    >
      <form class="row g-2" @submit.prevent="submitForm">
        <div class="col-12 col-md-6">
          <label for="secret-create-name" class="form-label mb-1 small"
            >Name</label
          >
          <input
            id="secret-create-name"
            v-model="form.name"
            type="text"
            class="form-control form-control-sm"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="col-12 col-md-6">
          <label for="secret-create-type" class="form-label mb-1 small"
            >Type</label
          >
          <input
            id="secret-create-type"
            v-model="form.type"
            type="text"
            class="form-control form-control-sm"
            list="secret-types"
            autocomplete="off"
            placeholder="Opaque"
            @input="watchType"
          />
          <datalist id="secret-types">
            <option v-for="t in SECRET_TYPES" :key="t" :value="t" />
          </datalist>
        </div>

        <div class="col-12">
          <p v-if="isTls" class="small text-body-secondary mb-1">
            TLS secrets normally contain a <code>tls.crt</code> and a
            <code>tls.key</code> key.
          </p>
          <p v-if="mode === 'base64'" class="small text-body-secondary mb-1">
            Values are stored as raw base64 — encode them yourself before
            saving.
          </p>
          <p v-else class="small text-body-secondary mb-1">
            Values are plain text — QBI encodes them to base64 for storage.
          </p>
        </div>

        <div class="col-12">
          <SecretKeyRows
            :rows="draft"
            :mode="mode"
            :readonly-keys="false"
            @add="addKey"
            @toggle-delete="toggleDelete"
          />
        </div>

        <div class="col-12 d-flex align-items-center gap-2">
          <button
            type="submit"
            class="btn btn-sm btn-primary"
            :disabled="saving"
          >
            <span
              v-if="saving"
              class="spinner-border spinner-border-sm me-1"
              aria-hidden="true"
            ></span>
            Create secret
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
      </form>
    </div>

    <!-- ── YAML ─────────────────────────────────────────────────────── -->
    <div
      v-show="view === 'yaml'"
      id="secret-create-panel-yaml"
      role="tabpanel"
      aria-labelledby="secret-create-tab-yaml"
    >
      <p class="small text-body-secondary">
        {{
          mode === "base64"
            ? "Values are raw base64. You can also use stringData for plain text."
            : "Plain-text stringData — Kubernetes encodes it. You can also use data with base64."
        }}
      </p>
      <p v-if="yamlError" class="text-danger small" role="alert">
        {{ yamlError }}
      </p>
      <textarea
        id="secret-create-yaml"
        v-model="yamlText"
        class="form-control font-monospace"
        rows="18"
        spellcheck="false"
        aria-label="Secret YAML manifest"
      ></textarea>
      <div class="d-flex gap-2 mt-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="yamlSaving"
          @click="yamlText = starterYaml()"
        >
          Reset template
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="yamlSaving"
          @click="submitYaml"
        >
          <span
            v-if="yamlSaving"
            class="spinner-border spinner-border-sm me-1"
            aria-hidden="true"
          ></span>
          Create from YAML
        </button>
      </div>
    </div>
  </section>
</template>
