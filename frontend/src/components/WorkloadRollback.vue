<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import PanelHeader from "./PanelHeader.vue";
import ListBox from "./ListBox.vue";

/*
 * Rollback picker: lists the rollout history of a Deployment, StatefulSet or
 * DaemonSet and rolls the workload back to the selected revision. The write
 * itself is confirmed by a native dialog in the backend, so the panel only
 * disables its button while the call is in flight.
 */
const props = defineProps({
  namespace: { type: String, required: true },
  kind: { type: String, required: true },
  name: { type: String, required: true },
  opener: { type: Object, default: null },
  // Revision to preselect when the picker was opened from a specific version
  // in the Recent rollouts table; null picks the newest non-current one.
  preselect: { type: Number, default: null },
});

const emit = defineEmits(["close", "rolled-back"]);
const { announce } = useStore();

const revisions = ref([]);
const loading = ref(false);
const error = ref("");
const selected = ref(null); // String(revision) of the picker selection
const rollingBack = ref(false);
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  opener: props.opener,
  onClose: () => emit("close"),
});

// The current revision is the one the controller runs now; rolling back to it
// is a no-op, so it is shown as context and excluded from the picker.
const current = computed(() => revisions.value.find((r) => r.current) || null);

const targets = computed(() => revisions.value.filter((r) => !r.current));

const options = computed(() =>
  targets.value.map((r) => ({
    value: String(r.revision),
    label: `Revision ${r.revision}`,
    description: revisionSummary(r),
  })),
);

function revisionSummary(r) {
  const parts = [r.images.join(", ") || "no images"];
  if (r.changeCause) parts.push(r.changeCause);
  if (r.replicas) parts.push(`${r.replicas} ready`);
  if (r.age) parts.push(`${r.age} ago`);
  return parts.join(" · ");
}

async function load() {
  loading.value = true;
  error.value = "";
  revisions.value = [];
  selected.value = null;
  try {
    const revs = await api.listWorkloadRevisions(
      props.namespace,
      props.kind,
      props.name,
    );
    revisions.value = revs || [];
    let first = targets.value[0];
    if (props.preselect != null) {
      const wanted = targets.value.find((r) => r.revision === props.preselect);
      if (wanted) first = wanted;
    }
    if (first) selected.value = String(first.revision);
    announce(
      `${props.kind} ${props.name}: ${targets.value.length} rollback target${
        targets.value.length === 1 ? "" : "s"
      }${current.value ? `, current revision ${current.value.revision}` : ""}.`,
    );
  } catch (e) {
    error.value = String(e);
    announce(
      `Failed to load revisions for ${props.kind} ${props.name}: ${error.value}`,
      "assertive",
    );
  } finally {
    loading.value = false;
  }
}

async function rollBack() {
  if (!selected.value) return;
  rollingBack.value = true;
  try {
    const result = await api.rollbackWorkload(
      props.namespace,
      props.kind,
      props.name,
      Number(selected.value),
    );
    if (result?.applied) {
      emit("rolled-back", { revision: Number(selected.value) });
    } else if (result?.skipped) {
      announce(
        `${props.kind} ${props.name} already runs the template of revision ${selected.value}; nothing to roll back.`,
      );
    }
  } catch (e) {
    announce(
      `Failed to roll back ${props.kind} ${props.name}: ${String(e)}`,
      "assertive",
    );
  } finally {
    rollingBack.value = false;
  }
}

load();
</script>

<template>
  <section
    aria-labelledby="rollback-heading"
    class="h-100 d-flex flex-column"
    @keydown="onKeydown"
  >
    <PanelHeader
      ref="header"
      heading-id="rollback-heading"
      :title="`Roll back: ${kind} / ${name}`"
      @close="emit('close')"
    />

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="targets.length === 0" class="text-muted small">
      No rollback targets. The rollout history of this workload is empty, or
      every retained revision already matches the current template.
    </p>
    <template v-else>
      <p class="text-body-secondary small mb-2">
        <span v-if="current" class="fw-semibold">
          Current revision: {{ current.revision }}
        </span>
        <span v-if="current" class="ms-1">
          — {{ current.images.join(", ") || "no images" }}
        </span>
        <span v-else>No current revision recorded.</span>
      </p>

      <div class="scroll-pane flex-grow-1" style="min-height: 12rem">
        <ListBox
          aria-label="Revisions to roll back to"
          :options="options"
          :model-value="selected"
          @update:model-value="selected = $event"
        />
      </div>

      <p class="text-body-secondary small mt-2 mb-2">
        Rolling back replaces the pod template with the selected revision’s.
        Pods are then replaced gradually according to the workload’s update
        strategy (a StatefulSet with a canary partition only updates pods
        above it).
      </p>

      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-danger"
          :disabled="!selected || rollingBack || loading"
          @click="rollBack"
        >
          <span
            v-if="rollingBack"
            class="spinner-border spinner-border-sm me-1"
            aria-hidden="true"
          ></span>
          <span v-if="selected">Roll back to revision {{ selected }}</span>
          <span v-else>Roll back</span>
        </button>
      </div>
    </template>
  </section>
</template>
