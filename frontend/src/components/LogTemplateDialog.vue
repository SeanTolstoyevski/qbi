<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { applyLogTemplate, extractJsonFields } from "../logTemplate.js";

/*
 * Log format template manager/editor (experimental).
 *
 * The user creates a template by pasting a JSON log line THEY copied from the
 * log view — there is no "derive from the latest line" shortcut. "Load
 * fields" extracts the top-level field names, which can then be reordered
 * with the per-field Move buttons, pruned with Remove, or extended with Add
 * field. A live preview shows how the pasted sample line will read.
 *
 * Modal semantics: role="dialog" + aria-modal, heading gets focus on open,
 * Escape closes (edit view first falls back to the list), and the shared
 * useReturnFocus puts focus back on the element that opened the dialog.
 */
const emit = defineEmits(["close", "changed"]);
const { announce } = useStore();

const props = defineProps({
  opener: { type: Object, default: null },
});

const headingEl = ref(null);
const nameEl = ref(null);
const dialogEl = ref(null);
const listEl = ref(null);

const fieldRowEls = new Map();

function setFieldRowEl(f, el) {
  if (el) fieldRowEls.set(f, el);
  else fieldRowEls.delete(f);
}

const view = ref("list"); // "list" | "edit"
const loading = ref(true);
const error = ref("");
const saving = ref(false);
const templates = ref([]);
const confirmDeleteId = ref("");

const draftId = ref("");
const draftName = ref("");
const draftFields = ref([]); // ordered field names
const sample = ref(""); // user-pasted JSON log line
const newField = ref("");

const isEditing = computed(() => view.value === "edit");
const sampleInfo = computed(() =>
  sample.value ? extractJsonFields(sample.value) : null,
);
const preview = computed(() => {
  if (!isEditing.value || !sampleInfo.value) return null;
  const r = applyLogTemplate(sample.value, draftFields.value);
  return { text: r.text, reason: r.reason };
});
const draftValid = computed(
  () => draftName.value.trim().length > 0 && draftFields.value.length > 0,
);

useReturnFocus({
  focusTarget: headingEl,
  opener: props.opener,
  onClose: () => emit("close"),
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const s = await api.getLogTemplateSettings();
    templates.value = s.templates ?? [];
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  draftId.value = "";
  draftName.value = "";
  draftFields.value = [];
  sample.value = "";
  newField.value = "";
  error.value = "";
  view.value = "edit";
  nextTick(() => nameEl.value?.focus());
}

function openEdit(t) {
  draftId.value = t.id;
  draftName.value = t.name;
  draftFields.value = [...t.fieldOrder];
  sample.value = "";
  newField.value = "";
  error.value = "";
  view.value = "edit";
  nextTick(() => nameEl.value?.focus());
}

function backToList() {
  confirmDeleteId.value = "";
  view.value = "list";
  error.value = "";
  nextTick(() => headingEl.value?.focus());
}

function loadFieldsFromSample() {
  const info = sampleInfo.value;
  if (!info) {
    error.value = "No JSON object found in the pasted line.";
    announce(error.value, "assertive");
    return;
  }
  draftFields.value = info.keys;
  error.value = "";
  announce(`Loaded ${info.keys.length} fields from the sample.`);
}

function moveField(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= draftFields.value.length) return;
  const f = draftFields.value[i];
  const arr = draftFields.value;
  [arr[i], arr[j]] = [arr[j], arr[i]];

  nextTick(() => {
    const row = fieldRowEls.get(f);
    if (!row) return;
    const active = document.activeElement;
    if (active && !active.disabled && row.contains(active)) return;
    (
      row.querySelector('[aria-label^="Move"]:not([disabled])') ||
      row.querySelector('[aria-label^="Remove"]:not([disabled])')
    )?.focus();
  });
}

function removeField(i) {
  draftFields.value.splice(i, 1);
}

function addField() {
  const f = newField.value.trim();
  newField.value = "";
  if (!f) return;
  if (!draftFields.value.includes(f)) draftFields.value.push(f);
}

async function save() {
  if (!draftValid.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const saved = await api.saveLogTemplate({
      id: draftId.value || "",
      name: draftName.value.trim(),
      fieldOrder: draftFields.value,
    });
    announce(`Template ${saved.name} saved.`);
    emit("changed");
    await load();
    backToList();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to save template: ${error.value}`, "assertive");
  } finally {
    saving.value = false;
  }
}

function focusDeleteButton(id) {
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  nextTick(() => {
    listEl.value?.querySelector(`[data-template-delete="${esc}"]`)?.focus();
  });
}

function cancelDelete(id) {
  confirmDeleteId.value = "";
  focusDeleteButton(id);
}

async function deleteTemplate(t) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api.deleteLogTemplate(t.id);
    announce(`Template ${t.name} deleted.`);
    confirmDeleteId.value = "";
    emit("changed");
    await load();
    nextTick(() => headingEl.value?.focus());
  } catch (e) {
    error.value = String(e);
    announce(`Failed to delete template: ${error.value}`, "assertive");
    confirmDeleteId.value = "";
    focusDeleteButton(t.id);
  } finally {
    saving.value = false;
  }
}

function trapTab(e) {
  const dialog = dialogEl.value;
  if (!dialog) return;
  const focusables = [
    ...dialog.querySelectorAll(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.disabled && el.tabIndex >= 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const listed = dialog.contains(active) && focusables.includes(active);
  if (!listed) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (confirmDeleteId.value) {
      cancelDelete(confirmDeleteId.value);
    } else if (view.value === "edit") {
      announce("Template changes discarded.");
      backToList();
    } else {
      emit("close");
    }
    return;
  }
  if (e.key === "Tab") {
    trapTab(e);
    return;
  }
  e.stopPropagation();
}

onMounted(load);
</script>

<template>
  <div class="logtmpl-backdrop">
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="logtmpl-heading"
      aria-describedby="logtmpl-desc"
      class="logtmpl-dialog shadow-lg"
      @keydown="onKeydown"
    >
      <div class="d-flex align-items-start justify-content-between gap-2">
        <p id="logtmpl-desc" class="text-body-secondary small mb-0 mt-1">
          Reorder the fields of JSON log lines so the message is read first.
          Templates change the log display only — copied and saved logs stay
          untouched.
        </p>
        <button
          type="button"
          class="btn-close"
          aria-label="Close log templates"
          @click="emit('close')"
        ></button>
      </div>

      <h2
        id="logtmpl-heading"
        ref="headingEl"
        class="h3 mt-3 mb-2"
        tabindex="-1"
      >
        Log templates
      </h2>

      <div v-if="error" class="alert alert-danger" role="alert">
        {{ error }}
      </div>

      <template v-if="view === 'list'">
        <p v-if="loading" class="text-body-secondary">Loading…</p>
        <p v-else-if="templates.length === 0" class="mb-3">
          No templates yet. Create one from a JSON log line copied out of the
          log view.
        </p>
        <ul ref="listEl" v-else class="list-group mb-3">
          <li
            v-for="t in templates"
            :key="t.id"
            class="list-group-item d-flex flex-wrap align-items-center gap-2"
          >
            <div class="flex-grow-1 min-w-0">
              <span class="fw-semibold">{{ t.name }}</span>
              <span class="d-block small text-body-secondary text-truncate">
                {{ t.fieldOrder.length }} fields ·
                {{
                  t.fieldOrder.slice(0, 8).join(", ") +
                  (t.fieldOrder.length > 8 ? ", …" : "")
                }}
              </span>
            </div>
            <template v-if="confirmDeleteId === t.id">
              <span class="small">Delete “{{ t.name }}”?</span>
              <button
                type="button"
                class="btn btn-sm btn-danger"
                :disabled="saving"
                @click="deleteTemplate(t)"
              >
                Yes, delete
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                @click="cancelDelete(t.id)"
              >
                No
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                @click="openEdit(t)"
              >
                Edit
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-danger"
                :data-template-delete="t.id"
                @click="confirmDeleteId = t.id"
              >
                Delete
              </button>
            </template>
          </li>
        </ul>
        <div>
          <button type="button" class="btn btn-primary" @click="openCreate">
            <i class="bi bi-plus-lg me-1" aria-hidden="true"></i>New template
          </button>
          <button
            type="button"
            class="btn btn-outline-secondary ms-2"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </template>

      <template v-else>
        <div class="mb-3">
          <label for="logtmpl-name" class="form-label">Name</label>
          <input
            id="logtmpl-name"
            ref="nameEl"
            v-model="draftName"
            type="text"
            class="form-control"
            maxlength="64"
            placeholder="e.g. App JSON logs"
          />
        </div>

        <div class="mb-3">
          <label for="logtmpl-sample" class="form-label">Sample log line</label>
          <textarea
            id="logtmpl-sample"
            v-model="sample"
            class="form-control font-monospace"
            rows="4"
            placeholder='{"ts":1690000000,"level":"info","msg":"started"}'
          ></textarea>
          <p class="form-text mb-1">
            Paste one JSON log line you copied from the log view, then press
            Load fields.
          </p>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="loadFieldsFromSample"
          >
            Load fields
          </button>
        </div>

        <div v-if="draftFields.length" class="mb-3">
          <p class="form-label mb-1">Reading order</p>
          <ul class="list-group">
            <li
              v-for="(f, i) in draftFields"
              :key="f"
              :ref="(el) => setFieldRowEl(f, el)"
              class="list-group-item d-flex align-items-center gap-1"
            >
              <code class="flex-grow-1 text-break">{{ f }}</code>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :disabled="i === 0"
                :aria-label="`Move ${f} up`"
                @click="moveField(i, -1)"
              >
                <i class="bi bi-arrow-up" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :disabled="i === draftFields.length - 1"
                :aria-label="`Move ${f} down`"
                @click="moveField(i, 1)"
              >
                <i class="bi bi-arrow-down" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-danger"
                :aria-label="`Remove ${f} from the template`"
                @click="removeField(i)"
              >
                <i class="bi bi-x-lg" aria-hidden="true"></i>
              </button>
            </li>
          </ul>
          <p class="form-text mt-1">
            Fields not listed keep their original order at the end.
          </p>
        </div>

        <div class="mb-3 d-flex gap-2">
          <label for="logtmpl-newfield" class="visually-hidden"
            >Field name to add</label
          >
          <input
            id="logtmpl-newfield"
            v-model="newField"
            type="text"
            class="form-control form-control-sm"
            placeholder="Add a field not in the sample…"
            @keydown.enter.prevent="addField"
          />
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="addField"
          >
            Add field
          </button>
        </div>

        <div v-if="preview" class="mb-3">
          <p class="form-label mb-1">Preview</p>
          <pre class="logtmpl-preview">{{ preview.text }}</pre>
          <p v-if="preview.reason === 'no-overlap'" class="form-text mb-0">
            None of the template's fields appear in this sample, so the line
            stays unchanged.
          </p>
        </div>

        <div class="d-flex justify-content-end gap-2">
          <button
            type="button"
            class="btn btn-outline-secondary"
            @click="backToList"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!draftValid || saving"
            @click="save"
          >
            Save template
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.logtmpl-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2rem 1rem;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.45);
}
.logtmpl-dialog {
  width: 100%;
  max-width: 40rem;
  padding: 1.25rem 1.5rem 1.5rem;
  background: var(--bs-body-bg);
  color: var(--bs-body-color);
  border-radius: var(--bs-border-radius-lg);
}
.logtmpl-preview {
  margin: 0;
  padding: 0.5rem 0.75rem;
  max-height: 10rem;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 0.875rem;
  background: var(--bs-tertiary-bg);
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
}
</style>
