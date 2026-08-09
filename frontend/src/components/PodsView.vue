<script setup>
import { ref, computed, watch } from "vue";
import { useStore } from "../store.js";
import PodList from "./PodList.vue";
import PodDetail from "./PodDetail.vue";
import LogViewer from "./LogViewer.vue";
import YamlViewer from "./YamlViewer.vue";

const { state } = useStore();

const logTarget = ref(null); // { pod, container }
const detailPod = ref(null); // pod name
const yamlPod = ref(null); // pod name for YAML view

// A context (cluster) or namespace switch invalidates any open pod panels:
// the pod names belong to the previous scope, so close them instead of
// showing stale data or erroring on a pod that doesn't exist in the new
// namespace. The getter returns a string (not an array — a fresh array
// instance always differs, so the watcher would fire on every reconnect too)
// so it fires only on a real scope change. Reconnecting to the same context
// keeps the same key: the panels stay open and the connection epoch in their
// :key remounts them with fresh data.
watch(
  () => JSON.stringify([state.context?.name, state.namespace]),
  () => {
    logTarget.value = null;
    detailPod.value = null;
    yamlPod.value = null;
  },
);

function openLogs(target) {
  logTarget.value = target;
  yamlPod.value = null;
}
function closeLogs() {
  logTarget.value = null;
}

function openDetails(podName) {
  detailPod.value = podName;
  yamlPod.value = null;
}
function closeDetails() {
  detailPod.value = null;
}

function openPodYaml(podName) {
  yamlPod.value = podName;
  detailPod.value = null;
  logTarget.value = null;
}

const logKey = computed(() =>
  logTarget.value ? `${logTarget.value.pod}/${logTarget.value.container}` : "",
);

const anyPodPanel = computed(
  () => !!(logTarget.value || detailPod.value || yamlPod.value),
);
</script>

<template>
  <div class="row g-3">
    <div :class="[anyPodPanel ? 'col-lg-6' : 'col-12', 'grid-col']">
      <PodList
        @view-logs="openLogs"
        @view-details="openDetails"
        @view-yaml="openPodYaml"
      />
    </div>
    <div v-if="detailPod" class="col-lg-6 grid-col" style="min-height: 24rem">
      <PodDetail
        :key="`${detailPod}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        :pod="detailPod"
        @close="closeDetails"
      />
    </div>
    <div v-if="logTarget" class="col-lg-6 grid-col" style="min-height: 24rem">
      <LogViewer
        :key="`${logKey}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        :pod="logTarget.pod"
        :container="logTarget.container"
        @close="closeLogs"
      />
    </div>
    <div v-if="yamlPod" class="col-lg-6 grid-col" style="min-height: 24rem">
      <YamlViewer
        :key="`${yamlPod}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        kind="Pod"
        :name="yamlPod"
        @close="yamlPod = null"
      />
    </div>
  </div>
</template>
