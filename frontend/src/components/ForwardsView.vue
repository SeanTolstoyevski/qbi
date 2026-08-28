<script setup>
import { useStore } from "../store.js";
import { usePortForwards } from "../usePortForwards.js";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime.js";
import InlineButton from "./InlineButton.vue";
import { forwardBadgeClass } from "../statusClasses.js";

// The top-level "Forwards" section: every running port forward across all
// namespaces, so tunnels can be stopped without navigating to the pod.
const { state } = useStore();
const { forwards, stopForward } = usePortForwards();

function openInBrowser(f) {
  BrowserOpenURL(`http://127.0.0.1:${f.localPort}`);
}
</script>

<template>
  <div>
    <p v-if="!state.experimental" class="text-muted small">
      Port forwarding is an experimental feature. Enable
      <strong>Experimental features</strong> in Settings to forward pod ports
      to this machine.
    </p>
    <p
      v-else-if="!forwards.length"
      class="text-muted small"
      role="status"
    >
      No active port forwards. Open a pod's detail view and use its
      <strong>Port forwarding</strong> section to start one.
    </p>

    <table v-else class="table table-sm">
      <caption class="visually-hidden">
        Active port forwards
      </caption>
      <thead>
        <tr>
          <th scope="col">Local address</th>
          <th scope="col">Target</th>
          <th scope="col">Namespace</th>
          <th scope="col">Status</th>
          <th scope="col">
            <span class="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in forwards" :key="f.id">
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
          <td>{{ f.namespace }}</td>
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
  </div>
</template>
