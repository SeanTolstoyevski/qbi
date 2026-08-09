<script setup>
import { copyToClipboard } from "../clipboard.js";

defineProps({
  yaml: { type: String, required: true },
  open: { type: Boolean, default: false },
});
</script>

<template>
  <div v-if="open" class="col-12">
    <div class="d-flex align-items-center justify-content-between mb-1">
      <span class="small fw-semibold">Preview YAML</span>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        @click="copyToClipboard(yaml, 'YAML')"
      >
        Copy
      </button>
    </div>
    <pre
      role="document"
      class="small font-monospace border rounded p-2 mb-0 yaml-preview"
      >{{ yaml }}</pre>
  </div>
</template>

<style scoped>
.yaml-preview {
  max-height: 20rem;
  overflow: auto;
  white-space: pre;
}
</style>
