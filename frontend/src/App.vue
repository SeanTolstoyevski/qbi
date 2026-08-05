<script setup>
import { ref, computed, nextTick, watch } from "vue";
import { useStore } from "./store.js";
import { api } from "./api.js";
import ContextBar from "./components/ContextBar.vue";
import NamespaceList from "./components/NamespaceList.vue";
import PodList from "./components/PodList.vue";
import PodDetail from "./components/PodDetail.vue";
import SecretList from "./components/SecretList.vue";
import ConfigMapList from "./components/ConfigMapList.vue";
import NetworkingView from "./components/NetworkingView.vue";
import EventsView from "./components/EventsView.vue";
import WorkloadsView from "./components/WorkloadsView.vue";
import NodesView from "./components/NodesView.vue";
import YamlViewer from "./components/YamlViewer.vue";
import LogViewer from "./components/LogViewer.vue";
import SettingsView from "./components/SettingsView.vue";

const { state } = useStore();

// Notify the backend whenever the active namespace changes so it can
// (re)start the appropriate Kubernetes watch streams.
watch(() => state.namespace, (ns) => {
  if (ns) api.setWatchNamespace(ns);
});

const logTarget = ref(null);  // { pod, container }
const detailPod = ref(null);  // pod name
const yamlPod = ref(null);    // pod name for YAML view

// A context (cluster) or namespace switch invalidates any open pod panels:
// the pod names belong to the previous scope, so close them instead of
// showing stale data or erroring on a pod that doesn't exist in the new
// namespace.
watch(
  () => [state.context?.name, state.namespace],
  () => {
    logTarget.value = null;
    detailPod.value = null;
    yamlPod.value = null;
  }
);

// Top-level split: cluster-scoped resources vs namespace-scoped resources.
// Persisted so the user lands back where they were on reconnect.
const SECTION_KEY = "qba.section";
const section = ref(localStorage.getItem(SECTION_KEY) === "cluster" ? "cluster" : "namespace");

function selectSection(name) {
  section.value = name;
  try { localStorage.setItem(SECTION_KEY, name); } catch { /* best-effort */ }
  // Move focus to the newly revealed region heading on the next tick so
  // keyboard and screen-reader users know the view has changed.
  nextTick(() => document.getElementById(`section-heading-${name}`)?.focus());
}

// Namespace-scoped tabs.
const tabs = ["pods", "workloads", "networking", "configmaps", "secrets", "events"];

// Top-level tabs including settings (always visible, cluster-independent).
const topTabs = ["cluster", "namespace", "settings"];

const TAB_KEY = "qba.activeTab";
const savedTab = localStorage.getItem(TAB_KEY);
const activeTab = ref(tabs.includes(savedTab) ? savedTab : "pods");

function selectTab(name) {
  activeTab.value = name;
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* best-effort persistence */
  }
}

// APG tab pattern: arrow keys move between tabs, Home/End jump to ends, and
// focus follows so the newly focused tab is also activated.
function onTabKeydown(e) {
  const i = tabs.indexOf(activeTab.value);
  let next = null;
  switch (e.key) {
    case "ArrowRight":
      next = tabs[(i + 1) % tabs.length];
      break;
    case "ArrowLeft":
      next = tabs[(i - 1 + tabs.length) % tabs.length];
      break;
    case "Home":
      next = tabs[0];
      break;
    case "End":
      next = tabs[tabs.length - 1];
      break;
    default:
      return;
  }
  e.preventDefault();
  selectTab(next);
  nextTick(() => document.getElementById(`tab-${next}`)?.focus());
}

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
  logTarget.value ? `${logTarget.value.pod}/${logTarget.value.container}` : ""
);

const anyPodPanel = computed(() => !!(logTarget.value || detailPod.value || yamlPod.value));
</script>

<template>
  <a class="skip-link btn btn-primary" href="#main-content">Skip to main content</a>

  <div class="app-shell">
    <header class="border-bottom bg-body-tertiary px-3 py-2">
      <div class="d-flex align-items-center justify-content-between mb-2">
        <h1 class="h5 mb-0">QBI</h1>
      </div>
      <ContextBar />
    </header>

    <!-- Global status region: loading/errors are announced here without moving
         focus. Screen readers pick these up via aria-live. -->
    <div class="visually-hidden" :aria-live="state.statusKind" aria-atomic="true">
      {{ state.status }}
    </div>

    <div class="app-body container-fluid py-3">
      <div class="row g-3 h-100">
        <!-- Sidebar: namespaces -->
        <nav class="col-12 col-md-3 col-lg-2 h-100" aria-label="Namespaces">
          <NamespaceList />
        </nav>

        <!-- Main content -->
        <main id="main-content" class="col-12 col-md-9 col-lg-10 h-100 scroll-pane">
          <template v-if="!state.connected">
            <div class="alert alert-info" role="status">
              Select a kubeconfig file with <strong>Open kubeconfig file…</strong>,
              choose a context, then select <strong>Connect</strong> to begin.
            </div>
          </template>

          <template v-else>
            <!-- Top-level Cluster / Namespace toggle. Uses a radiogroup so
                 screen readers understand these are mutually exclusive views,
                 not independent checkboxes. -->
            <div
              role="radiogroup"
              aria-label="View scope"
              class="btn-group mb-3"
            >
              <button
                type="button"
                role="radio"
                :aria-checked="section === 'cluster'"
                class="btn btn-sm"
              :class="section === 'cluster' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="selectSection('cluster')"
              >Cluster</button>
              <button
                type="button"
                role="radio"
                :aria-checked="section === 'namespace'"
                class="btn btn-sm"
                :class="section === 'namespace' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="selectSection('namespace')"
              >Namespace</button>
              <button
                type="button"
                role="radio"
                :aria-checked="section === 'settings'"
                class="btn btn-sm"
                :class="section === 'settings' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="selectSection('settings')"
              >Settings</button>
            </div>

            <!-- ── CLUSTER VIEW ───────────────────────────────────────────── -->
            <div v-show="section === 'cluster'">
              <h2
                id="section-heading-cluster"
                class="visually-hidden"
                tabindex="-1"
              >Cluster resources</h2>
              <NodesView />
            </div>

              <!-- ── SETTINGS ───────────────────────────────────────────────── -->
            <div v-show="section === 'settings'">
              <h2
                id="section-heading-settings"
                class="visually-hidden"
                tabindex="-1"
              >Settings</h2>
              <SettingsView />
            </div>

            <!-- ── NAMESPACE VIEW ─────────────────────────────────────────── -->
            <div v-show="section === 'namespace'">
              <h2
                id="section-heading-namespace"
                class="visually-hidden"
                tabindex="-1"
              >Namespace resources</h2>

              <div v-if="!state.namespace" class="alert alert-secondary" role="status">
                Select a namespace from the list to view its pods, networking and secrets.
              </div>

              <template v-else>
                <ul class="nav nav-tabs mb-3" role="tablist" @keydown="onTabKeydown">
                  <li v-for="t in tabs" :key="t" class="nav-item" role="presentation">
                    <button
                      :id="`tab-${t}`"
                      class="nav-link text-capitalize"
                      :class="{ active: activeTab === t }"
                      type="button"
                      role="tab"
                      :tabindex="activeTab === t ? 0 : -1"
                      :aria-selected="activeTab === t"
                      :aria-controls="`panel-${t}`"
                      @click="selectTab(t)"
                    >
                      {{ t === "configmaps" ? "Config maps" : t }}
                    </button>
                  </li>
                </ul>

                <div
                  v-show="activeTab === 'pods'"
                  id="panel-pods"
                  role="tabpanel"
                  aria-labelledby="tab-pods"
                >
                  <div class="row g-3">
                    <div :class="anyPodPanel ? 'col-lg-6' : 'col-12'">
                      <PodList @view-logs="openLogs" @view-details="openDetails" @view-yaml="openPodYaml" />
                    </div>
                    <div v-if="detailPod" class="col-lg-6" style="min-height: 24rem">
                      <PodDetail
                        :key="detailPod"
                        :namespace="state.namespace"
                        :pod="detailPod"
                        @close="closeDetails"
                      />
                    </div>
                    <div v-if="logTarget" class="col-lg-6" style="min-height: 24rem">
                      <LogViewer
                        :key="logKey"
                        :namespace="state.namespace"
                        :pod="logTarget.pod"
                        :container="logTarget.container"
                        @close="closeLogs"
                      />
                    </div>
                    <div v-if="yamlPod" class="col-lg-6" style="min-height: 24rem">
                      <YamlViewer
                        :key="yamlPod"
                        :namespace="state.namespace"
                        kind="Pod"
                        :name="yamlPod"
                        @close="yamlPod = null"
                      />
                    </div>
                  </div>
                </div>

                <div
                  v-show="activeTab === 'workloads'"
                  id="panel-workloads"
                  role="tabpanel"
                  aria-labelledby="tab-workloads"
                >
                  <WorkloadsView />
                </div>

                <div
                  v-show="activeTab === 'networking'"
                  id="panel-networking"
                  role="tabpanel"
                  aria-labelledby="tab-networking"
                >
                  <NetworkingView />
                </div>

                <div
                  v-show="activeTab === 'configmaps'"
                  id="panel-configmaps"
                  role="tabpanel"
                  aria-labelledby="tab-configmaps"
                >
                  <ConfigMapList />
                </div>

                <div
                  v-show="activeTab === 'secrets'"
                  id="panel-secrets"
                  role="tabpanel"
                  aria-labelledby="tab-secrets"
                >
                  <SecretList />
                </div>

                <div
                  v-show="activeTab === 'events'"
                  id="panel-events"
                  role="tabpanel"
                  aria-labelledby="tab-events"
                >
                  <EventsView />
                </div>
              </template>
            </div>
          </template>
        </main>
      </div>
    </div>
  </div>
</template>
