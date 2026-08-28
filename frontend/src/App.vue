<script setup>
import { ref, nextTick, watch, onMounted, onUnmounted } from "vue";
import { useStore } from "./store.js";
import { api } from "./api.js";
import { usePortForwards } from "./usePortForwards.js";
import ContextBar from "./components/ContextBar.vue";
import ForwardsView from "./components/ForwardsView.vue";
import WelcomeWizard from "./components/WelcomeWizard.vue";
import NamespaceList from "./components/NamespaceList.vue";
import PodsView from "./components/PodsView.vue";
import SecretList from "./components/SecretList.vue";
import ConfigMapList from "./components/ConfigMapList.vue";
import NetworkingView from "./components/NetworkingView.vue";
import EventsView from "./components/EventsView.vue";
import WorkloadsView from "./components/WorkloadsView.vue";
import NodesView from "./components/NodesView.vue";
import SettingsView from "./components/SettingsView.vue";
import AboutView from "./components/AboutView.vue";

const { state, announce, clearFlash, setExperimental } = useStore();

// Subscribes the app to the port-forward event stream exactly once; the
// header badge and the Forwards section read the shared state.
const { count: forwardCount } = usePortForwards();

let flashTimer = null;
watch(
  () => state.flashSeq,
  () => {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(clearFlash, 1800);
  },
);

const showWelcome = ref(false);
const welcomeError = ref("");

const sectionHeadingRefs = {};
const tabRefs = {};

function setSectionHeading(name, el) {
  if (el) sectionHeadingRefs[name] = el;
  else delete sectionHeadingRefs[name];
}

function setTabRef(name, el) {
  if (el) tabRefs[name] = el;
  else delete tabRefs[name];
}

function focusSectionHeading() {
  nextTick(() => sectionHeadingRefs[section.value]?.focus());
}

async function onWelcomeAcknowledged() {
  welcomeError.value = "";
  try {
    await api.acknowledgeWelcome();
    showWelcome.value = false;
    announce("Welcome complete.");
    focusSectionHeading();
  } catch (e) {
    welcomeError.value = String(e);
  }
}

function onWelcomeDismissed() {
  showWelcome.value = false;
  focusSectionHeading();
}

onMounted(async () => {
  try {
    const s = await api.getSettings();
    showWelcome.value = !s.welcomeSeen;
    setExperimental(!!s.experimental);
  } catch {
    showWelcome.value = true;
  }
});

watch(
  () => [state.namespace, state.connectionEpoch],
  () => {
    api.setWatchNamespace(state.namespace || "");
  },
);

const namespaceListRef = ref(null); // NamespaceList, for the Ctrl+E shortcut

const SECTION_KEY = "qba.section";
const savedSection = localStorage.getItem(SECTION_KEY);
const section = ref(
  ["cluster", "namespace", "settings", "about"].includes(savedSection)
    ? savedSection
    : "namespace",
);

function selectSection(name) {
  section.value = name;
  try {
    localStorage.setItem(SECTION_KEY, name);
  } catch {}
  nextTick(() => sectionHeadingRefs[name]?.focus());
}

const tabs = [
  "pods",
  "workloads",
  "networking",
  "configmaps",
  "secrets",
  "events",
];

const topTabs = ["cluster", "namespace", "settings", "about", "forwards"];

// Screen shortcuts: Ctrl+1..4 jump straight to a top-level section (Cluster,
// Namespace, Settings, About). "Forwards" deliberately has no shortcut so the
// existing muscle memory stays intact.
const SECTION_SHORTCUTS = { 1: 0, 2: 1, 3: 2, 4: 3 };

function onGlobalKeydown(e) {
  if (showWelcome.value) return; // the wizard owns the keyboard while open
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === "e" || e.key === "E") {
    const list = namespaceListRef.value;
    if (list?.listReady) {
      e.preventDefault();
      list.focusList();
    }
    return;
  }
  const idx = SECTION_SHORTCUTS[e.key];
  if (idx === undefined) return;
  const name = topTabs[idx];
  if (!name) return;
  e.preventDefault();
  selectSection(name);
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  clearTimeout(flashTimer);
});

const TAB_KEY = "qba.activeTab";
const savedTab = localStorage.getItem(TAB_KEY);
const activeTab = ref(tabs.includes(savedTab) ? savedTab : "pods");

function selectTab(name) {
  activeTab.value = name;
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {}
}

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
  nextTick(() => tabRefs[next]?.focus());
}
</script>

<template>
  <div
    class="app-root"
    :inert="showWelcome || undefined"
    :aria-hidden="showWelcome || undefined"
  >
    <div class="app-shell">
      <header class="border-bottom bg-body-tertiary px-3 py-2">
        <div
          class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2"
        >
          <h1 class="h5 mb-0">QBI</h1>

          <div class="d-flex flex-wrap align-items-center gap-2">
            <nav class="header-nav">
              <ul class="nav nav-pills">
                <li v-for="(s, idx) in topTabs" :key="s" class="nav-item">
                  <button
                    type="button"
                    class="nav-link text-capitalize"
                    :class="{ active: section === s }"
                    :aria-current="section === s ? 'page' : undefined"
                    :aria-keyshortcuts="`Control+${idx + 1}`"
                    @click="selectSection(s)"
                  >
                    {{ s }}
                    <span
                      v-if="s === 'forwards' && forwardCount"
                      class="badge text-bg-secondary ms-1"
                      >{{ forwardCount }}</span
                    >
                  </button>
                </li>
              </ul>
            </nav>
          </div>
        </div>
        <ContextBar />
      </header>

      <div
        class="visually-hidden"
        :aria-live="state.statusKind"
        aria-atomic="true"
      >
        {{ state.status }}
      </div>

      <div class="app-body container-fluid py-3">
        <div class="row g-3 h-100">
          <nav class="col-12 col-md-3 col-lg-2 h-100" aria-label="Namespaces">
            <NamespaceList ref="namespaceListRef" />
          </nav>

          <main
            id="main-content"
            class="col-12 col-md-9 col-lg-10 h-100 scroll-pane"
          >
            <div v-show="section === 'cluster'">
              <h2
                id="section-heading-cluster"
                :ref="(el) => setSectionHeading('cluster', el)"
                class="visually-hidden"
                tabindex="-1"
              >
                Cluster resources
              </h2>
              <div
                v-if="!state.connected"
                class="alert alert-info"
                role="status"
              >
                Select a kubeconfig file with
                <strong>Open kubeconfig file…</strong>, choose a context, then
                select <strong>Connect</strong> to begin.
              </div>
              <NodesView v-else />
            </div>

            <div v-show="section === 'settings'">
              <h2
                id="section-heading-settings"
                :ref="(el) => setSectionHeading('settings', el)"
                tabindex="-1"
              >
                Settings
              </h2>
              <SettingsView />
            </div>

            <div v-show="section === 'about'">
              <h2
                id="section-heading-about"
                :ref="(el) => setSectionHeading('about', el)"
                tabindex="-1"
              >
                About
              </h2>
              <AboutView />
            </div>
            <div v-show="section === 'forwards'">
              <h2
                id="section-heading-forwards"
                :ref="(el) => setSectionHeading('forwards', el)"
                tabindex="-1"
              >
                Port forwards
              </h2>
              <ForwardsView />
            </div>
            <div v-show="section === 'namespace'">
              <h2
                id="section-heading-namespace"
                :ref="(el) => setSectionHeading('namespace', el)"
                class="visually-hidden"
                tabindex="-1"
              >
                Namespace resources
              </h2>
              <div
                v-if="!state.connected"
                class="alert alert-info"
                role="status"
              >
                Select a kubeconfig file with
                <strong>Open kubeconfig file…</strong>, choose a context, then
                select <strong>Connect</strong> to begin.
              </div>
              <template v-else>
                <div
                  v-if="!state.namespace"
                  class="alert alert-secondary"
                  role="status"
                >
                  Select a namespace from the list to view its pods, networking
                  and secrets.
                </div>

                <template v-else>
                  <ul
                    class="nav nav-tabs mb-3"
                    role="tablist"
                    @keydown="onTabKeydown"
                  >
                    <li
                      v-for="t in tabs"
                      :key="t"
                      class="nav-item"
                      role="presentation"
                    >
                      <button
                        :id="`tab-${t}`"
                        :ref="(el) => setTabRef(t, el)"
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
                    <PodsView />
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
              </template>
            </div>
          </main>
        </div>
      </div>
    </div>
  </div>

  <div v-if="state.flashMsg" class="qba-toast" aria-hidden="true">
    {{ state.flashMsg }}
  </div>

  <WelcomeWizard
    v-if="showWelcome"
    :error="welcomeError"
    @acknowledged="onWelcomeAcknowledged"
    @dismiss="onWelcomeDismissed"
  />
</template>
