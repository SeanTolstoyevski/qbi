<script setup>
import { ref, computed, nextTick } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { usePortForwards } from "../usePortForwards.js";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime.js";
import Combobox from "./Combobox.vue";
import InlineButton from "./InlineButton.vue";
import { forwardBadgeClass } from "../statusClasses.js";

const props = defineProps({
  namespace: { type: String, required: true },
  pod: { type: String, required: true },
  ports: { type: Array, default: () => [] },
});

const { announce } = useStore();
const { forwards, stopForward } = usePortForwards();

const podForwards = computed(() =>
  forwards.value.filter(
    (f) => f.namespace === props.namespace && f.pod === props.pod,
  ),
);

const formOpen = ref(false);
const remotePort = ref("");
const localPort = ref("");
const starting = ref(false);
const formError = ref("");

const portOptions = computed(() => {
  const seen = new Set();
  const out = [];
  for (const p of props.ports) {
    if (p > 0 && !seen.has(p)) {
      seen.add(p);
      out.push({ value: p, label: String(p) });
    }
  }
  return out;
});

function toggleForm() {
  formOpen.value = !formOpen.value;
  if (formOpen.value) {
    nextTick(() => document.getElementById("pf-remote-port")?.focus());
  }
}

async function startForward() {
  const remote = Number.parseInt(remotePort.value, 10);
  if (!Number.isInteger(remote) || remote < 1 || remote > 65535) {
    formError.value = "Remote port must be a number between 1 and 65535.";
    announce(formError.value, "assertive");
    return;
  }
  let local = 0;
  if (localPort.value !== "") {
    local = Number.parseInt(localPort.value, 10);
    if (!Number.isInteger(local) || local < 1 || local > 65535) {
      formError.value =
        "Local port must be a number between 1 and 65535, or be left empty for a random free port.";
      announce(formError.value, "assertive");
      return;
    }
  }

  starting.value = true;
  formError.value = "";
  try {
    await api.startPortForward(props.namespace, props.pod, local, remote);
    formOpen.value = false;
    remotePort.value = "";
    localPort.value = "";
  } catch (e) {
    formError.value = String(e);
    announce(`Port forward failed: ${formError.value}`, "assertive");
  } finally {
    starting.value = false;
  }
}

function openInBrowser(f) {
  BrowserOpenURL(`http://127.0.0.1:${f.localPort}`);
}
</script>

<template>
  <section aria-labelledby="port-forward-heading" class="mt-3">
    <div class="d-flex align-items-center justify-content-between">
      <h3 id="port-forward-heading" class="h6 mb-0">Port forwarding</h3>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :aria-expanded="formOpen"
        aria-controls="port-forward-form"
        @click="toggleForm"
      >
        {{ formOpen ? "Close" : "Forward port…" }}
      </button>
    </div>

    <form
      v-if="formOpen"
      id="port-forward-form"
      class="border rounded p-2 mt-2"
      @submit.prevent="startForward"
    >
      <div class="row g-2 align-items-end">
        <div class="col-sm-5">
          <label for="pf-remote-port" class="form-label small mb-1"
            >Remote port</label
          >
          <Combobox
            id="pf-remote-port"
            v-model="remotePort"
            :options="portOptions"
            placeholder="e.g. 8080"
          />
        </div>
        <div class="col-sm-5">
          <label for="pf-local-port" class="form-label small mb-1"
            >Local port (optional)</label
          >
          <input
            id="pf-local-port"
            v-model="localPort"
            type="text"
            inputmode="numeric"
            class="form-control form-control-sm"
            aria-describedby="pf-local-help"
          />
          <div id="pf-local-help" class="form-text small">
            Leave empty to use a random free port.
          </div>
        </div>
        <div class="col-sm-2">
          <button
            type="submit"
            class="btn btn-sm btn-primary w-100"
            :disabled="starting"
          >
            {{ starting ? "Starting…" : "Start" }}
          </button>
        </div>
      </div>
      <p v-if="formError" class="text-danger small mt-2 mb-0" role="alert">
        {{ formError }}
      </p>
    </form>

    <p v-if="!podForwards.length" class="text-muted small mt-2 mb-0">
      No active port forwards for this pod.
    </p>
    <table v-else class="table table-sm mt-2">
      <caption class="visually-hidden">
        Active port forwards for
        {{
          pod
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Local address</th>
          <th scope="col">Target</th>
          <th scope="col">Status</th>
          <th scope="col">
            <span class="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in podForwards" :key="f.id">
          <td>
            <code>127.0.0.1:{{ f.localPort }}</code>
            <InlineButton
              variant="inline"
              :copy-text="`127.0.0.1:${f.localPort}`"
              announce="Local address"
              text="Copy"
            />
          </td>
          <td>
            <code>{{ f.pod }}:{{ f.remotePort }}</code>
          </td>
          <td>
            <span class="badge" :class="forwardBadgeClass(f.state)">{{
              f.state
            }}</span>
          </td>
          <td class="text-end">
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              :disabled="f.state === 'starting'"
              @click="openInBrowser(f)"
            >
              <span class="visually-hidden">Open in browser</span>
              <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="btn btn-sm btn-outline-danger ms-1"
              :disabled="f.state === 'starting'"
              @click="stopForward(f)"
            >
              <span class="visually-hidden">Stop port forward</span>
              <i class="bi bi-stop-circle" aria-hidden="true"></i>
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
