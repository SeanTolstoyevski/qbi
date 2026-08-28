<script setup>
import { ref, watch, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import PanelHeader from "./PanelHeader.vue";
import PortForwardPanel from "./PortForwardPanel.vue";
import { phaseBadgeClass, containerReadyBadgeClass } from "../statusClasses.js";

const props = defineProps({
  namespace: { type: String, required: true },
  pod: { type: String, required: true },
  opener: { type: Object, default: null },
});

const emit = defineEmits(["close"]);
const { state, announce } = useStore();

const detail = ref(null);
const metrics = ref(null); // PodMetric: live CPU/memory usage
const metricsError = ref("");
const loading = ref(false);
const error = ref("");
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  opener: props.opener,
  onClose: () => emit("close"),
});

async function load() {
  loading.value = true;
  error.value = "";
  metrics.value = null;
  metricsError.value = "";
  try {
    detail.value = await api.getPod(props.namespace, props.pod);
    try {
      metrics.value = await api.getPodMetrics(props.namespace, props.pod);
    } catch (e) {
      metricsError.value = String(e);
    }
    announce(`Details for pod ${props.pod} loaded.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load pod details: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const labelPairs = (labels) => Object.entries(labels || {});

function containerBad(c) {
  return !c.ready || (c.state === "Waiting" && c.stateReason);
}

watch(() => [props.namespace, props.pod], load, { immediate: true });
</script>

<template>
  <section
    aria-labelledby="pod-detail-heading"
    class="h-100 scroll-pane"
    @keydown="onKeydown"
  >
    <PanelHeader
      ref="header"
      heading-id="pod-detail-heading"
      :title="'Pod: ' + pod"
      @close="emit('close')"
    >
      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="load"
        >
          <span class="visually-hidden">Refresh pod details</span>
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
    </PanelHeader>

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <template v-else-if="detail">
      <dl class="row small mb-3">
        <dt class="col-sm-4">Phase</dt>
        <dd class="col-sm-8">
          <span class="badge" :class="phaseBadgeClass(detail.phase)">{{
            detail.phase
          }}</span>
        </dd>
        <dt class="col-sm-4">Pod IP</dt>
        <dd class="col-sm-8">
          <code>{{ detail.podIP || "—" }}</code>
        </dd>
        <dt class="col-sm-4">Node</dt>
        <dd class="col-sm-8">
          <code>{{ detail.node || "—" }}</code>
        </dd>
        <dt class="col-sm-4">Host IP</dt>
        <dd class="col-sm-8">
          <code>{{ detail.hostIP || "—" }}</code>
        </dd>
        <dt class="col-sm-4">Service account</dt>
        <dd class="col-sm-8">
          <code>{{ detail.serviceAccount || "—" }}</code>
        </dd>
        <dt class="col-sm-4">QoS class</dt>
        <dd class="col-sm-8">{{ detail.qosClass || "—" }}</dd>
        <dt class="col-sm-4">CPU usage</dt>
        <dd class="col-sm-8">
          <template v-if="metrics">
            <code>{{ metrics.cpu || "—" }}</code>
            <span
              v-if="metrics.cpuRequest || metrics.cpuLimit"
              class="text-body-secondary"
            >
              (request {{ metrics.cpuRequest || "—" }}, limit
              {{ metrics.cpuLimit || "—" }})
            </span>
          </template>
          <span v-else-if="metricsError" class="text-body-secondary"
            >metrics unavailable</span
          >
          <template v-else>—</template>
        </dd>
        <dt class="col-sm-4">Memory usage</dt>
        <dd class="col-sm-8">
          <template v-if="metrics">
            <code>{{ metrics.memory || "—" }}</code>
            <span
              v-if="metrics.memoryRequest || metrics.memoryLimit"
              class="text-body-secondary"
            >
              (request {{ metrics.memoryRequest || "—" }}, limit
              {{ metrics.memoryLimit || "—" }})
            </span>
          </template>
          <span v-else-if="metricsError" class="text-body-secondary"
            >metrics unavailable</span
          >
          <template v-else>—</template>
        </dd>
        <dt class="col-sm-4">Age</dt>
        <dd class="col-sm-8">{{ detail.age }}</dd>
      </dl>

      <h3 class="h6">Containers</h3>
      <div
        v-for="c in detail.containers"
        :key="c.name"
        class="border rounded p-2 mb-2"
        :class="{ 'border-danger': containerBad(c) }"
      >
        <div class="d-flex align-items-center justify-content-between">
          <span class="fw-semibold">{{ c.name }}</span>
          <span>
            <span class="badge" :class="containerReadyBadgeClass(c.ready)">{{
              c.ready ? "ready" : "not ready"
            }}</span>
            <span class="badge text-bg-secondary ms-1">{{ c.state }}</span>
          </span>
        </div>
        <dl class="row small mb-0 mt-1">
          <dt class="col-sm-4">Image</dt>
          <dd class="col-sm-8">
            <code>{{ c.image }}</code>
          </dd>
          <dt class="col-sm-4">Restarts</dt>
          <dd class="col-sm-8">{{ c.restartCount }}</dd>
          <template v-if="c.stateReason">
            <dt class="col-sm-4">Reason</dt>
            <dd class="col-sm-8 text-danger">{{ c.stateReason }}</dd>
          </template>
          <template v-if="c.stateMessage">
            <dt class="col-sm-4">Message</dt>
            <dd class="col-sm-8">{{ c.stateMessage }}</dd>
          </template>
        </dl>
      </div>

      <PortForwardPanel
        v-if="state.experimental && detail"
        :namespace="props.namespace"
        :pod="props.pod"
        :ports="detail.ports || []"
      />

      <template v-if="detail.conditions && detail.conditions.length">
        <h3 class="h6 mt-3">Conditions</h3>
        <table class="table table-sm">
          <caption class="visually-hidden">
            Pod conditions for
            {{
              pod
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cond in detail.conditions" :key="cond.type">
              <th scope="row" class="fw-normal">{{ cond.type }}</th>
              <td>{{ cond.status }}</td>
              <td>{{ cond.reason || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="labelPairs(detail.labels).length">
        <h3 class="h6 mt-3">Labels</h3>
        <ul class="list-unstyled small mb-0">
          <li v-for="[k, v] in labelPairs(detail.labels)" :key="k">
            <code>{{ k }}={{ v }}</code>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
