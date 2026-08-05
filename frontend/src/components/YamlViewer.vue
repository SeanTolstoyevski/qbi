<script setup>
import { ref } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";

const props = defineProps({
  namespace: { type: String, default: "" }, // empty for cluster-scoped
  kind:      { type: String, required: true },
  name:      { type: String, required: true },
});

const emit = defineEmits(["close"]);
const { announce } = useStore();

const yaml = ref("");
const loading = ref(false);
const error = ref("");
const headingEl = ref(null);

const { onKeydown } = useReturnFocus({ focusTarget: headingEl, onClose: () => emit("close") });

async function load() {
  loading.value = true;
  error.value = "";
  yaml.value = "";
  try {
    yaml.value = await api.getResourceYaml(props.namespace, props.kind, props.name);
    announce(`YAML for ${props.kind} ${props.name} loaded.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load YAML: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(yaml.value);
    announce("YAML copied to clipboard.");
  } catch {
    announce("Copy failed.", "assertive");
  }
}

load();
</script>

<template>
  <section
    aria-labelledby="yaml-heading"
    class="h-100 d-flex flex-column"
    @keydown="onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2 gap-2">
      <h2 id="yaml-heading" ref="headingEl" class="h6 mb-0" tabindex="-1">
        YAML: {{ kind }} / {{ name }}
      </h2>
      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || !yaml"
          @click="copy"
        >
          Copy
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="load">
          <span class="visually-hidden">Refresh YAML</span>
          <span aria-hidden="true">⟳</span>
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="emit('close')">
          Close
        </button>
      </div>
    </div>

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <!-- role="document" lets screen readers browse the YAML content freely  -->
    <!-- without inheriting application keyboard handling from the section.  -->
    <pre
      v-else-if="yaml"
      role="document"
      class="flex-grow-1 overflow-auto border rounded p-2 small font-monospace mb-0"
      style="white-space: pre; tab-size: 2"
    >{{ yaml }}</pre>
  </section>
</template>
