<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import { useActionMenu } from "../useActionMenu.js";
import InlineButton from "./InlineButton.vue";
import { phaseBadgeClass } from "../statusClasses.js";
const { state, announce } = useStore();

const emit = defineEmits([
  "view-logs",
  "view-details",
  "view-yaml",
  "view-network-files",
]);

const pods = ref([]);
const filter = ref("");
const loading = ref(false);
const error = ref("");
const expanded = ref(""); // pod name whose log container chooser is open
const shellExpanded = ref(""); // pod name whose shell container chooser is open
const networkExpanded = ref(""); // pod whose network-files chooser is open
const experimentalOpen = ref(""); // pod whose Experimental submenu is open
const deleting = ref(""); // pod name currently being deleted
const openingShell = ref(""); // pod name while terminal is launching
const menuOpen = ref(""); // pod name whose action menu is open

// Template-ref maps, keyed by pod name. Focus management reads these instead
// of querying the document: the ref callback fires after a chooser/submenu
// mounts and receives null (dropping the entry) when it unmounts — e.g. on a
// namespace switch — so focus always targets a live element.
const logFirstButton = {};
const shellFirstButton = {};
const networkFirstButton = {};
const experimentalTriggers = {};
const experimentalItems = {};

const actionTriggers = {};
const menuEls = {};

function setActionTrigger(name, el) {
  if (el) actionTriggers[name] = el;
  else delete actionTriggers[name];
}

function setMenuEl(name, el) {
  if (el) menuEls[name] = el;
  else delete menuEls[name];
}

watch(menuOpen, (open) => {
  if (!open) experimentalOpen.value = "";
});

watch(
  () => state.experimental,
  (on) => {
    if (!on) experimentalOpen.value = "";
  },
);

// Capture only the first container button (index 0) of a chooser: that is the
// element focus moves to when the chooser opens.
function captureFirstButton(map, name, el, index) {
  if (index !== 0) return;
  if (el) map[name] = el;
  else delete map[name];
}

function setExperimentalTrigger(name, el) {
  if (el) experimentalTriggers[name] = el;
  else delete experimentalTriggers[name];
}

function setExperimentalItem(name, el) {
  if (!el) return;
  if (!experimentalItems[name]) experimentalItems[name] = [];
  experimentalItems[name].push(el);
}

const { openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
  useActionMenu(menuOpen, { triggerRefs: actionTriggers, menuRefs: menuEls });

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";

  expanded.value = "";
  shellExpanded.value = "";
  networkExpanded.value = "";
  experimentalOpen.value = "";
  menuOpen.value = "";
  try {
    const list = await api.listPods(state.namespace);
    pods.value = list || [];
    announce(`${pods.value.length} pods in ${state.namespace}.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load pods: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return pods.value;
  return pods.value.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      (p.owner || "").toLowerCase().includes(q) ||
      (p.node || "").toLowerCase().includes(q),
  );
});

// Opening logs: with a single container, stream it straight away; with several,
// reveal an inline chooser and move focus to the first container button.
function openLogs(pod) {
  if (pod.containers.length <= 1) {
    const container = pod.containers[0] || pod.name;
    emit("view-logs", { pod: pod.name, container }, actionTriggers[pod.name]);
    return;
  }
  if (expanded.value === pod.name) {
    expanded.value = "";
    return;
  }
  expanded.value = pod.name;
  nextTick(() => logFirstButton[pod.name]?.focus());
}

function viewLogs(pod, container) {
  emit("view-logs", { pod: pod.name, container }, actionTriggers[pod.name]);
}

async function openShell(pod) {
  if (pod.containers.length <= 1) {
    await execShell(pod, pod.containers[0] || "");
    return;
  }
  if (shellExpanded.value === pod.name) {
    shellExpanded.value = "";
    return;
  }
  shellExpanded.value = pod.name;
  nextTick(() => shellFirstButton[pod.name]?.focus());
}

async function execShell(pod, container) {
  shellExpanded.value = "";
  openingShell.value = pod.name;
  try {
    await api.openShell(state.namespace, pod.name, container);
    announce(`Shell opened for pod ${pod.name}.`);
  } catch (e) {
    announce(`Failed to open shell for ${pod.name}: ${String(e)}`, "assertive");
  } finally {
    openingShell.value = "";
  }
}

function openNetworkFiles(pod) {
  if (pod.containers.length <= 1) {
    emit(
      "view-network-files",
      { pod: pod.name, container: pod.containers[0] || pod.name },
      actionTriggers[pod.name],
    );
    return;
  }
  if (networkExpanded.value === pod.name) {
    networkExpanded.value = "";
    return;
  }
  networkExpanded.value = pod.name;
  nextTick(() => networkFirstButton[pod.name]?.focus());
}

function viewNetworkFiles(pod, container) {
  emit(
    "view-network-files",
    { pod: pod.name, container },
    actionTriggers[pod.name],
  );
}

function toggleExperimental(podName) {
  const opening = experimentalOpen.value !== podName;
  experimentalOpen.value = opening ? podName : "";
  if (opening) {
    experimentalItems[podName] = [];
    nextTick(() => experimentalItems[podName]?.[0]?.focus());
  }
}

function closeExperimentalMenu() {
  experimentalOpen.value = "";
}

function onExperimentalTriggerKeydown(e, podName) {
  switch (e.key) {
    case "ArrowRight":
      e.preventDefault();
      e.stopPropagation();
      if (experimentalOpen.value !== podName) {
        toggleExperimental(podName);
      } else {
        experimentalItems[podName]?.[0]?.focus();
      }
      break;
    case "ArrowLeft":
      e.preventDefault();
      e.stopPropagation();
      closeExperimentalMenu();
      break;
    case "ArrowUp":
    case "Home":
    case "End":
      closeExperimentalMenu();
      break;
  }
}

function onExperimentalMenuKeydown(e, podName) {
  const items = experimentalItems[podName] ?? [];
  const idx = items.indexOf(e.target);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      e.stopPropagation();
      items[(idx + 1) % items.length]?.focus();
      break;
    case "ArrowUp":
      e.preventDefault();
      e.stopPropagation();
      items[(idx - 1 + items.length) % items.length]?.focus();
      break;
    case "Home":
      e.preventDefault();
      e.stopPropagation();
      items[0]?.focus();
      break;
    case "End":
      e.preventDefault();
      e.stopPropagation();
      items[items.length - 1]?.focus();
      break;
    case "ArrowLeft":
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closeExperimentalMenu();
      experimentalTriggers[podName]?.focus();
      break;
  }
}

async function deletePod(pod) {
  deleting.value = pod.name;
  try {
    const removed = await api.deletePod(state.namespace, pod.name);
    if (!removed) return;
    announce(`Pod ${pod.name} deleted.`);
    await load();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to delete pod ${pod.name}: ${error.value}`, "assertive");
  } finally {
    deleting.value = "";
  }
}

// Reload on namespace changes and on every (re)connect: reconnecting to the
// same context leaves the namespace unchanged, so the epoch is what forces
// the fresh load. load() itself guards on state.namespace.
watch(() => [state.namespace, state.connectionEpoch], load, {
  immediate: true,
});

// Coalesce pod watch events into one reload + one announcement.
useWatch("watch:pods", {
  reload: load,
  summarize: (batch) => announce(watchAnnouncement("Pod", "pods", batch)),
});

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="pods-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="pods-heading" class="h5 mb-0">
        Pods<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.namespace"
        @click="load"
      >
        <span class="visually-hidden">Refresh pods</span>
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
      </button>
    </div>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to list its pods.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="pods.length === 0" class="text-muted small">No pods found.</p>

    <template v-else>
      <label for="pod-filter" class="visually-hidden">Filter pods</label>
      <input
        id="pod-filter"
        v-model="filter"
        type="search"
        class="form-control form-control-sm mb-2"
        placeholder="Filter pods…"
        autocomplete="off"
      />
      <p v-if="filtered.length === 0" class="text-muted small">
        No pods match “{{ filter }}”.
      </p>
      <div v-if="filtered.length" class="table-responsive">
        <table class="table table-hover align-middle">
          <caption class="visually-hidden">
            Pods in namespace
            {{
              state.namespace
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Ready</th>
              <th scope="col">Phase</th>
              <th scope="col">Restarts</th>
              <th scope="col">Age</th>
              <th scope="col">Owner</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="pod in filtered" :key="pod.name">
              <tr>
                <th scope="row" class="fw-normal name-cell">
                  <span>{{ pod.name }}</span>
                  <InlineButton
                    :copy-text="pod.name"
                    :announce="`Pod ${pod.name}`"
                    :title="`Copy ${pod.name}`"
                  />
                </th>
                <td>{{ pod.ready }}</td>
                <td>
                  <span class="badge" :class="phaseBadgeClass(pod.phase)">{{
                    pod.phase
                  }}</span>
                </td>
                <td>{{ pod.restarts }}</td>
                <td>{{ pod.age }}</td>
                <td class="small text-body-secondary">
                  {{ pod.owner || "-" }}
                </td>
                <td>
                  <div class="dropdown">
                    <button
                      :id="`actions-btn-${pod.name}`"
                      :ref="(el) => setActionTrigger(pod.name, el)"
                      type="button"
                      class="btn btn-sm btn-outline-secondary dropdown-toggle"
                      aria-haspopup="menu"
                      :aria-expanded="menuOpen === pod.name"
                      :aria-controls="`menu-${pod.name}`"
                      @click.stop="
                        menuOpen === pod.name
                          ? closeMenu(pod.name)
                          : openMenu(pod.name)
                      "
                    >
                      Actions
                      <span class="visually-hidden"
                        >for pod {{ pod.name }}</span
                      >
                    </button>

                    <ul
                      v-if="menuOpen === pod.name"
                      :id="`menu-${pod.name}`"
                      :ref="(el) => setMenuEl(pod.name, el)"
                      role="menu"
                      :aria-label="`Actions for pod ${pod.name}`"
                      class="dropdown-menu show"
                      :data-menu="pod.name"
                      @keydown="onMenuKeydown($event, pod.name)"
                    >
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          @click="
                            focusTriggerAndAct(pod.name, () =>
                              emit(
                                'view-details',
                                pod.name,
                                actionTriggers[pod.name],
                              ),
                            )
                          "
                        >
                          Details
                        </button>
                      </li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          @click="
                            focusTriggerAndAct(pod.name, () =>
                              emit(
                                'view-yaml',
                                pod.name,
                                actionTriggers[pod.name],
                              ),
                            )
                          "
                        >
                          YAML
                        </button>
                      </li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          @click="
                            focusTriggerAndAct(pod.name, () => openLogs(pod))
                          "
                        >
                          Logs{{ pod.containers.length > 1 ? "\u2026" : "" }}
                        </button>
                      </li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          :disabled="openingShell === pod.name"
                          @click="
                            focusTriggerAndAct(pod.name, () => openShell(pod))
                          "
                        >
                          <span
                            v-if="openingShell === pod.name"
                            class="spinner-border spinner-border-sm me-1"
                            aria-hidden="true"
                          ></span>
                          Shell{{ pod.containers.length > 1 ? "\u2026" : "" }}
                        </button>
                      </li>
                      <li v-if="state.experimental" role="presentation">
                        <button
                          :ref="(el) => setExperimentalTrigger(pod.name, el)"
                          type="button"
                          role="menuitem"
                          aria-haspopup="menu"
                          :aria-expanded="experimentalOpen === pod.name"
                          :aria-controls="`experimental-menu-${pod.name}`"
                          class="dropdown-item d-flex align-items-center justify-content-between"
                          @click.stop="toggleExperimental(pod.name)"
                          @keydown="
                            onExperimentalTriggerKeydown($event, pod.name)
                          "
                        >
                          Experimental
                          <i
                            :class="
                              experimentalOpen === pod.name
                                ? 'bi-chevron-down'
                                : 'bi-chevron-right'
                            "
                            class="bi ms-2"
                            aria-hidden="true"
                          ></i>
                        </button>
                        <ul
                          v-if="experimentalOpen === pod.name"
                          :id="`experimental-menu-${pod.name}`"
                          role="menu"
                          :aria-label="`Experimental actions for pod ${pod.name}`"
                          class="list-unstyled mb-0 ms-3 border-start"
                          @keydown="onExperimentalMenuKeydown($event, pod.name)"
                        >
                          <li role="presentation">
                            <button
                              :ref="(el) => setExperimentalItem(pod.name, el)"
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="
                                focusTriggerAndAct(pod.name, () =>
                                  openNetworkFiles(pod),
                                )
                              "
                            >
                              Network files{{
                                pod.containers.length > 1 ? "\u2026" : ""
                              }}
                            </button>
                          </li>
                        </ul>
                      </li>
                      <li role="separator" class="dropdown-divider"></li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item text-danger"
                          :disabled="deleting === pod.name"
                          @click="
                            focusTriggerAndAct(pod.name, () => deletePod(pod))
                          "
                        >
                          <span
                            v-if="deleting === pod.name"
                            class="spinner-border spinner-border-sm me-1"
                            aria-hidden="true"
                          ></span>
                          Delete
                        </button>
                      </li>
                    </ul>
                  </div>
                </td>
              </tr>
              <tr v-if="pod.containers.length > 1 && expanded === pod.name">
                <td :id="`containers-${pod.name}`" colspan="7">
                  <fieldset class="mb-0" :data-container-group="pod.name">
                    <legend class="h6 small text-body-secondary">
                      Choose a container to stream logs
                    </legend>
                    <div class="d-flex flex-wrap gap-2">
                      <button
                        v-for="(c, i) in pod.containers"
                        :key="c"
                        :ref="
                          (el) =>
                            captureFirstButton(logFirstButton, pod.name, el, i)
                        "
                        type="button"
                        class="btn btn-sm btn-secondary"
                        @click="
                          focusTriggerAndAct(pod.name, () => viewLogs(pod, c))
                        "
                      >
                        {{ c }}
                      </button>
                    </div>
                  </fieldset>
                </td>
              </tr>
              <tr
                v-if="pod.containers.length > 1 && shellExpanded === pod.name"
              >
                <td :id="`shell-containers-${pod.name}`" colspan="7">
                  <fieldset class="mb-0" :data-shell-group="pod.name">
                    <legend class="h6 small text-body-secondary">
                      Choose a container to open a shell
                    </legend>
                    <div class="d-flex flex-wrap gap-2">
                      <button
                        v-for="(c, i) in pod.containers"
                        :key="c"
                        :ref="
                          (el) =>
                            captureFirstButton(
                              shellFirstButton,
                              pod.name,
                              el,
                              i,
                            )
                        "
                        type="button"
                        class="btn btn-sm btn-secondary"
                        @click="
                          focusTriggerAndAct(pod.name, () => execShell(pod, c))
                        "
                      >
                        {{ c }}
                      </button>
                    </div>
                  </fieldset>
                </td>
              </tr>
              <tr
                v-if="pod.containers.length > 1 && networkExpanded === pod.name"
              >
                <td :id="`network-containers-${pod.name}`" colspan="7">
                  <fieldset class="mb-0" :data-network-group="pod.name">
                    <legend class="h6 small text-body-secondary">
                      Choose a container to read network files
                    </legend>
                    <div class="d-flex flex-wrap gap-2">
                      <button
                        v-for="(c, i) in pod.containers"
                        :key="c"
                        :ref="
                          (el) =>
                            captureFirstButton(
                              networkFirstButton,
                              pod.name,
                              el,
                              i,
                            )
                        "
                        type="button"
                        class="btn btn-sm btn-secondary"
                        @click="
                          focusTriggerAndAct(pod.name, () =>
                            viewNetworkFiles(pod, c),
                          )
                        "
                      >
                        {{ c }}
                      </button>
                    </div>
                  </fieldset>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
