<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import { useActionMenu } from "../useActionMenu.js";
import InlineButton from "./InlineButton.vue";
import { phaseBadgeClass } from "../statusClasses.js";
const { state, announce } = useStore();

const emit = defineEmits(["view-logs", "view-details", "view-yaml"]);

const pods = ref([]);
const filter = ref("");
const loading = ref(false);
const error = ref("");
const expanded = ref(""); // pod name whose log container chooser is open
const shellExpanded = ref(""); // pod name whose shell container chooser is open
const deleting = ref(""); // pod name currently being deleted
const openingShell = ref(""); // pod name while terminal is launching
const menuOpen = ref(""); // pod name whose action menu is open
const shellGroups = {};

function setShellGroup(name, el) {
  if (el) shellGroups[name] = el;
  else delete shellGroups[name];
}

const { openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
  useActionMenu(menuOpen);

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";
  // A namespace switch invalidates per-pod UI (container choosers, action
  // menus): they name pods that no longer exist in the new namespace.
  expanded.value = "";
  shellExpanded.value = "";
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

// Live filtering over the loaded pods; matches name, owner or node.
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
    emit("view-logs", { pod: pod.name, container });
    return;
  }
  if (expanded.value === pod.name) {
    expanded.value = "";
    return;
  }
  expanded.value = pod.name;
  nextTick(() => {
    document
      .querySelector(`[data-container-group="${pod.name}"] button`)
      ?.focus();
  });
}

function viewLogs(pod, container) {
  emit("view-logs", { pod: pod.name, container });
}

// Opening a shell: same pattern as logs — single container launches
// immediately; multiple containers reveal an inline chooser.
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
  nextTick(() => shellGroups[pod.name]?.querySelector("button")?.focus());
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
      <!-- table-responsive: scroll wide tables inside their column instead of
           spilling under the log/detail panel beside them. -->
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
                              emit('view-details', pod.name),
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
                              emit('view-yaml', pod.name),
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
                        v-for="c in pod.containers"
                        :key="c"
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
                  <fieldset
                    class="mb-0"
                    :data-shell-group="pod.name"
                    :ref="(el) => setShellGroup(pod.name, el)"
                  >
                    <legend class="h6 small text-body-secondary">
                      Choose a container to open a shell
                    </legend>
                    <div class="d-flex flex-wrap gap-2">
                      <button
                        v-for="c in pod.containers"
                        :key="c"
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
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
