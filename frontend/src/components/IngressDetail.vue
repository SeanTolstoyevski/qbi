<script setup>
import { ref, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import YamlViewer from "./YamlViewer.vue";

const props = defineProps({
  namespace: { type: String, required: true },
  name: { type: String, required: true },
  openerId: { type: String, default: null }, // id of the trigger button for focus return
});

const emit = defineEmits(["close", "deleted", "edit"]);
const { announce } = useStore();

const detail = ref(null); // IngressDetail { ingress, events, eventsError }
const loading = ref(false);
const error = ref("");
const headingEl = ref(null);
const yamlOpen = ref(false);

const { onKeydown } = useReturnFocus({
  focusTarget: headingEl,
  openerId: props.openerId,
  onClose: () => emit("close"),
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    detail.value = await api.getIngressDetail(props.namespace, props.name);
    const issues = detail.value.ingress?.issues || [];
    announce(
      issues.length
        ? `Ingress ${props.name}: ${issues.length} issue${issues.length === 1 ? "" : "s"} found.`
        : `Ingress ${props.name} looks healthy.`,
    );
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load ingress details: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const deleting = ref(false);
async function remove() {
  deleting.value = true;
  try {
    const removed = await api.deleteIngress(props.namespace, props.name);
    if (!removed) return; // user cancelled the native confirmation
    announce(`Ingress ${props.name} deleted.`);
    emit("deleted");
  } catch (e) {
    error.value = String(e);
    announce(
      `Failed to delete ingress ${props.name}: ${error.value}`,
      "assertive",
    );
  } finally {
    deleting.value = false;
  }
}

watch(yamlOpen, (open) => {
  if (!open) nextTick(() => headingEl.value?.focus());
});

watch(() => [props.namespace, props.name], load, { immediate: true });

const labelPairs = (m) =>
  Object.entries(m || {}).sort(([a], [b]) => a.localeCompare(b));

defineExpose({ load });
</script>

<template>
  <section
    aria-labelledby="ing-detail-heading"
    class="h-100 scroll-pane"
    @keydown="yamlOpen ? undefined : onKeydown"
  >
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="ing-detail-heading" ref="headingEl" class="h6 mb-0" tabindex="-1">
        Ingress: {{ name }}
      </h2>
      <div class="d-flex gap-2">
        <button
          id="ing-detail-edit-btn"
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="yamlOpen || deleting || !detail"
          @click="emit('edit', name)"
        >
          Edit<span class="visually-hidden"> ingress {{ name }}</span>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-danger"
          :disabled="yamlOpen || deleting || !detail"
          @click="remove"
        >
          <span
            v-if="deleting"
            class="spinner-border spinner-border-sm me-1"
            aria-hidden="true"
          ></span>
          Delete<span class="visually-hidden"> ingress {{ name }}</span>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="yamlOpen"
          @click="yamlOpen = true"
        >
          YAML
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="yamlOpen"
          @click="load"
        >
          <span class="visually-hidden">Refresh ingress details</span>
          <span aria-hidden="true">⟳</span>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
    </div>

    <YamlViewer
      v-if="yamlOpen"
      :namespace="namespace"
      kind="Ingress"
      :name="name"
      @close="yamlOpen = false"
    />

    <template v-else>
      <p v-if="loading" class="text-muted small" role="status">Loading…</p>
      <p v-else-if="error" class="text-danger small" role="alert">
        {{ error }}
      </p>

      <template v-else-if="detail">
        <div class="ing-detail-body">
          <dl class="row small mb-2">
            <dt class="col-sm-4">Class</dt>
            <dd class="col-sm-8">
              <code>{{ detail.ingress.class || "default" }}</code>
            </dd>
            <dt class="col-sm-4">Address</dt>
            <dd class="col-sm-8">
              <template
                v-if="
                  detail.ingress.addresses && detail.ingress.addresses.length
                "
              >
                <ul class="list-unstyled mb-0">
                  <li v-for="a in detail.ingress.addresses" :key="a">
                    <code>{{ a }}</code>
                  </li>
                </ul>
              </template>
              <span v-else class="text-warning">not assigned yet</span>
            </dd>
            <dt class="col-sm-4">Age</dt>
            <dd class="col-sm-8">{{ detail.ingress.age }}</dd>
          </dl>

          <!-- Issues are the heart of this view: plain-language problems a
               screen reader can read one at a time. -->
          <div
            v-if="detail.ingress.issues && detail.ingress.issues.length"
            class="alert alert-warning py-2"
          >
            <h3 class="h6">Issues</h3>
            <ul class="mb-0 small">
              <li v-for="(iss, i) in detail.ingress.issues" :key="i">
                {{ iss }}
              </li>
            </ul>
          </div>

          <template v-if="labelPairs(detail.ingress.annotations).length">
            <h3 class="h6 mt-3">Annotations</h3>
            <ul class="list-unstyled small mb-0">
              <li
                v-for="[k, v] in labelPairs(detail.ingress.annotations)"
                :key="k"
              >
                <code>{{ k }}={{ v }}</code>
              </li>
            </ul>
          </template>

          <template v-if="detail.ingress.tls && detail.ingress.tls.length">
            <h3 class="h6 mt-3">TLS</h3>
            <table class="table table-sm">
              <caption class="visually-hidden">
                TLS hosts and certificates for ingress
                {{
                  name
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Hosts</th>
                  <th scope="col">Secret</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(t, ti) in detail.ingress.tls" :key="ti">
                  <td>
                    <code>{{
                      (t.hosts || []).join(", ") || "(all hosts)"
                    }}</code>
                  </td>
                  <td>
                    <code>{{ t.secretName || "—" }}</code>
                  </td>
                  <td>
                    <span
                      v-if="t.secretStatus === 'missing'"
                      class="text-danger fw-semibold"
                      >secret missing</span
                    >
                    <span
                      v-else-if="t.secretStatus === 'ok'"
                      class="text-success"
                      >present</span
                    >
                    <span v-else class="text-body-secondary">not checked</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>

          <h3 class="h6 mt-3">Routing rules</h3>
          <p
            v-if="
              !detail.ingress.rules.length && !detail.ingress.defaultBackend
            "
            class="text-muted small"
          >
            No routing rules defined — this ingress forwards no traffic.
          </p>
          <template v-else>
            <table class="table table-sm">
              <caption class="visually-hidden">
                Host and path routing rules for ingress
                {{
                  name
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
                <template v-for="(rule, ri) in detail.ingress.rules" :key="ri">
                  <tr v-for="(path, pi) in rule.paths" :key="ri + '-' + pi">
                    <td>
                      <code>{{ rule.host }}</code>
                    </td>
                    <td>
                      <code>{{ path.path || "/" }}</code>
                    </td>
                    <td>{{ path.pathType || "—" }}</td>
                    <td>
                      <code v-if="path.serviceName"
                        >{{ path.serviceName }}:{{ path.servicePort }}</code
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
                <tr v-if="detail.ingress.defaultBackend">
                  <td colspan="2">
                    <span class="text-body-secondary">default backend</span>
                  </td>
                  <td>—</td>
                  <td>
                    <code v-if="detail.ingress.defaultBackend.serviceName"
                      >{{ detail.ingress.defaultBackend.serviceName }}:{{
                        detail.ingress.defaultBackend.servicePort
                      }}</code
                    >
                    <span v-else class="text-body-secondary"
                      >resource backend</span
                    >
                  </td>
                  <td>
                    <span
                      v-if="
                        detail.ingress.defaultBackend.status === 'no-service'
                      "
                      class="text-danger fw-semibold"
                      >service missing</span
                    >
                    <span
                      v-else-if="
                        detail.ingress.defaultBackend.status === 'no-endpoints'
                      "
                      class="text-warning fw-semibold"
                      >no ready endpoints</span
                    >
                    <span
                      v-else-if="detail.ingress.defaultBackend.status === 'ok'"
                      class="text-success"
                    >
                      ok ({{ detail.ingress.defaultBackend.readyEndpoints }}
                      ready)
                    </span>
                    <span v-else class="text-body-secondary">not checked</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>

          <h3 class="h6 mt-3">Events</h3>
          <p v-if="detail.eventsError" class="text-muted small">
            Events unavailable: {{ detail.eventsError }}
          </p>
          <p v-else-if="!detail.events.length" class="text-muted small">
            No events for this ingress in the last hour.
          </p>
          <table v-else class="table table-sm align-middle">
            <caption class="visually-hidden">
              Events for ingress
              {{
                name
              }}, most recent first
            </caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Reason</th>
                <th scope="col">Message</th>
                <th scope="col">Count</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(e, i) in detail.events"
                :key="i"
                :class="{ 'table-warning': e.type === 'Warning' }"
              >
                <td>
                  <span
                    class="badge"
                    :class="
                      e.type === 'Warning'
                        ? 'text-bg-warning'
                        : 'text-bg-secondary'
                    "
                    >{{ e.type }}</span
                  >
                </td>
                <td>{{ e.reason }}</td>
                <td>{{ e.message }}</td>
                <td>{{ e.count }}</td>
                <td>{{ e.lastSeen || "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
