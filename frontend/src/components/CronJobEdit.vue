<script setup>
import { ref } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import {
  validSchedule,
  CONCURRENCY_POLICIES,
  SCHEDULE_ERROR,
} from "../cronJobHelpers.js";

/*
 * Edit-cron-job panel. Like the other panels (pod detail, logs, YAML), it is
 * a separate screen opened from the list, takes focus on open, and returns it
 * to the Edit button that triggered it when it closes.
 */

const props = defineProps({
  namespace: { type: String, required: true },
  cronJob: { type: Object, required: true },
});
const emit = defineEmits(["close", "saved"]);
const { announce } = useStore();

const form = ref({
  schedule: props.cronJob.schedule,
  suspend: props.cronJob.suspended,
  concurrencyPolicy: props.cronJob.concurrencyPolicy || "Allow",
});
const saving = ref(false);
const error = ref("");
const headingEl = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: headingEl,
  onClose: () => emit("close"),
});

// A cron schedule is exactly five whitespace-separated fields; validated in cronJobHelpers.js.

async function submit() {
  error.value = "";
  if (!validSchedule(form.value.schedule)) {
    error.value = SCHEDULE_ERROR;
    return;
  }
  saving.value = true;
  try {
    const applied = await api.updateCronJob(
      props.namespace,
      props.cronJob.name,
      {
        schedule: form.value.schedule.trim(),
        suspend: form.value.suspend,
        concurrencyPolicy: form.value.concurrencyPolicy,
      },
    );
    if (!applied) return; // user cancelled the confirmation — keep the form
    announce(`Cron job ${props.cronJob.name} updated.`);
    emit("saved");
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="cj-edit-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="cj-edit-heading" ref="headingEl" class="h6 mb-0" tabindex="-1">
        Edit cron job: {{ cronJob.name }}
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
      <div class="col-12 col-md-5">
        <label for="cj-edit-schedule" class="form-label mb-1 small"
          >Schedule (cron)</label
        >
        <input
          id="cj-edit-schedule"
          v-model="form.schedule"
          type="text"
          class="form-control form-control-sm"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-4">
        <label for="cj-edit-policy" class="form-label mb-1 small"
          >Concurrency policy</label
        >
        <select
          id="cj-edit-policy"
          v-model="form.concurrencyPolicy"
          class="form-select form-select-sm"
        >
          <option
            v-for="p in CONCURRENCY_POLICIES"
            :key="p.value"
            :value="p.value"
          >
            {{ p.label }}
          </option>
        </select>
      </div>
      <div class="col-12 col-md-3 d-flex align-items-end">
        <div class="form-check mb-0">
          <input
            id="cj-edit-suspend"
            v-model="form.suspend"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="cj-edit-suspend"
            >Suspended</label
          >
        </div>
      </div>
      <div class="col-12 d-flex align-items-center gap-2">
        <button type="submit" class="btn btn-sm btn-primary" :disabled="saving">
          Apply
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
  </section>
</template>
