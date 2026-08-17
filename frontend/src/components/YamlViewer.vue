<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { copyToClipboard } from "../clipboard.js";
import PanelHeader from "./PanelHeader.vue";

const props = defineProps({
  namespace: { type: String, default: "" }, // empty for cluster-scoped
  kind: { type: String, required: true },
  name: { type: String, required: true },
});

const emit = defineEmits(["close"]);
const { announce } = useStore();

const yaml = ref("");
const loading = ref(false);
const error = ref("");
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  onClose: () => emit("close"),
});

async function load() {
  loading.value = true;
  error.value = "";
  yaml.value = "";
  try {
    yaml.value = await api.getResourceYaml(
      props.namespace,
      props.kind,
      props.name,
    );
    announce(`YAML for ${props.kind} ${props.name} loaded.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load YAML: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
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
    <PanelHeader
      ref="header"
      heading-id="yaml-heading"
      :title="`YAML: ${kind} / ${name}`"
      @close="emit('close')"
    >
      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || !yaml"
          @click="copyToClipboard(yaml, 'YAML')"
        >
          Copy
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="load"
        >
          <span class="visually-hidden">Refresh YAML</span>
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
    </PanelHeader>

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <pre
      v-else-if="yaml"
      role="document"
      class="flex-grow-1 overflow-auto border rounded p-2 small font-monospace mb-0"
      style="white-space: pre; tab-size: 2"
      >{{ yaml }}</pre>
  </section>
</template>
