<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import YamlViewer from "./YamlViewer.vue";
import LogViewer from "./LogViewer.vue";
import CronJobCreate from "./CronJobCreate.vue";
import CronJobEdit from "./CronJobEdit.vue";
import DeploymentCreate from "./DeploymentCreate.vue";

const { state, announce } = useStore();

const workloads = ref([]);
const workloadErrors = ref([]); // per-kind load errors (RBAC)
const jobs = ref([]);
const cronJobs = ref([]);
const loading = ref(false);
const error = ref("");
const restarting = ref(""); // "Kind/name" currently being restarted
const deleting = ref("");  // "Kind/name" currently being deleted
const scaling = ref(null);  // { kind, name } while scale input is open
const scaleValue = ref(1);
const yamlTarget = ref(null); // { kind, name }
const rollouts = ref([]);
const rolloutsTotal = ref(0);
const rolloutsError = ref("");
// The user chooses how much rollout history to see; the backend only applies
// their choices (plus the project-wide list safety valve).
const rolloutFilter = ref("");
const maxDeployments = ref(100); // 0 = all
const revisionsPerDeploy = ref(5); // 0 = all
let rolloutTimer = null;

// ── Cron job actions: logs, create, edit, suspend ──────────────────────────
const logTarget = ref(null);      // { pod, container } for the shared LogViewer
const cronLogChooser = ref(null); // { cj, pod, containers } while picking a container
const createOpen = ref(false);
const editTarget = ref(null); // CronJobInfo being edited in the edit panel
const suspending = ref("");   // cron job name while a suspend/resume is in flight
const createDeployOpen = ref(false); // Deployment create panel

// ── Action menu (same convention as PodList) ────────────────────────────────
const menuOpen = ref(""); // key of the currently open action menu

function openMenu(key) {
  menuOpen.value = key;
  nextTick(() =>
    document
      .querySelector(`[data-menu="${key}"] [role="menuitem"]:not(:disabled)`)
      ?.focus()
  );
}

function closeMenu(key, { skipFocus = false } = {}) {
  menuOpen.value = "";
  if (!skipFocus) {
    nextTick(() => document.getElementById(`actions-btn-${key}`)?.focus());
  }
}

function focusTriggerAndAct(key, fn) {
  menuOpen.value = "";
  const btn = document.getElementById(`actions-btn-${key}`);
  btn?.focus();
  nextTick(fn);
}

function onMenuKeydown(e, key) {
  const menu = document.querySelector(`[data-menu="${key}"]`);
  const items = Array.from(
    menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? []
  );
  const idx = items.indexOf(document.activeElement);
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      closeMenu(key);
      break;
    case "ArrowDown":
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
      break;
    case "ArrowUp":
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
      break;
    case "Home":
      e.preventDefault();
      items[0]?.focus();
      break;
    case "End":
      e.preventDefault();
      items[items.length - 1]?.focus();
      break;
    case "Tab":
      menuOpen.value = "";
      break;
  }
}

function onDocClick(e) {
  if (!menuOpen.value) return;
  const menu = document.querySelector(`[data-menu="${menuOpen.value}"]`);
  const btn = document.getElementById(`actions-btn-${menuOpen.value}`);
  if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
    menuOpen.value = "";
  }
}

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";
  // A namespace switch invalidates panels tied to a specific workload
  // (YAML, inline scale row, cron job log/edit/create, action menus): they name
  // resources that may not exist here.
  yamlTarget.value = null;
  scaling.value = null;
  logTarget.value = null;
  cronLogChooser.value = null;
  editTarget.value = null;
  createOpen.value = false;
  createDeployOpen.value = false;
  menuOpen.value = "";
  try {
    const [wl, jl, cjl] = await Promise.all([
      api.listWorkloads(state.namespace),
      api.listJobs(state.namespace),
      api.listCronJobs(state.namespace),
    ]);
    workloads.value = wl?.workloads || [];
    workloadErrors.value = wl?.errors || [];
    jobs.value = jl || [];
    cronJobs.value = cjl || [];
    await loadRollouts(); // best-effort; a history failure never breaks the tables
    announce(
      `${workloads.value.length} workloads, ${jobs.value.length} jobs, ${cronJobs.value.length} cron jobs, ${rollouts.value.length} recent rollouts in ${state.namespace}.`
    );
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load workloads: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

// Rollout history is durable (it answers "which deploy was triggered and
// when" even after events expire) and user-scoped: the caller picks the
// filter and caps. Loaded separately so an RBAC denial or slow list degrades
// to a note instead of failing the whole screen.
async function loadRollouts() {
  rolloutsError.value = "";
  try {
    const hist = await api.history(state.namespace, {
      filter: rolloutFilter.value.trim(),
      maxDeployments: Number(maxDeployments.value) || 0,
      revisionsPerDeploy: Number(revisionsPerDeploy.value) || 0,
    });
    rollouts.value = hist?.rollouts || [];
    rolloutsTotal.value = hist?.total ?? rollouts.value.length;
  } catch (e) {
    rollouts.value = [];
    rolloutsTotal.value = 0;
    rolloutsError.value = String(e);
  }
}

// Reloading on every keystroke of the filter would spam the API server; a
// short debounce keeps it to one call after the user pauses.
function scheduleRollouts() {
  clearTimeout(rolloutTimer);
  rolloutTimer = setTimeout(loadRollouts, 250);
}

watch([rolloutFilter, maxDeployments, revisionsPerDeploy], scheduleRollouts);
onUnmounted(() => clearTimeout(rolloutTimer));

// ── Cron job logs ───────────────────────────────────────────────────────────
// CronJobs have no logs of their own — they create Jobs, which create Pods.
// "Logs" resolves the newest run's pod and streams it with the shared viewer;
// multi-container pods get an inline chooser, mirroring the pod flow.
async function openCronLogs(cj) {
  // Focus the trigger first so the LogViewer (via useReturnFocus) returns
  // focus here when it closes — the same pattern PodList uses.
  document.getElementById(`actions-btn-cj-${cj.name}`)?.focus();
  try {
    const detail = await api.getCronJobDetail(state.namespace, cj.name);
    const run = detail?.runs?.find((r) => r.pods?.length);
    const pod = run?.pods?.[0];
    if (!pod) {
      announce(`Cron job ${cj.name} has no recent runs to show logs for.`);
      return;
    }
    if (pod.containers.length <= 1) {
      logTarget.value = { pod: pod.name, container: pod.containers[0] || pod.name };
    } else {
      cronLogChooser.value = { cj: cj.name, pod: pod.name, containers: pod.containers };
      nextTick(() =>
        document.querySelector(`[data-cj-log-group="${cj.name}"] button`)?.focus()
      );
    }
  } catch (e) {
    announce(`Failed to load cron job runs: ${String(e)}`, "assertive");
  }
}

function pickCronLog(pod, container) {
  cronLogChooser.value = null;
  logTarget.value = { pod, container };
}

function closeLogs() {
  logTarget.value = null;
  cronLogChooser.value = null;
}

// ── Deployment create panel ────────────────────────────────────────────────
function openCreateDeploy() {
  document.getElementById("deploy-create-btn")?.focus();
  createDeployOpen.value = true;
}
function closeCreateDeploy() {
  createDeployOpen.value = false;
}
async function onDeployCreated() {
  createDeployOpen.value = false;
  await load();
}

// ── Cron job create / edit panels ──────────────────────────────────────────
// Create and edit open dedicated panels that follow the same focus-managed
// panel architecture as pod detail/logs: the panel takes focus on open and
// returns it to the button that opened it on close.
function openCreate() {
  // Focus the trigger before mounting the panel so useReturnFocus can return
  // focus here on close (same pattern as PodList's focusTriggerAndAct).
  document.getElementById("cj-create-btn")?.focus();
  createOpen.value = true;
}
function closeCreate() {
  createOpen.value = false;
}

function openEdit(cj) {
  document.getElementById(`actions-btn-cj-${cj.name}`)?.focus();
  editTarget.value = cj;
}
function closeEdit() {
  editTarget.value = null;
}

// The panels emit after a successful write; close them and refresh the list.
async function onCronCreated() {
  createOpen.value = false;
  await load();
}
async function onCronSaved() {
  editTarget.value = null;
  await load();
}

// Suspend/resume is a single confirming row action (like pod delete), not a
// panel — the user just flips the CronJob's spec.suspend flag.
async function toggleSuspend(cj) {
  suspending.value = cj.name;
  try {
    const applied = await api.updateCronJob(state.namespace, cj.name, {
      suspend: !cj.suspended,
    });
    if (!applied) return;
    announce(`Cron job ${cj.name} ${cj.suspended ? "resumed" : "suspended"}.`);
    await load();
  } catch (e) {
    announce(`Failed to update cron job ${cj.name}: ${String(e)}`, "assertive");
  } finally {
    suspending.value = "";
  }
}

async function restart(w) {
  const id = `${w.kind}/${w.name}`;
  restarting.value = id;
  try {
    const triggered = await api.restartWorkload(state.namespace, w.kind, w.name);
    if (!triggered) return;
    announce(`Rolling restart triggered for ${w.kind} ${w.name}.`);
    await load();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to restart ${w.name}: ${error.value}`, "assertive");
  } finally {
    restarting.value = "";
  }
}

// Deleting a controller is a confirmed row action (like pod delete): the
// backend asks for explicit confirmation naming the kind before removing it.
async function removeWorkload(w) {
  const id = `${w.kind}/${w.name}`;
  deleting.value = id;
  try {
    const removed = await api.deleteWorkload(state.namespace, w.kind, w.name);
    if (!removed) return;
    announce(`${w.kind} ${w.name} deleted.`);
    await load();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to delete ${w.kind} ${w.name}: ${error.value}`, "assertive");
  } finally {
    deleting.value = "";
  }
}

function openScale(w) {
  scaleValue.value = Number(w.ready.split("/")[1] ?? w.ready) || 1;
  scaling.value = { kind: w.kind, name: w.name };
}

function cancelScale() {
  scaling.value = null;
}

async function applyScale(w) {
  const n = parseInt(scaleValue.value, 10);
  if (!Number.isFinite(n) || n < 0) {
    announce("Replica count must be a non-negative integer.", "assertive");
    return;
  }
  try {
    const triggered = await api.scaleWorkload(state.namespace, w.kind, w.name, n);
    if (!triggered) return;
    announce(`${w.kind} ${w.name} scaled to ${n} replica(s).`);
    scaling.value = null;
    await load();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to scale ${w.name}: ${error.value}`, "assertive");
  }
}

function openYaml(kind, name) {
  yamlTarget.value = { kind, name };
}

// A workload is degraded if it is not fully ready (ready count < desired).
function degraded(w) {
  const [ready, desired] = w.ready.split("/").map(Number);
  return Number.isFinite(ready) && Number.isFinite(desired) && ready < desired;
}

// Deployments and StatefulSets support scaling; DaemonSets do not.
function canScale(w) {
  return w.kind === "Deployment" || w.kind === "StatefulSet";
}

watch(() => state.namespace, load, { immediate: true });

// Workload watch events carry the concrete kind (Deployment/StatefulSet/
// DaemonSet), so summarize per kind within the batch.
useWatch("watch:workloads", {
  reload: load,
  summarize(batch) {
    const byKind = {};
    for (const ev of batch) {
      const kind = ev.kind || "Workload";
      (byKind[kind] = byKind[kind] || []).push(ev);
    }
    const parts = Object.entries(byKind).map(([kind, evs]) =>
      watchAnnouncement(kind, kind + "s", evs)
    );
    announce(parts.join(" "));
  },
});

// Close the open action menu when the user clicks outside it.
onMounted(() => document.addEventListener("click", onDocClick, true));
onUnmounted(() => document.removeEventListener("click", onDocClick, true));

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="workloads-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="workloads-heading" class="h6 mb-0">
        Workloads<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.namespace"
        @click="load"
      >
        <span class="visually-hidden">Refresh workloads</span>
        <span aria-hidden="true">⟳</span>
      </button>
    </div>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to view its workloads.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <template v-else>
      <!-- A forbidden resource type (RBAC) degrades to a warning, not a
           full-screen error, so the user still sees the kinds they can read. -->
      <p v-if="workloadErrors.length" class="text-warning small" role="status">
        {{ workloadErrors.join(" · ") }}
      </p>
      <div class="row g-3">
        <!-- Left: workload / job / cronjob tables -->
        <div :class="yamlTarget || logTarget || createOpen || editTarget || createDeployOpen ? 'col-lg-7' : 'col-12'">

          <!-- ── Deployments / StatefulSets / DaemonSets ── -->
          <div class="d-flex align-items-center justify-content-between mb-1">
            <h3 class="h6 text-body-secondary mb-0">Controllers</h3>
            <button
              id="deploy-create-btn"
              type="button"
              class="btn btn-sm btn-outline-primary"
              :disabled="createDeployOpen"
              @click="openCreateDeploy"
            >
              Create<span class="visually-hidden"> deployment</span>
            </button>
          </div>
          <p v-if="workloads.length === 0" class="text-muted small">None found.</p>
          <div v-else class="table-responsive mb-3">
            <table class="table table-hover align-middle table-sm">
              <caption class="visually-hidden">Workload controllers in {{ state.namespace }}</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Name</th>
                  <th scope="col">Ready</th>
                  <th scope="col">Images</th>
                  <th scope="col">Age</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="w in workloads" :key="w.kind + w.name">
                  <tr>
                    <td><span class="badge text-bg-secondary">{{ w.kind }}</span></td>
                    <th scope="row" class="fw-normal">{{ w.name }}</th>
                    <td>
                      <span :class="degraded(w) ? 'text-danger fw-semibold' : ''">{{ w.ready }}</span>
                      <span v-if="degraded(w)" class="visually-hidden">, degraded</span>
                    </td>
                    <td>
                      <ul class="list-unstyled mb-0">
                        <li v-for="img in w.images" :key="img">
                          <code class="small">{{ img }}</code>
                        </li>
                      </ul>
                    </td>
                    <td>{{ w.age }}</td>
                    <td>
                      <div class="dropdown">
                        <button
                          :id="`actions-btn-w-${w.kind}-${w.name}`"
                          type="button"
                          class="btn btn-sm btn-outline-secondary dropdown-toggle"
                          aria-haspopup="menu"
                          :aria-expanded="menuOpen === `w-${w.kind}-${w.name}`"
                          :aria-controls="`menu-w-${w.kind}-${w.name}`"
                          @click.stop="menuOpen === `w-${w.kind}-${w.name}` ? closeMenu(`w-${w.kind}-${w.name}`) : openMenu(`w-${w.kind}-${w.name}`)"
                        >
                          Actions <span class="visually-hidden">for {{ w.kind }} {{ w.name }}</span>
                        </button>

                        <ul
                          v-if="menuOpen === `w-${w.kind}-${w.name}`"
                          :id="`menu-w-${w.kind}-${w.name}`"
                          role="menu"
                          :aria-label="`Actions for ${w.kind} ${w.name}`"
                          class="dropdown-menu show"
                          :data-menu="`w-${w.kind}-${w.name}`"
                          @keydown="onMenuKeydown($event, `w-${w.kind}-${w.name}`)"
                        >
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="focusTriggerAndAct(`w-${w.kind}-${w.name}`, () => openYaml(w.kind, w.name))"
                            >YAML</button>
                          </li>
                          <li v-if="canScale(w)" role="presentation">
                            <!-- Scale opens an inline row (not a panel), so we close the menu
                                 and let the autofocus on the scale input take over. -->
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="closeMenu(`w-${w.kind}-${w.name}`, { skipFocus: true }); nextTick(() => openScale(w))"
                            >Scale</button>
                          </li>
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              :disabled="restarting === `${w.kind}/${w.name}`"
                              @click="focusTriggerAndAct(`w-${w.kind}-${w.name}`, () => restart(w))"
                            >
                              <span
                                v-if="restarting === `${w.kind}/${w.name}`"
                                class="spinner-border spinner-border-sm me-1"
                                aria-hidden="true"
                              ></span>
                              Restart
                            </button>
                          </li>
                          <li role="separator" class="dropdown-divider"></li>
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item text-danger"
                              :disabled="deleting === `${w.kind}/${w.name}`"
                              @click="focusTriggerAndAct(`w-${w.kind}-${w.name}`, () => removeWorkload(w))"
                            >
                              <span
                                v-if="deleting === `${w.kind}/${w.name}`"
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
                  <!-- Inline scale row -->
                  <tr v-if="scaling && scaling.kind === w.kind && scaling.name === w.name">
                    <td colspan="6">
                      <form
                        class="d-flex align-items-center gap-2"
                        @submit.prevent="applyScale(w)"
                      >
                        <label :for="`scale-${w.name}`" class="form-label mb-0 small">
                          Replicas for {{ w.name }}
                        </label>
                        <input
                          :id="`scale-${w.name}`"
                          v-model.number="scaleValue"
                          type="number"
                          min="0"
                          class="form-control form-control-sm"
                          style="width: 5rem"
                          autofocus
                        />
                        <button type="submit" class="btn btn-sm btn-primary">Apply</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" @click="cancelScale">Cancel</button>
                      </form>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <!-- ── Jobs ── -->
          <h3 class="h6 text-body-secondary mb-1">Jobs</h3>
          <p v-if="jobs.length === 0" class="text-muted small">None found.</p>
          <div v-else class="table-responsive mb-3">
            <table class="table table-hover align-middle table-sm">
              <caption class="visually-hidden">Jobs in {{ state.namespace }}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Completions</th>
                  <th scope="col">Active</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Age</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="j in jobs" :key="j.name">
                  <th scope="row" class="fw-normal">{{ j.name }}</th>
                  <td>
                    <span
                      class="badge"
                      :class="{
                        'text-bg-success': j.status === 'Complete',
                        'text-bg-danger':  j.status === 'Failed',
                        'text-bg-warning': j.status === 'Suspended',
                        'text-bg-secondary': j.status === 'Running',
                      }"
                    >{{ j.status }}</span>
                  </td>
                  <td>{{ j.completions }}</td>
                  <td>{{ j.active }}</td>
                  <td>
                    <span :class="j.failed > 0 ? 'text-danger' : ''">{{ j.failed }}</span>
                  </td>
                  <td>{{ j.age }}</td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-secondary"
                      @click="openYaml('Job', j.name)"
                    >
                      YAML<span class="visually-hidden"> for job {{ j.name }}</span>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- ── CronJobs ── -->
          <div class="d-flex align-items-center justify-content-between mb-1">
            <h3 class="h6 text-body-secondary mb-0">Cron jobs</h3>
            <button
              id="cj-create-btn"
              type="button"
              class="btn btn-sm btn-outline-primary"
              :disabled="createOpen"
              @click="openCreate"
            >
              Create<span class="visually-hidden"> cron job</span>
            </button>
          </div>

          <p v-if="cronJobs.length === 0" class="text-muted small">None found.</p>
          <div v-else class="table-responsive">
            <table class="table table-hover align-middle table-sm">
              <caption class="visually-hidden">Cron jobs in {{ state.namespace }}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">Image</th>
                  <th scope="col">Active</th>
                  <th scope="col">Last scheduled</th>
                  <th scope="col">Age</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="cj in cronJobs" :key="cj.name">
                  <tr>
                    <th scope="row" class="fw-normal">{{ cj.name }}</th>
                    <td>
                      <code class="small">{{ cj.schedule }}</code>
                      <span v-if="cj.suspended" class="badge text-bg-warning ms-1"
                        >suspended</span
                      >
                      <span class="badge text-bg-secondary ms-1"
                        >{{ cj.concurrencyPolicy || "Allow" }}</span
                      >
                    </td>
                    <td><code class="small">{{ cj.image || "—" }}</code></td>
                    <td>{{ cj.active }}</td>
                    <td>{{ cj.lastSchedule || "never" }}</td>
                    <td>{{ cj.age }}</td>
                    <td>
                      <div class="dropdown">
                        <button
                          :id="`actions-btn-cj-${cj.name}`"
                          type="button"
                          class="btn btn-sm btn-outline-secondary dropdown-toggle"
                          aria-haspopup="menu"
                          :aria-expanded="menuOpen === `cj-${cj.name}`"
                          :aria-controls="`menu-cj-${cj.name}`"
                          @click.stop="menuOpen === `cj-${cj.name}` ? closeMenu(`cj-${cj.name}`) : openMenu(`cj-${cj.name}`)"
                        >
                          Actions <span class="visually-hidden">for cron job {{ cj.name }}</span>
                        </button>

                        <ul
                          v-if="menuOpen === `cj-${cj.name}`"
                          :id="`menu-cj-${cj.name}`"
                          role="menu"
                          :aria-label="`Actions for cron job ${cj.name}`"
                          class="dropdown-menu show"
                          :data-menu="`cj-${cj.name}`"
                          @keydown="onMenuKeydown($event, `cj-${cj.name}`)"
                        >
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="focusTriggerAndAct(`cj-${cj.name}`, () => openCronLogs(cj))"
                            >Logs</button>
                          </li>
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="focusTriggerAndAct(`cj-${cj.name}`, () => openEdit(cj))"
                            >Edit</button>
                          </li>
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              :disabled="suspending === cj.name"
                              @click="focusTriggerAndAct(`cj-${cj.name}`, () => toggleSuspend(cj))"
                            >
                              {{ cj.suspended ? "Resume" : "Suspend" }}
                            </button>
                          </li>
                          <li role="presentation">
                            <button
                              type="button"
                              role="menuitem"
                              class="dropdown-item"
                              @click="focusTriggerAndAct(`cj-${cj.name}`, () => openYaml('CronJob', cj.name))"
                            >YAML</button>
                          </li>
                        </ul>
                      </div>
                    </td>
                  </tr>
                  <!-- Container chooser for multi-container run logs -->
                  <tr v-if="cronLogChooser && cronLogChooser.cj === cj.name">
                    <td colspan="7">
                      <fieldset class="mb-0" :data-cj-log-group="cj.name">
                        <legend class="h6 small text-body-secondary">
                          Choose a container to stream logs from {{ cronLogChooser.pod }}
                        </legend>
                        <div class="d-flex flex-wrap gap-2">
                          <button
                            v-for="c in cronLogChooser.containers"
                            :key="c"
                            type="button"
                            class="btn btn-sm btn-secondary"
                            @click="pickCronLog(cronLogChooser.pod, c)"
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

          <!-- ── Recent rollouts (durable) ────────────────────────────────
               Events expire after ~1h, so the lasting answer to "which deploy
               was triggered and when" is each Deployment's ReplicaSet
               revision trail. The user decides the scope via the controls
               below; the backend applies their choices and nothing else. -->
          <h3 class="h6 text-body-secondary mb-1 mt-3">Recent rollouts</h3>

          <div class="row g-2 align-items-end mb-2">
            <div class="col-12 col-lg">
              <label for="rollout-filter" class="form-label mb-1 small"
                >Filter rollouts by deployment name</label
              >
              <input
                id="rollout-filter"
                v-model="rolloutFilter"
                type="search"
                class="form-control form-control-sm"
                placeholder="Deployment name…"
                autocomplete="off"
              />
            </div>
            <div class="col-6 col-lg-auto">
              <label for="rollout-limit" class="form-label mb-1 small"
                >Deployments shown</label
              >
              <select
                id="rollout-limit"
                v-model="maxDeployments"
                class="form-select form-select-sm"
              >
                <option :value="50">50</option>
                <option :value="100">100</option>
                <option :value="200">200</option>
                <option :value="0">All</option>
              </select>
            </div>
            <div class="col-6 col-lg-auto">
              <label for="rollout-depth" class="form-label mb-1 small"
                >Revisions per deployment</label
              >
              <select
                id="rollout-depth"
                v-model="revisionsPerDeploy"
                class="form-select form-select-sm"
              >
                <option :value="5">5</option>
                <option :value="10">10</option>
                <option :value="25">25</option>
                <option :value="0">All</option>
              </select>
            </div>
          </div>

          <p v-if="rolloutsError" class="text-muted small" role="status">
            Rollout history unavailable: {{ rolloutsError }}
          </p>
          <p v-else-if="rollouts.length === 0" class="text-muted small">
            No rollouts match these options.
          </p>
          <template v-else>
            <p v-if="rolloutsTotal > rollouts.length" class="text-body-secondary small">
              Showing {{ rollouts.length }} of {{ rolloutsTotal }} rolled-out
              deployments. Increase “Deployments shown” to see more.
            </p>
            <ul class="list-unstyled small">
              <li
                v-for="r in rollouts"
                :key="r.name"
                class="border rounded p-2 mb-2"
              >
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="fw-semibold">{{ r.name }}</span>
                  <span v-if="r.revision" class="badge text-bg-secondary"
                    >revision {{ r.revision }}</span
                  >
                  <span v-if="r.rollouts.length" class="text-body-secondary"
                    >{{ r.rollouts[0].age }} ago</span
                  >
                </div>
                <ul v-if="r.rollouts.length" class="list-unstyled mb-0 mt-1 ps-3">
                  <li v-for="rev in r.rollouts" :key="rev.revision">
                    <span class="me-2">revision {{ rev.revision }}</span>
                    <span class="text-body-secondary">{{ rev.age }}</span>
                  </li>
                </ul>
              </li>
            </ul>
          </template>
        </div>

        <!-- Right: YAML / log / create / edit panels. Every panel here follows
             the same focus-managed architecture as the pod detail/log screens:
             it takes focus on open and returns it to the triggering button on
             close. -->
        <div
          v-if="yamlTarget || logTarget || createOpen || editTarget || createDeployOpen"
          class="col-lg-5"
          style="min-height: 24rem"
        >
          <div v-if="yamlTarget" class="mb-3">
            <YamlViewer
              :key="yamlTarget.kind + yamlTarget.name"
              :namespace="state.namespace"
              :kind="yamlTarget.kind"
              :name="yamlTarget.name"
              @close="yamlTarget = null"
            />
          </div>
          <div v-if="logTarget" class="mb-3">
            <LogViewer
              :key="`${logTarget.pod}/${logTarget.container}`"
              :namespace="state.namespace"
              :pod="logTarget.pod"
              :container="logTarget.container"
              @close="closeLogs"
            />
          </div>
          <div v-if="createOpen" class="mb-3">
            <CronJobCreate
              :namespace="state.namespace"
              @close="closeCreate"
              @created="onCronCreated"
            />
          </div>
          <div v-if="editTarget">
            <CronJobEdit
              :key="editTarget.name"
              :namespace="state.namespace"
              :cron-job="editTarget"
              @close="closeEdit"
              @saved="onCronSaved"
            />
          </div>
          <div v-if="createDeployOpen">
            <DeploymentCreate
              :namespace="state.namespace"
              @close="closeCreateDeploy"
              @created="onDeployCreated"
            />
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

