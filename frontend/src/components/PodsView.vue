<script setup>
import { ref, computed, watch } from "vue";
import { useStore } from "../store.js";
import PodList from "./PodList.vue";
import PodDetail from "./PodDetail.vue";
import LogViewer from "./LogViewer.vue";
import YamlViewer from "./YamlViewer.vue";
import PodFilesView from "./PodFilesView.vue";

const { state } = useStore();

const logTarget = ref(null); // { pod, container }
const detailPod = ref(null); // pod name
const yamlPod = ref(null); // pod name for YAML view
const filesTarget = ref(null); // { pod, container } for network files
const panelOpener = ref(null);

watch(
  () => JSON.stringify([state.context?.name, state.namespace]),
  () => {
    logTarget.value = null;
    detailPod.value = null;
    yamlPod.value = null;
    filesTarget.value = null;
  },
);

function openLogs(target, opener) {
  logTarget.value = target;
  panelOpener.value = opener || null;
  yamlPod.value = null;
  filesTarget.value = null;
}
function closeLogs() {
  logTarget.value = null;
}

function openDetails(podName, opener) {
  detailPod.value = podName;
  panelOpener.value = opener || null;
  yamlPod.value = null;
  filesTarget.value = null;
}
function closeDetails() {
  detailPod.value = null;
}

function openPodYaml(podName, opener) {
  yamlPod.value = podName;
  panelOpener.value = opener || null;
  detailPod.value = null;
  logTarget.value = null;
  filesTarget.value = null;
}

function openFiles(target, opener) {
  filesTarget.value = target;
  panelOpener.value = opener || null;
  // Network files replaces the other panels: three col-lg-6 panels would
  // wrap awkwardly and split a screen-reader user across regions.
  detailPod.value = null;
  logTarget.value = null;
  yamlPod.value = null;
}
function closeFiles() {
  filesTarget.value = null;
}

const logKey = computed(() =>
  logTarget.value ? `${logTarget.value.pod}/${logTarget.value.container}` : "",
);

const filesKey = computed(() =>
  filesTarget.value
    ? `${filesTarget.value.pod}/${filesTarget.value.container}`
    : "",
);

const anyPodPanel = computed(
  () =>
    !!(
      logTarget.value ||
      detailPod.value ||
      yamlPod.value ||
      filesTarget.value
    ),
);
</script>

<template>
  <div class="row g-3">
    <div :class="[anyPodPanel ? 'col-lg-6' : 'col-12', 'grid-col']">
      <PodList
        @view-logs="openLogs"
        @view-details="openDetails"
        @view-yaml="openPodYaml"
        @view-network-files="openFiles"
      />
    </div>
    <div v-if="detailPod" class="col-lg-6 grid-col" style="min-height: 24rem">
      <PodDetail
        :key="`${detailPod}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        :pod="detailPod"
        :opener="panelOpener"
        @close="closeDetails"
      />
    </div>
    <div v-if="logTarget" class="col-lg-6 grid-col" style="min-height: 24rem">
      <LogViewer
        :key="`${logKey}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        :pod="logTarget.pod"
        :container="logTarget.container"
        :opener="panelOpener"
        @close="closeLogs"
      />
    </div>
    <div v-if="yamlPod" class="col-lg-6 grid-col" style="min-height: 24rem">
      <YamlViewer
        :key="`${yamlPod}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        kind="Pod"
        :name="yamlPod"
        :opener="panelOpener"
        @close="yamlPod = null"
      />
    </div>
    <div v-if="filesTarget" class="col-lg-6 grid-col" style="min-height: 24rem">
      <PodFilesView
        :key="`${filesKey}:${state.connectionEpoch}`"
        :namespace="state.namespace"
        :pod="filesTarget.pod"
        :container="filesTarget.container"
        :opener="panelOpener"
        @close="closeFiles"
      />
    </div>
  </div>
</template>
