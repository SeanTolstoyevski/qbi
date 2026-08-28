<script setup>
import { ref, computed, watch } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import YamlViewer from "./YamlViewer.vue";
import InlineButton from "./InlineButton.vue";
import { nodeStatusBadgeClass } from "../statusClasses.js";

const { state, announce } = useStore();

const nodes = ref([]);
const filter = ref("");
const nodeMetrics = ref(null); // NodeMetricsView: cluster rollup + per-node usage
const metricsError = ref("");
const loading = ref(false);
const error = ref("");
const yamlTarget = ref(null); // node name
const nodeYamlBtns = {};

function setNodeYamlBtn(name, el) {
  if (el) nodeYamlBtns[name] = el;
  else delete nodeYamlBtns[name];
}

async function load() {
  if (!state.connected) return;
  loading.value = true;
  error.value = "";
  yamlTarget.value = null;
  try {
    const list = await api.listNodes();
    nodes.value = list || [];
    try {
      nodeMetrics.value = await api.listNodeMetrics();
      metricsError.value = "";
    } catch (e) {
      nodeMetrics.value = null;
      metricsError.value = String(e);
    }
    announce(`${nodes.value.length} nodes in the cluster.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load nodes: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const metricByName = computed(() => {
  const map = {};
  for (const m of nodeMetrics.value?.nodes || []) map[m.name] = m;
  return map;
});

const filteredNodes = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return nodes.value;
  return nodes.value.filter(
    (n) =>
      n.name.toLowerCase().includes(q) ||
      (n.internalIP || "").toLowerCase().includes(q) ||
      n.roles.some((r) => r.toLowerCase().includes(q)),
  );
});

watch(() => [state.connected, state.connectionEpoch], load, {
  immediate: true,
});

useWatch("watch:nodes", {
  reload: load,
  summarize: (batch) => announce(watchAnnouncement("Node", "nodes", batch)),
});

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="nodes-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="nodes-heading" class="h5 mb-0">Nodes</h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.connected"
        @click="load"
      >
        <span class="visually-hidden">Refresh nodes</span>
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
      </button>
    </div>

    <p v-if="!state.connected" class="text-muted small">
      Connect to a cluster to view its nodes.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="nodes.length === 0" class="text-muted small">
      No nodes visible.
    </p>

    <div v-else class="row g-3">
      <div :class="[yamlTarget ? 'col-lg-8' : 'col-12', 'grid-col']">
        <div v-if="nodeMetrics" class="card mb-3">
          <div class="card-body py-2">
            <h3 class="h6 mb-1">Cluster resources</h3>
            <dl class="row small mb-0">
              <dt class="col-2 col-sm-1">Nodes</dt>
              <dd class="col-10 col-sm-3">{{ nodeMetrics.cluster.nodes }}</dd>
              <dt class="col-2 col-sm-1">CPU</dt>
              <dd class="col-10 col-sm-7">
                <code>{{ nodeMetrics.cluster.cpuUsage }}</code> /
                <code>{{ nodeMetrics.cluster.cpuAllocatable }}</code>
                <span v-if="nodeMetrics.cluster.cpuPercent"
                  >({{ nodeMetrics.cluster.cpuPercent }}%)</span
                >
              </dd>
              <dt class="col-2 col-sm-1">Memory</dt>
              <dd class="col-10 col-sm-7">
                <code>{{ nodeMetrics.cluster.memoryUsage }}</code> /
                <code>{{ nodeMetrics.cluster.memoryAllocatable }}</code>
                <span v-if="nodeMetrics.cluster.memoryPercent"
                  >({{ nodeMetrics.cluster.memoryPercent }}%)</span
                >
              </dd>
            </dl>
          </div>
        </div>
        <p v-else-if="metricsError" class="text-muted small">
          Live CPU/memory usage unavailable (metrics-server not installed or not
          ready).
        </p>
        <label for="node-filter" class="visually-hidden">Filter nodes</label>
        <input
          id="node-filter"
          v-model="filter"
          type="search"
          class="form-control form-control-sm mb-2"
          placeholder="Filter nodes…"
          autocomplete="off"
        />
        <p v-if="filteredNodes.length === 0" class="text-muted small">
          No nodes match “{{ filter }}”.
        </p>
        <table
          v-if="filteredNodes.length"
          class="table table-hover align-middle"
        >
          <caption class="visually-hidden">
            Cluster nodes
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Roles</th>
              <th scope="col">Version</th>
              <th scope="col">CPU</th>
              <th scope="col">Memory</th>
              <th scope="col">Pods</th>
              <th scope="col">Age</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in filteredNodes" :key="n.name">
              <th scope="row" class="fw-normal name-cell">
                <span class="d-inline-flex align-items-center gap-2">
                  <code>{{ n.name }}</code>
                </span>
                <div v-if="n.internalIP" class="small text-body-secondary">
                  {{ n.internalIP }}
                </div>
                <InlineButton
                  :copy-text="n.name"
                  :announce="`Node ${n.name}`"
                  :title="`Copy ${n.name}`"
                />
              </th>
              <td>
                <span class="badge" :class="nodeStatusBadgeClass(n.status)">{{
                  n.status
                }}</span>
                <span v-if="!n.schedulable" class="badge text-bg-warning ms-1">
                  cordoned
                  <span class="visually-hidden">, scheduling disabled</span>
                </span>
                <div
                  v-if="n.conditions && n.conditions.length"
                  class="small text-danger mt-1"
                >
                  {{ n.conditions.join(", ") }}
                </div>
              </td>
              <td>
                <span
                  v-for="r in n.roles"
                  :key="r"
                  class="badge text-bg-secondary me-1"
                  >{{ r }}</span
                >
              </td>
              <td>
                <code class="small">{{ n.version }}</code>
              </td>
              <td>
                <template v-if="metricByName[n.name]">
                  <code>{{ metricByName[n.name].cpuUsage || "—" }}</code>
                  <span class="text-body-secondary">/ {{ n.cpu || "—" }}</span>
                  <span v-if="metricByName[n.name].cpuPercent"
                    >({{ metricByName[n.name].cpuPercent }}%)</span
                  >
                </template>
                <template v-else>{{ n.cpu || "—" }}</template>
              </td>
              <td>
                <template v-if="metricByName[n.name]">
                  <code>{{ metricByName[n.name].memoryUsage || "—" }}</code>
                  <span class="text-body-secondary"
                    >/ {{ n.memory || "—" }}</span
                  >
                  <span v-if="metricByName[n.name].memoryPercent"
                    >({{ metricByName[n.name].memoryPercent }}%)</span
                  >
                </template>
                <template v-else>{{ n.memory || "—" }}</template>
              </td>
              <td>{{ n.pods || "—" }}</td>
              <td>{{ n.age }}</td>
              <td>
                <button
                  :ref="(el) => setNodeYamlBtn(n.name, el)"
                  type="button"
                  class="btn btn-sm btn-outline-secondary"
                  @click="yamlTarget = n.name"
                >
                  YAML<span class="visually-hidden">
                    &nbsp;for node {{ n.name }}</span
                  >
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="yamlTarget"
        class="col-lg-4 grid-col"
        style="min-height: 24rem"
      >
        <YamlViewer
          :key="yamlTarget"
          namespace=""
          kind="Node"
          :name="yamlTarget"
          :opener="nodeYamlBtns[yamlTarget]"
          @close="yamlTarget = null"
        />
      </div>
    </div>
  </section>
</template>
