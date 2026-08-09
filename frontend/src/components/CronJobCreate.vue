<script setup>
import { ref } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import {
  validSchedule,
  splitCommand,
  CONCURRENCY_POLICIES,
  SCHEDULE_ERROR,
} from "../cronJobHelpers.js";
import { validateName } from "../kubeValidation.js";

const props = defineProps({
  namespace: { type: String, required: true },
});
const emit = defineEmits(["close", "created"]);
const { announce } = useStore();

const form = ref({
  name: "",
  schedule: "",
  image: "",
  command: "",
  suspend: false,
  concurrencyPolicy: "Allow", // kube default; user may pick Forbid/Replace
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
  const c = form.value;
  error.value = "";
  const nameErr = validateName(c.name);
  if (nameErr) {
    error.value = nameErr;
    announce(nameErr, "assertive");
    return;
  }
  if (!c.schedule || !c.image) {
    error.value = "Name, schedule and image are required.";
    return;
  }
  if (!validSchedule(c.schedule)) {
    error.value = SCHEDULE_ERROR;
    return;
  }
  saving.value = true;
  try {
    const created = await api.createCronJob(props.namespace, {
      name: c.name.trim(),
      schedule: c.schedule.trim(),
      image: c.image.trim(),
      command: splitCommand(c.command),
      suspend: c.suspend,
      concurrencyPolicy: c.concurrencyPolicy,
    });
    if (!created) return;
    announce(`Cron job ${c.name.trim()} created.`);
    emit("created");
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    aria-labelledby="cj-create-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="cj-create-heading" ref="headingEl" class="h6 mb-0" tabindex="-1">
        Create cron job
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
        <label for="cj-name" class="form-label mb-1 small">Name</label>
        <input
          id="cj-name"
          v-model="form.name"
          type="text"
          class="form-control form-control-sm"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="cj-schedule" class="form-label mb-1 small"
          >Schedule (cron)</label
        >
        <input
          id="cj-schedule"
          v-model="form.schedule"
          type="text"
          class="form-control form-control-sm"
          placeholder="0 * * * *"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="cj-image" class="form-label mb-1 small">Image</label>
        <input
          id="cj-image"
          v-model="form.image"
          type="text"
          class="form-control form-control-sm"
          placeholder="busybox"
          autocomplete="off"
        />
      </div>
      <div class="col-12 col-md-6">
        <label for="cj-concurrency" class="form-label mb-1 small"
          >Concurrency policy</label
        >
        <select
          id="cj-concurrency"
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
      <div class="col-12">
        <label for="cj-command" class="form-label mb-1 small"
          >Command (space-separated, optional)</label
        >
        <input
          id="cj-command"
          v-model="form.command"
          type="text"
          class="form-control form-control-sm"
          autocomplete="off"
        />
      </div>
      <div class="col-12 d-flex align-items-center gap-3">
        <div class="form-check mb-0">
          <input
            id="cj-suspend"
            v-model="form.suspend"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="cj-suspend"
            >Create suspended</label
          >
        </div>
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
    </form>
  </section>
</template>
