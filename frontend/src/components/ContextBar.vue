<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";

const { state, announce, setConnection } = useStore();

const kubeconfig = ref(null); // { path, source, exists }
const contexts = ref([]);
const selected = ref("");
const loading = ref(false);
const error = ref("");

const sourceLabel = {
  explicit: "selected file",
  env: "KUBECONFIG environment variable",
  default: "default (~/.kube/config)",
  none: "none",
};

async function refreshStatus() {
  try {
    kubeconfig.value = await api.kubeconfig();
  } catch (e) {
    error.value = String(e);
  }
}

async function pickFile() {
  error.value = "";
  try {
    const status = await api.selectKubeconfig();
    kubeconfig.value = status;
    contexts.value = [];
    selected.value = "";
    if (status?.exists) {
      announce(`Kubeconfig set to ${status.path}.`);
      await loadContexts();
    } else if (status?.path) {
      announce(`Selected file could not be read: ${status.path}.`, "assertive");
    }
  } catch (e) {
    error.value = String(e);
    announce(`Failed to select kubeconfig: ${error.value}`, "assertive");
  }
}

async function loadContexts() {
  if (!kubeconfig.value?.exists) return;
  loading.value = true;
  error.value = "";
  try {
    const list = await api.listContexts();
    contexts.value = list || [];
    const current = contexts.value.find((c) => c.current);
    selected.value =
      selected.value || current?.name || contexts.value[0]?.name || "";
    announce(`${contexts.value.length} contexts found.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load contexts: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

async function connect() {
  if (!selected.value) return;
  loading.value = true;
  error.value = "";
  try {
    const ctx = await api.connect(selected.value);
    setConnection(ctx);
    announce(`Connected to ${ctx.name}.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to connect: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await refreshStatus();
  // If a kubeconfig is already available (remembered file, env var or the
  // default location), load its contexts immediately so the user can connect.
  if (kubeconfig.value?.exists) {
    await loadContexts();
  }
});

defineExpose({ loadContexts });
</script>

<template>
  <div class="d-flex flex-column gap-2">
    <!-- Kubeconfig source: the primary starting point. -->
    <div class="d-flex align-items-center gap-2 flex-wrap">
      <button type="button" class="btn btn-outline-primary" @click="pickFile">
        Open kubeconfig file…
      </button>

      <p class="mb-0 small">
        <span class="text-body-secondary">Kubeconfig:</span>
        <template v-if="kubeconfig?.path">
          <code>{{ kubeconfig.path }}</code>
          <span class="text-body-secondary">
            ({{ sourceLabel[kubeconfig.source] || kubeconfig.source }})</span
          >
          <span
            v-if="!kubeconfig.exists"
            class="badge text-bg-warning ms-1"
            >not found</span
          >
        </template>
        <span v-else class="text-body-secondary">none selected</span>
      </p>
    </div>

    <p v-if="kubeconfig && !kubeconfig.exists" class="mb-0 small text-body-secondary">
      No readable kubeconfig yet. Choose one of your <code>.yml</code> files with
      <strong>Open kubeconfig file…</strong> — this is the equivalent of setting
      <code>KUBECONFIG</code> in the terminal.
    </p>

    <!-- Context selection + connect: only meaningful once a config is loaded. -->
    <form
      v-if="kubeconfig?.exists"
      class="d-flex align-items-end gap-2 flex-wrap"
      @submit.prevent="connect"
    >
      <div>
        <label for="context-select" class="form-label mb-1">Cluster context</label>
        <select
          id="context-select"
          v-model="selected"
          class="form-select"
          :disabled="loading || contexts.length === 0"
          style="min-width: 16rem"
        >
          <option v-if="contexts.length === 0" value="">No contexts found</option>
          <option v-for="c in contexts" :key="c.name" :value="c.name">
            {{ c.name }}{{ c.current ? " (current)" : "" }}
          </option>
        </select>
      </div>

      <button type="submit" class="btn btn-primary" :disabled="loading || !selected">
        <span
          v-if="loading"
          class="spinner-border spinner-border-sm me-1"
          aria-hidden="true"
        ></span>
        {{ state.connected ? "Reconnect" : "Connect" }}
      </button>

      <button
        type="button"
        class="btn btn-outline-secondary"
        :disabled="loading"
        @click="loadContexts"
      >
        Refresh contexts
      </button>

      <p v-if="state.connected" class="mb-0 ms-2 text-success small">
        Connected to <strong>{{ state.context?.name }}</strong>
      </p>
    </form>

    <p v-if="error" class="mb-0 small text-danger" role="alert">{{ error }}</p>
  </div>
</template>
