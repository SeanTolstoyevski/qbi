<script setup>
import { computed, nextTick, onMounted, ref } from "vue";

const props = defineProps({
  error: { type: String, default: "" },
});

const emit = defineEmits(["acknowledged", "dismiss"]);

const steps = [
  {
    headingId: "welcome-step-1",
    title: "QBI follows your instructions",
    paragraphs: [
      "QBI is a tool for inspecting and lightly managing Kubernetes clusters.",
      "It has no judgement of its own: it never decides what to do, and it never changes your cluster by itself. Every action it takes is one you asked for.",
    ],
  },
  {
    headingId: "welcome-step-2",
    title: "Nothing changes without your command",
    paragraphs: [
      "QBI can create, edit, restart, scale and delete cluster resources.",
      "It acts only when you give an explicit command, and every change asks for your confirmation first. The decisions are always yours — and so are their consequences.",
    ],
  },
  {
    headingId: "welcome-step-3",
    title: "Tested, not infallible",
    paragraphs: [
      "QBI is built with care and covered by extensive tests. Still, no software is free of defects, and an unexpected problem could make an action fail or affect your cluster in a way you did not intend.",
      "You are responsible for the changes you make and for their results.",
      "This screen is information, not a legal agreement. It appears once, on first use.",
    ],
  },
];

const step = ref(0);
const acknowledged = ref(false);
const headingEl = ref(null);

const current = computed(() => steps[step.value]);
const isFirst = computed(() => step.value === 0);
const isLast = computed(() => step.value === steps.length - 1);

function focusCurrentHeading() {
  nextTick(() => headingEl.value?.focus());
}

function next() {
  if (isLast.value) return;
  step.value += 1;
  focusCurrentHeading();
}

function back() {
  if (isFirst.value) return;
  step.value -= 1;
  focusCurrentHeading();
}

function dismiss() {
  emit("dismiss");
}

function onKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  }
}

onMounted(focusCurrentHeading);
</script>

<template>
  <div class="welcome-backdrop">
    <div
      role="dialog"
      aria-modal="true"
      :aria-labelledby="current.headingId"
      aria-describedby="welcome-step-indicator"
      class="welcome-dialog shadow-lg"
      @keydown="onKeydown"
    >
      <div class="d-flex align-items-start justify-content-between gap-2">
        <p
          id="welcome-step-indicator"
          class="text-body-secondary small mb-0 mt-1"
        >
          Step {{ step + 1 }} of {{ steps.length }}
        </p>
        <button
          type="button"
          class="btn-close"
          aria-label="Close welcome screen"
          @click="dismiss"
        ></button>
      </div>

      <h1 :id="current.headingId" ref="headingEl" class="h3 mt-3 mb-2" tabindex="-1">
        {{ current.title }}
      </h1>

      <p v-for="(paragraph, i) in current.paragraphs" :key="i" class="mb-2">
        {{ paragraph }}
      </p>

      <div v-if="isLast" class="form-check mt-3">
        <input
          id="welcome-acknowledge"
          v-model="acknowledged"
          class="form-check-input"
          type="checkbox"
        />
        <label class="form-check-label" for="welcome-acknowledge">
          I understand that changes to my cluster are my responsibility.
        </label>
      </div>

      <div v-if="error" class="alert alert-danger mt-3" role="alert">
        {{ error }}
      </div>

      <div class="d-flex justify-content-end gap-2 mt-4">
        <button
          type="button"
          class="btn btn-outline-secondary"
          :disabled="isFirst"
          @click="back"
        >
          <i class="bi bi-arrow-left me-1" aria-hidden="true"></i>
          Back
        </button>
        <button
          v-if="!isLast"
          type="button"
          class="btn btn-primary"
          @click="next"
        >
          Next
          <i class="bi bi-arrow-right ms-1" aria-hidden="true"></i>
        </button>
        <button
          v-else
          type="button"
          class="btn btn-success"
          :disabled="!acknowledged"
          @click="emit('acknowledged')"
        >
          <i class="bi bi-check-lg me-1" aria-hidden="true"></i>
          Get started
        </button>
      </div>
    </div>
  </div>
</template>
