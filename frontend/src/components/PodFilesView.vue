<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { copyToClipboard } from "../clipboard.js";
import PanelHeader from "./PanelHeader.vue";

const props = defineProps({
  namespace: { type: String, required: true },
  pod: { type: String, required: true },
  container: { type: String, default: "" },
  opener: { type: Object, default: null },
});

const emit = defineEmits(["close"]);
const { announce } = useStore();

const files = ref(null); // PodNetworkFiles
const loading = ref(false);
const error = ref("");
const header = ref(null);

const { onKeydown } = useReturnFocus({
  focusTarget: computed(() => header.value?.headingEl),
  opener: props.opener,
  onClose: () => emit("close"),
});

const sections = computed(() => [
  {
    id: "hosts",
    title: "Host records (/etc/hosts)",
    content: files.value?.hosts || "",
    error: files.value?.hostsError || "",
    copyLabel: `Host records of pod ${props.pod}`,
  },
  {
    id: "resolv",
    title: "DNS config (/etc/resolv.conf)",
    content: files.value?.resolvConf || "",
    error: files.value?.resolvConfError || "",
    copyLabel: `DNS config of pod ${props.pod}`,
  },
]);

async function load() {
  loading.value = true;
  error.value = "";
  files.value = null;
  try {
    files.value = await api.getPodNetworkFiles(
      props.namespace,
      props.pod,
      props.container,
    );
    announce(`Network files for pod ${props.pod} loaded.`);
  } catch (e) {
    error.value = String(e);
    announce(
      `Failed to load network files for ${props.pod}: ${error.value}`,
      "assertive",
    );
  } finally {
    loading.value = false;
  }
}

load();
</script>

<template>
  <section
    aria-labelledby="network-files-heading"
    class="h-100 d-flex flex-column"
    @keydown="onKeydown"
  >
    <PanelHeader
      ref="header"
      heading-id="network-files-heading"
      :title="`Network files: ${pod}`"
      @close="emit('close')"
    >
      <div class="d-flex gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="load"
        >
          <span class="visually-hidden">Refresh network files</span>
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
    </PanelHeader>

    <p v-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <div v-else-if="files" class="flex-grow-1 overflow-auto">
      <section
        v-for="s in sections"
        :key="s.id"
        :aria-labelledby="`nf-${s.id}`"
        class="mb-3"
      >
        <div class="d-flex align-items-center justify-content-between mb-1">
          <h3 :id="`nf-${s.id}`" class="h6 mb-0">{{ s.title }}</h3>
          <button
            v-if="s.content"
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="copyToClipboard(s.content, s.copyLabel)"
          >
            Copy
          </button>
        </div>
        <p v-if="s.error" class="text-danger small" role="alert">
          {{ s.error }}
        </p>
        <p v-else-if="!s.content" class="text-muted small">File is empty.</p>
        <pre
          v-else
          role="document"
          class="border rounded p-2 small font-monospace mb-0"
          style="white-space: pre; tab-size: 2"
          >{{ s.content }}</pre>
      </section>
    </div>
  </section>
</template>
