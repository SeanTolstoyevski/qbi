<script setup>
import { ref } from "vue";

defineProps({
  headingId: { type: String, required: true },
  title: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});

defineEmits(["close"]);

const headingEl = ref(null);
defineExpose({ headingEl });
</script>

<template>
  <div class="d-flex align-items-center justify-content-between mb-2">
    <h2 :id="headingId" ref="headingEl" class="h6 mb-0" tabindex="-1">
      {{ title }}
    </h2>
    <slot></slot>
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      :disabled="disabled"
      @click="$emit('close')"
    >
      Close
    </button>
  </div>
</template>
