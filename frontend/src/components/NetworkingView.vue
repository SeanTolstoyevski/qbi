<script setup>
import { ref, watch } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import { useActionMenu } from "../useActionMenu.js";
import ServiceCreate from "./ServiceCreate.vue";
import IngressDetail from "./IngressDetail.vue";
import IngressCreate from "./IngressCreate.vue";
import InlineButton from "./InlineButton.vue";

const { state, announce } = useStore();

const services = ref([]);
const ingresses = ref([]);
const loading = ref(false);
const error = ref("");
const createServiceOpen = ref(false);
const createIngressOpen = ref(false);
const editTarget = ref(""); // ingress name being edited
const deleting = ref(""); // service name while a deletion is in flight
const inspectTarget = ref(null); // IngressInfo being inspected
const detailRef = ref(null); // IngressDetail component instance (for reload)
const deletingIng = ref(""); // ingress name while a deletion is in flight

// ── Action menu (same convention as PodList) ────────────────────────────────
const { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
  useActionMenu();

// The create/edit panels are separate focus-managed screens (like the pod
// panels); only one side panel is open at a time. Every panel receives its
// trigger button's id as openerId so focus returns to exactly that button on
// close — even when panels swap in the same render pass, where the outgoing
// panel's focus-return would otherwise overwrite the captured opener.
function openCreateService() {
  inspectTarget.value = null;
  createIngressOpen.value = false;
  editTarget.value = "";
  createServiceOpen.value = true;
}
function closeCreateService() {
  createServiceOpen.value = false;
}
async function onServiceCreated() {
  createServiceOpen.value = false;
  await load();
}

function openCreateIngress() {
  inspectTarget.value = null;
  createServiceOpen.value = false;
  editTarget.value = "";
  createIngressOpen.value = true;
}
function closeCreateIngress() {
  createIngressOpen.value = false;
}
async function onIngressCreated() {
  createIngressOpen.value = false;
  await load();
}

function openEditIngress(ing) {
  inspectTarget.value = null;
  createServiceOpen.value = false;
  createIngressOpen.value = false;
  editTarget.value = ing.name;
}
function closeEditIngress() {
  editTarget.value = "";
}
async function onIngressSaved() {
  editTarget.value = "";
  await load();
}

// Inspecting an ingress opens its debugging panel (issues, TLS, backend
// health, events); only one side panel is open at a time.
function openInspect(ing) {
  createServiceOpen.value = false;
  createIngressOpen.value = false;
  editTarget.value = "";
  inspectTarget.value = ing;
}
function closeInspect() {
  inspectTarget.value = null;
}

// The inspected ingress was deleted from its detail panel: close the panel
// and refresh the list.
async function onIngressDeleted() {
  inspectTarget.value = null;
  await load();
}

// The ingress is being edited from its detail panel: swap to the edit form.
// Both panels capture their openers by explicit id (openerId), so the swap
// ordering — the detail's focus-return runs in the same flush — cannot leak
// focus to the wrong button: closing the edit form returns to the row's
// Edit button.
function onIngressEdit(name) {
  inspectTarget.value = null;
  editTarget.value = name;
}

// A namespace switch invalidates all side panels: their content belongs to
// the previous namespace. Watch-triggered reloads must NOT close them (a
// user mid-form would lose their work on a busy cluster).
watch(
  () => state.namespace,
  () => {
    inspectTarget.value = null;
    createServiceOpen.value = false;
    createIngressOpen.value = false;
    editTarget.value = "";
    menuOpen.value = "";
  },
);

// Deleting a service is a confirmed row action; only the load-balancing
// entry is removed, the backing pods keep running.
async function removeService(svc) {
  deleting.value = svc.name;
  try {
    const removed = await api.deleteService(state.namespace, svc.name);
    if (!removed) return;
    announce(`Service ${svc.name} deleted.`);
    await load();
  } catch (e) {
    error.value = String(e);
    announce(
      `Failed to delete service ${svc.name}: ${error.value}`,
      "assertive",
    );
  } finally {
    deleting.value = "";
  }
}

// Deleting an ingress is a confirmed row action: the backend asks for
// explicit confirmation before removing only the routing rules (services and
// pods keep running).
async function removeIngress(ing) {
  deletingIng.value = ing.name;
  try {
    const removed = await api.deleteIngress(state.namespace, ing.name);
    if (!removed) return;
    announce(`Ingress ${ing.name} deleted.`);
    if (inspectTarget.value?.name === ing.name) {
      inspectTarget.value = null; // the inspected ingress no longer exists
    }
    if (editTarget.value === ing.name) {
      editTarget.value = ""; // the edited ingress no longer exists
    }
    await load();
  } catch (e) {
    error.value = String(e);
    announce(
      `Failed to delete ingress ${ing.name}: ${error.value}`,
      "assertive",
    );
  } finally {
    deletingIng.value = "";
  }
}

async function load() {
  // Nothing may be fetched without a live connection; the view is normally
  // unmounted by then, but stay self-consistent for safety.
  if (!state.connected || !state.namespace) return;
  loading.value = true;
  error.value = "";
  try {
    const [svc, ing] = await Promise.all([
      api.listServices(state.namespace),
      api.listIngresses(state.namespace),
    ]);
    services.value = svc || [];
    ingresses.value = ing || [];
    announce(
      `${services.value.length} services and ${ingresses.value.length} ingresses in ${state.namespace}.`,
    );
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load networking: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

function portSummary(p) {
  const np = p.nodePort ? ` (nodePort ${p.nodePort})` : "";
  const name = p.name ? `${p.name}: ` : "";
  return `${name}${p.port} → ${p.targetPort}/${p.protocol}${np}`;
}

const hasSelector = (svc) =>
  svc.selector && Object.keys(svc.selector).length > 0;

function selectorSummary(svc) {
  return Object.entries(svc.selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

// Reload on namespace changes and on every (re)connect: reconnecting to the
// same context leaves the namespace unchanged, so the epoch is what forces
// the fresh load. load() itself guards on state.namespace. An open inspected
// ingress refreshes in place too (same mechanism as a watch event), so the
// detail panel never shows data from the dead connection.
watch(
  () => [state.namespace, state.connectionEpoch],
  async () => {
    await load();
    detailRef.value?.load?.();
  },
  { immediate: true },
);

useWatch("watch:services", {
  reload: load,
  summarize: (batch) =>
    announce(watchAnnouncement("Service", "services", batch)),
});
useWatch("watch:ingresses", {
  // The list reloads and, if an ingress is being inspected, the open detail
  // panel refreshes in place too (its exposed load keeps focus where it is).
  reload: async () => {
    await load();
    detailRef.value?.load?.();
  },
  summarize: (batch) =>
    announce(watchAnnouncement("Ingress", "ingresses", batch)),
});

// Close the open action menu when the user clicks outside it.

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="net-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="net-heading" class="h6 mb-0">
        Networking<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <div class="d-flex align-items-center gap-2">
        <button
          id="svc-create-btn"
          type="button"
          class="btn btn-sm btn-outline-primary"
          :disabled="createServiceOpen || !state.connected || !state.namespace"
          @click="openCreateService"
        >
          Create service
        </button>
        <button
          id="ing-create-btn"
          type="button"
          class="btn btn-sm btn-outline-primary"
          :disabled="createIngressOpen || !state.connected || !state.namespace"
          @click="openCreateIngress"
        >
          Create ingress
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || !state.connected || !state.namespace"
          @click="load"
        >
          <span class="visually-hidden">Refresh networking</span>
          <span aria-hidden="true">⟳</span>
        </button>
      </div>
    </div>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to view its networking.
    </p>

    <div v-else class="row g-3">
      <!-- The side panel stays mounted while the list reloads, so a watch
           refresh never tears it down (which would bounce focus and refetch
           the detail). -->
      <div
        :class="
          createServiceOpen || createIngressOpen || editTarget || inspectTarget
            ? 'col-lg-7'
            : 'col-12'
        "
      >
        <p v-if="loading" class="text-muted small" role="status">Loading…</p>
        <p v-else-if="error" class="text-danger small" role="alert">
          {{ error }}
        </p>
        <template v-else>
          <!-- SERVICES -->
          <h3 class="h6 mt-2">Services</h3>
          <p v-if="services.length === 0" class="text-muted small">
            No services found.
          </p>
          <ul v-else class="list-group mb-4">
            <li v-for="svc in services" :key="svc.name" class="list-group-item">
              <div
                class="d-flex align-items-start justify-content-between gap-2"
              >
                <div>
                  <span class="fw-semibold">{{ svc.name }}</span>
                  <span class="badge text-bg-secondary ms-1">{{
                    svc.type
                  }}</span>
                </div>
                <div class="d-flex align-items-center gap-2">
                  <span class="small text-body-secondary">{{ svc.age }}</span>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    :disabled="deleting === svc.name"
                    @click="removeService(svc)"
                  >
                    <span
                      v-if="deleting === svc.name"
                      class="spinner-border spinner-border-sm me-1"
                      aria-hidden="true"
                    ></span>
                    Delete<span class="visually-hidden">
                      service {{ svc.name }}</span
                    >
                  </button>
                </div>
              </div>

              <dl class="row mb-0 mt-1 small">
                <dt class="col-sm-3">DNS name</dt>
                <dd class="col-sm-9 mb-1 hover-reveal">
                  <code>{{ svc.dnsName }}</code>
                  <InlineButton
                    variant="inline"
                    :copy-text="svc.dnsName"
                    announce="DNS name"
                  />
                </dd>

                <dt class="col-sm-3">Cluster IP</dt>
                <dd class="col-sm-9 mb-1">
                  <code>{{ svc.clusterIP || "None" }}</code>
                </dd>

                <template v-if="svc.externalIPs && svc.externalIPs.length">
                  <dt class="col-sm-3">External IPs</dt>
                  <dd class="col-sm-9 mb-1">
                    <code>{{ svc.externalIPs.join(", ") }}</code>
                  </dd>
                </template>

                <dt class="col-sm-3">Ports</dt>
                <dd class="col-sm-9 mb-1">
                  <span
                    v-if="svc.ports.length === 0"
                    class="text-body-secondary"
                    >none</span
                  >
                  <ul v-else class="list-unstyled mb-0">
                    <li v-for="p in svc.ports" :key="p.name + p.port">
                      <code>{{ portSummary(p) }}</code>
                    </li>
                  </ul>
                </dd>

                <dt class="col-sm-3">Selector</dt>
                <dd class="col-sm-9 mb-1">
                  <code v-if="hasSelector(svc)">{{
                    selectorSummary(svc)
                  }}</code>
                  <span v-else class="text-body-secondary"
                    >none (manual endpoints)</span
                  >
                </dd>

                <dt class="col-sm-3">
                  Endpoints
                  <span class="visually-hidden">(backing pod IPs)</span>
                </dt>
                <dd class="col-sm-9 mb-0">
                  <span
                    v-if="!svc.endpoints || svc.endpoints.length === 0"
                    class="text-warning"
                  >
                    No ready endpoints
                  </span>
                  <ul v-else class="list-unstyled mb-0">
                    <li v-for="ip in svc.endpoints" :key="ip">
                      <code>{{ ip }}</code>
                    </li>
                  </ul>
                </dd>
              </dl>
            </li>
          </ul>

          <!-- INGRESSES -->
          <h3 class="h6">Ingresses</h3>
          <p v-if="ingresses.length === 0" class="text-muted small">
            No ingresses found.
          </p>
          <ul v-else class="list-group">
            <li
              v-for="ing in ingresses"
              :key="ing.name"
              class="list-group-item"
            >
              <div
                class="d-flex align-items-start justify-content-between gap-2"
              >
                <div>
                  <span class="fw-semibold">{{ ing.name }}</span>
                  <span v-if="ing.class" class="badge text-bg-secondary ms-1">{{
                    ing.class
                  }}</span>
                  <span
                    v-if="ing.issues && ing.issues.length"
                    class="badge text-bg-warning ms-1"
                    >{{ ing.issues.length }} issue{{
                      ing.issues.length === 1 ? "" : "s"
                    }}</span
                  >
                </div>
                <div class="d-flex align-items-center gap-2">
                  <span class="small text-body-secondary">{{ ing.age }}</span>
                  <div class="dropdown">
                    <button
                      :id="`actions-btn-ing-${ing.name}`"
                      type="button"
                      class="btn btn-sm btn-outline-secondary dropdown-toggle"
                      aria-haspopup="menu"
                      :aria-expanded="menuOpen === `ing-${ing.name}`"
                      :aria-controls="`menu-ing-${ing.name}`"
                      @click.stop="
                        menuOpen === `ing-${ing.name}`
                          ? closeMenu(`ing-${ing.name}`)
                          : openMenu(`ing-${ing.name}`)
                      "
                    >
                      Actions
                      <span class="visually-hidden"
                        >for ingress {{ ing.name }}</span
                      >
                    </button>

                    <ul
                      v-if="menuOpen === `ing-${ing.name}`"
                      :id="`menu-ing-${ing.name}`"
                      role="menu"
                      :aria-label="`Actions for ingress ${ing.name}`"
                      class="dropdown-menu show"
                      :data-menu="`ing-${ing.name}`"
                      @keydown="onMenuKeydown($event, `ing-${ing.name}`)"
                    >
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          @click="
                            focusTriggerAndAct(`ing-${ing.name}`, () =>
                              openEditIngress(ing),
                            )
                          "
                        >
                          Edit
                        </button>
                      </li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item"
                          @click="
                            focusTriggerAndAct(`ing-${ing.name}`, () =>
                              openInspect(ing),
                            )
                          "
                        >
                          Inspect
                        </button>
                      </li>
                      <li role="separator" class="dropdown-divider"></li>
                      <li role="presentation">
                        <button
                          type="button"
                          role="menuitem"
                          class="dropdown-item text-danger"
                          :disabled="deletingIng === ing.name"
                          @click="
                            focusTriggerAndAct(`ing-${ing.name}`, () =>
                              removeIngress(ing),
                            )
                          "
                        >
                          <span
                            v-if="deletingIng === ing.name"
                            class="spinner-border spinner-border-sm me-1"
                            aria-hidden="true"
                          ></span>
                          Delete
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              <dl class="row mb-0 mt-1 small">
                <dt class="col-sm-3">Address</dt>
                <dd class="col-sm-9 mb-1">
                  <template v-if="ing.addresses && ing.addresses.length">
                    <code>{{ ing.addresses.join(", ") }}</code>
                  </template>
                  <span v-else class="text-warning">not assigned yet</span>
                </dd>

                <template v-if="ing.tls && ing.tls.length">
                  <dt class="col-sm-3">TLS</dt>
                  <dd class="col-sm-9 mb-1">
                    <ul class="list-unstyled mb-0">
                      <li v-for="(t, ti) in ing.tls" :key="ti">
                        <code>{{
                          (t.hosts || []).join(", ") || "(all hosts)"
                        }}</code>
                        <span class="text-body-secondary"> via </span>
                        <code>{{ t.secretName || "—" }}</code>
                        <span
                          v-if="t.secretStatus === 'missing'"
                          class="text-warning"
                        >
                          (secret missing)
                        </span>
                      </li>
                    </ul>
                  </dd>
                </template>

                <dt class="col-sm-3">Host rules</dt>
                <dd class="col-sm-9 mb-0">
                  <p
                    v-if="ing.rules.length === 0"
                    class="text-body-secondary mb-0"
                  >
                    none
                  </p>
                  <table v-else class="table table-sm mb-0">
                    <caption class="visually-hidden">
                      Host and path routing rules for ingress
                      {{
                        ing.name
                      }}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Host</th>
                        <th scope="col">Path</th>
                        <th scope="col">Type</th>
                        <th scope="col">Backend service</th>
                        <th scope="col">Backend status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <template v-for="(rule, ri) in ing.rules" :key="ri">
                        <tr
                          v-for="(path, pi) in rule.paths"
                          :key="ri + '-' + pi"
                        >
                          <td>
                            <code>{{ rule.host }}</code>
                          </td>
                          <td>
                            <code>{{ path.path || "/" }}</code>
                          </td>
                          <td>{{ path.pathType || "—" }}</td>
                          <td>
                            <code v-if="path.serviceName"
                              >{{ path.serviceName }}:{{
                                path.servicePort
                              }}</code
                            >
                            <span v-else class="text-body-secondary"
                              >resource backend</span
                            >
                          </td>
                          <td>
                            <span
                              v-if="path.status === 'no-service'"
                              class="text-danger fw-semibold"
                              >service missing</span
                            >
                            <span
                              v-else-if="path.status === 'no-endpoints'"
                              class="text-warning fw-semibold"
                              >no ready endpoints</span
                            >
                            <span
                              v-else-if="path.status === 'ok'"
                              class="text-success"
                            >
                              ok ({{ path.readyEndpoints }} ready)
                            </span>
                            <span v-else class="text-body-secondary"
                              >not checked</span
                            >
                          </td>
                        </tr>
                      </template>
                    </tbody>
                  </table>
                </dd>
              </dl>
            </li>
          </ul>
        </template>
      </div>

      <!-- Right: create/edit panels or the ingress inspection panel -->
      <div v-if="createServiceOpen" class="col-lg-5" style="min-height: 24rem">
        <ServiceCreate
          :namespace="state.namespace"
          opener-id="svc-create-btn"
          @close="closeCreateService"
          @created="onServiceCreated"
        />
      </div>
      <div
        v-else-if="createIngressOpen"
        class="col-lg-5"
        style="min-height: 24rem"
      >
        <IngressCreate
          :namespace="state.namespace"
          opener-id="ing-create-btn"
          @close="closeCreateIngress"
          @created="onIngressCreated"
        />
      </div>
      <div v-else-if="editTarget" class="col-lg-5" style="min-height: 24rem">
        <IngressCreate
          :key="'edit-' + editTarget"
          :namespace="state.namespace"
          :ingress-name="editTarget"
          :opener-id="`actions-btn-ing-${editTarget}`"
          @close="closeEditIngress"
          @saved="onIngressSaved"
        />
      </div>
      <div v-else-if="inspectTarget" class="col-lg-5" style="min-height: 24rem">
        <IngressDetail
          ref="detailRef"
          :key="inspectTarget.name"
          :namespace="state.namespace"
          :name="inspectTarget.name"
          :opener-id="`actions-btn-ing-${inspectTarget.name}`"
          @close="closeInspect"
          @deleted="onIngressDeleted"
          @edit="onIngressEdit"
        />
      </div>
    </div>
  </section>
</template>
