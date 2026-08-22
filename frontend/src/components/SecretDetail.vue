<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { copyToClipboard } from "../clipboard.js";
import InlineButton from "./InlineButton.vue";
import {
  newRow,
  seedRows,
  validateRows,
  buildChanges,
  summarizeChanges,
} from "../useSecretDraft.js";
import SecretKeyRows from "./SecretKeyRows.vue";

/*
 * Detail panel for one open secret: three submodes (View / Edit / YAML).
 *
 *   View  — table of key/value pairs, masked by default, per-row reveal/copy
 *           plus a reveal-all toggle. Shows decoded text in transparent mode
 *           and raw base64 in base64 mode.
 *   Edit  — row editor on a draft; changes are reviewed in a confirm dialog
 *           before they touch the cluster (same APG alertdialog as before).
 *   YAML  — raw manifest editing. Transparent mode renders stringData (plain
 *           text); base64 mode renders the true data: manifest. Apply is a
 *           full replace behind the native confirmation.
 *
 * The panel lives inline in the tab's right column (like the old detail
 * pane), so it never steals focus on its own; it moves focus to its heading
 * when it mounts and hands focus back through the parent on close.
 */

const props = defineProps({
  namespace: { type: String, required: true },
  name: { type: String, required: true },
  // "transparent" | "base64" — how values are represented in this session.
  mode: { type: String, default: "transparent" },
});
const emit = defineEmits(["close", "updated", "deleted"]);
const { announce } = useStore();

const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref("");

// Which editor the panel is showing.
const submode = ref("view"); // "view" | "edit" | "yaml"

const headingEl = ref(null);

const submodeTabEls = {};

function setSubmodeTab(m, el) {
  if (el) submodeTabEls[m] = el;
  else delete submodeTabEls[m];
}

const revealed = ref({}); // entry.key -> bool

function displayValue(entry) {
  return props.mode === "base64" ? entry.base64 : entry.value;
}

// Binary values have no readable text in transparent mode, so there is
// nothing to reveal or copy; in base64 mode they are ordinary strings.
function isRevealable(entry) {
  return !entry.isBinary || props.mode === "base64";
}

const allRevealed = computed(() => {
  const entries = detail.value?.entries || [];
  return entries.length > 0 && entries.every((e) => revealed.value[e.key]);
});

function toggleReveal(key) {
  revealed.value = { ...revealed.value, [key]: !revealed.value[key] };
}

function toggleRevealAll() {
  const entries = detail.value?.entries || [];
  const next = allRevealed.value
    ? {}
    : Object.fromEntries(entries.map((e) => [e.key, true]));
  revealed.value = next;
  announce(allRevealed.value ? "All values hidden." : "All values revealed.");
}

// ── edit mode ──────────────────────────────────────────────────────────────
const draft = ref([]);
const saving = ref(false);
const confirming = ref(false);
const editError = ref("");
const changeSummary = ref({ added: 0, changed: 0, deleted: 0, list: [] });
const confirmHeading = ref(null);
const reviewBtn = ref(null);
const keyRows = ref(null);

function enterEdit() {
  if (!detail.value) return;
  draft.value = seedRows(detail.value.entries, props.mode);
  editError.value = "";
  confirming.value = false;
  submode.value = "edit";
  announce(`Editing secret ${props.name}.`);
}

function cancelEdit() {
  confirming.value = false;
  submode.value = "view";
}

function addKey() {
  const row = newRow({ isNew: true });
  draft.value.push(row);
  nextTick(() => keyRows.value?.focusKey(row.id));
}

function toggleDelete(row) {
  row.deleted = !row.deleted;
}

function reviewChanges() {
  editError.value = "";
  const err = validateRows(draft.value, props.mode);
  if (err) {
    editError.value = err;
    announce(err, "assertive");
    return;
  }
  const changes = buildChanges(draft.value, detail.value.entries, props.mode);
  if (changes.length === 0) {
    editError.value = "No changes to save.";
    announce(editError.value);
    return;
  }
  changeSummary.value = summarizeChanges(changes, detail.value.entries);
  confirming.value = true;
  // Move focus into the review dialog so a screen-reader user hears the
  // summary and can act on it (APG alertdialog pattern).
  nextTick(() => confirmHeading.value?.focus());
  announce(
    `Review changes: ${changeSummary.value.added} added, ${changeSummary.value.changed} changed, ${changeSummary.value.deleted} deleted.`,
  );
}

// Close the review dialog and return focus to the review trigger. Escape and
// the Back button both land here, so the keyboard path never loses focus.
function closeConfirm() {
  confirming.value = false;
  nextTick(() => reviewBtn.value?.focus());
}

async function saveChanges() {
  saving.value = true;
  editError.value = "";
  try {
    const changes = buildChanges(draft.value, detail.value.entries, props.mode);
    const updated = await api.updateSecret(
      props.namespace,
      props.name,
      changes,
      props.mode,
    );
    detail.value = updated;
    revealed.value = {};
    confirming.value = false;
    submode.value = "view";
    announce(`Secret ${props.name} saved.`);
    emit("updated");
    nextTick(() => headingEl.value?.focus());
  } catch (e) {
    editError.value = String(e);
    announce(`Failed to save secret: ${editError.value}`, "assertive");
  } finally {
    saving.value = false;
  }
}

// ── YAML mode ──────────────────────────────────────────────────────────────
const yamlText = ref("");
const yamlLoading = ref(false);
const yamlSaving = ref(false);
const yamlError = ref("");

async function loadYaml() {
  yamlLoading.value = true;
  yamlError.value = "";
  try {
    // Transparent mode renders plain-text stringData; base64 mode renders the
    // true stored manifest.
    yamlText.value = await api.getSecretYaml(
      props.namespace,
      props.name,
      props.mode !== "base64",
    );
  } catch (e) {
    yamlError.value = String(e);
    announce(`Failed to load secret YAML: ${yamlError.value}`, "assertive");
  } finally {
    yamlLoading.value = false;
  }
}

function enterYaml() {
  submode.value = "yaml";
  yamlError.value = "";
  if (yamlText.value === "" && !yamlLoading.value) loadYaml();
}

async function applyYaml() {
  if (!yamlText.value.trim()) {
    yamlError.value = "The manifest is empty.";
    announce(yamlError.value, "assertive");
    return;
  }
  yamlSaving.value = true;
  yamlError.value = "";
  try {
    const applied = await api.updateSecretFromYaml(
      props.namespace,
      props.name,
      yamlText.value,
    );
    if (!applied) return; // user cancelled the confirmation — keep editing
    announce(`Secret ${props.name} replaced from YAML.`);
    await loadDetail(true); // silent: refresh data + yaml in one go
    emit("updated");
  } catch (e) {
    yamlError.value = String(e);
    announce(`Failed to apply YAML: ${yamlError.value}`, "assertive");
  } finally {
    yamlSaving.value = false;
  }
}

// ── shared ─────────────────────────────────────────────────────────────────
async function loadDetail(silent) {
  if (!silent) detailLoading.value = true;
  detailError.value = "";
  try {
    detail.value = await api.getSecret(props.namespace, props.name);
    revealed.value = {};
    if (!silent) {
      announce(
        `Secret ${props.name} opened with ${detail.value.entries.length} keys.`,
      );
    }
  } catch (e) {
    detailError.value = String(e);
    announce(`Failed to open secret: ${detailError.value}`, "assertive");
  } finally {
    if (!silent) detailLoading.value = false;
  }
}

async function deleteSecret() {
  try {
    const deleted = await api.deleteSecret(props.namespace, props.name);
    if (!deleted) return; // user cancelled the native prompt
    announce(`Secret ${props.name} deleted.`);
    emit("deleted");
  } catch (e) {
    detailError.value = String(e);
    announce(`Failed to delete secret: ${detailError.value}`, "assertive");
  }
}

// The panel is opened for one secret at a time (parent keys it by name), so
// focus lands on its heading when it mounts.
watch(
  () => props.name,
  async () => {
    await loadDetail();
    nextTick(() => headingEl.value?.focus());
  },
  { immediate: true },
);

// The value mode is global to the tab; when it changes while this panel is
// open, the open editor must re-read the data through the new lens.
watch(
  () => props.mode,
  () => {
    if (submode.value === "edit" && detail.value) {
      draft.value = seedRows(detail.value.entries, props.mode);
    } else if (submode.value === "yaml" && yamlText.value !== "") {
      loadYaml();
    }
  },
);

// APG tabs for the View/Edit/YAML submodes: arrows move, focus follows.
const SUBMODES = ["view", "edit", "yaml"];
function onSubmodeKeydown(e) {
  const i = SUBMODES.indexOf(submode.value);
  let next = null;
  switch (e.key) {
    case "ArrowRight":
      next = SUBMODES[(i + 1) % SUBMODES.length];
      break;
    case "ArrowLeft":
      next = SUBMODES[(i - 1 + SUBMODES.length) % SUBMODES.length];
      break;
    case "Home":
      next = SUBMODES[0];
      break;
    case "End":
      next = SUBMODES[SUBMODES.length - 1];
      break;
    default:
      return;
  }
  e.preventDefault();
  selectSubmode(next);
}

function selectSubmode(m) {
  if (m === "edit") enterEdit();
  else if (m === "yaml") enterYaml();
  else submode.value = "view";
  // APG tabs: activating a tab keeps focus on it so arrow keys keep working.
  nextTick(() => submodeTabEls[m]?.focus());
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (confirming.value) {
    closeConfirm();
  } else if (submode.value === "edit") {
    cancelEdit();
  } else if (submode.value === "yaml") {
    submode.value = "view";
    nextTick(() => headingEl.value?.focus());
  } else {
    emit("close");
  }
}
</script>

<template>
  <section aria-labelledby="secret-detail-heading" @keydown="onKeydown">
    <div v-if="detailLoading" role="status" class="text-muted small">
      Loading…
    </div>

    <div v-else-if="detailError" class="text-danger small" role="alert">
      {{ detailError }}
    </div>

    <template v-else-if="detail">
      <div class="d-flex align-items-start justify-content-between gap-2 mb-2">
        <div>
          <h3
            id="secret-detail-heading"
            ref="headingEl"
            class="h5 mb-0"
            tabindex="-1"
          >
            Secret: {{ detail.name }}
          </h3>
          <p class="small text-body-secondary mb-0">{{ detail.type }}</p>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-outline-danger"
          @click="deleteSecret"
        >
          Delete secret
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Secret editor"
        class="nav nav-tabs mb-2"
        @keydown="onSubmodeKeydown"
      >
        <button
          v-for="m in SUBMODES"
          :id="`secret-submode-${m}`"
          :ref="(el) => setSubmodeTab(m, el)"
          :key="m"
          type="button"
          role="tab"
          class="nav-link text-capitalize"
          :class="{ active: submode === m }"
          :tabindex="submode === m ? 0 : -1"
          :aria-selected="submode === m"
          :aria-controls="`secret-submode-panel-${m}`"
          @click="selectSubmode(m)"
        >
          {{ m === "yaml" ? "YAML" : m }}
        </button>
      </div>

      <!-- ── VIEW ─────────────────────────────────────────────────────── -->
      <div
        v-show="submode === 'view'"
        id="secret-submode-panel-view"
        role="tabpanel"
        aria-labelledby="secret-submode-view"
      >
        <div class="d-flex justify-content-between align-items-center mb-2">
          <span class="small text-body-secondary">
            {{ detail.entries.length }} key{{
              detail.entries.length === 1 ? "" : "s"
            }}
          </span>
          <button
            v-if="detail.entries.length"
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :aria-pressed="allRevealed"
            @click="toggleRevealAll"
          >
            {{ allRevealed ? "Hide all" : "Reveal all" }}
          </button>
        </div>

        <table class="table table-sm align-middle" aria-label="Secret values">
          <caption class="visually-hidden">
            Secret values for
            {{
              detail.name
            }}. Values are hidden by default.
          </caption>
          <thead>
            <tr>
              <th scope="col" class="w-25">Key</th>
              <th scope="col">Value</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in detail.entries" :key="entry.key">
              <th scope="row" class="font-monospace fw-normal">
                {{ entry.key }}
              </th>
              <td>
                <code
                  v-if="revealed[entry.key]"
                  class="d-block"
                  style="white-space: pre-wrap; overflow-wrap: anywhere"
                  >{{ displayValue(entry) }}</code
                >
                <template v-else>
                  <!-- Visual mask is aria-hidden; a sighted user sees the
                       bullets, a screen reader hears that a value exists. -->
                  <span class="text-body-secondary" aria-hidden="true"
                    >••••••••</span
                  >
                  <span class="visually-hidden">hidden value</span>
                </template>
                <span
                  v-if="entry.isBinary && mode !== 'base64'"
                  class="small text-body-secondary ms-1"
                  >(binary)</span
                >
              </td>
              <td class="text-end">
                <span v-if="isRevealable(entry)" class="btn-group btn-group-sm">
                  <button
                    type="button"
                    class="btn btn-outline-secondary"
                    :aria-pressed="!!revealed[entry.key]"
                    @click="toggleReveal(entry.key)"
                  >
                    {{ revealed[entry.key] ? "Hide" : "Reveal" }}
                  </button>
                </span>
                <InlineButton
                  v-if="isRevealable(entry)"
                  variant="inline"
                  :copy-text="displayValue(entry)"
                  announce="Value"
                  :title="`Copy ${entry.key}`"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ── EDIT ─────────────────────────────────────────────────────── -->
      <div
        v-show="submode === 'edit'"
        id="secret-submode-panel-edit"
        role="tabpanel"
        aria-labelledby="secret-submode-edit"
      >
        <div class="d-flex align-items-center justify-content-between mb-2">
          <h4 id="secret-edit-heading" class="h6 mb-0" tabindex="-1">
            Editing {{ detail.name }}
          </h4>
          <span class="badge text-bg-warning">unsaved</span>
        </div>

        <p v-if="editError" class="text-danger small" role="alert">
          {{ editError }}
        </p>

        <SecretKeyRows
          ref="keyRows"
          :rows="draft"
          :mode="mode"
          :readonly-keys="true"
          @add="addKey"
          @toggle-delete="toggleDelete"
        />

        <!-- Confirmation step -->
        <div
          v-if="confirming"
          class="alert alert-warning mt-3"
          role="alertdialog"
          aria-labelledby="secret-confirm-heading"
          @keydown.esc.prevent.stop="closeConfirm"
        >
          <h4
            id="secret-confirm-heading"
            ref="confirmHeading"
            class="h6"
            tabindex="-1"
          >
            Confirm changes
          </h4>
          <p class="small mb-2">
            {{ changeSummary.added }} added,
            {{ changeSummary.changed }} changed,
            {{ changeSummary.deleted }} deleted.
          </p>
          <ul class="small mb-2">
            <li v-for="c in changeSummary.list" :key="c.kind + c.key">
              <strong>{{ c.kind }}</strong
              >: {{ c.key }}
            </li>
          </ul>
          <div class="d-flex gap-2">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="saving"
              @click="saveChanges"
            >
              <span
                v-if="saving"
                class="spinner-border spinner-border-sm me-1"
                aria-hidden="true"
              ></span>
              Apply to cluster
            </button>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              :disabled="saving"
              @click="closeConfirm"
            >
              Back
            </button>
          </div>
        </div>

        <div v-else class="d-flex gap-2 mt-3">
          <button
            ref="reviewBtn"
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="saving"
            @click="reviewChanges"
          >
            Review &amp; save
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            @click="cancelEdit"
          >
            Cancel
          </button>
        </div>
      </div>

      <!-- ── YAML ─────────────────────────────────────────────────────── -->
      <div
        v-show="submode === 'yaml'"
        id="secret-submode-panel-yaml"
        role="tabpanel"
        aria-labelledby="secret-submode-yaml"
      >
        <div class="d-flex align-items-center justify-content-between mb-2">
          <h4 id="secret-yaml-heading" class="h6 mb-0" tabindex="-1">YAML</h4>
        </div>
        <p class="small text-body-secondary">
          {{
            mode === "base64"
              ? "Raw manifest — values are base64. Applying replaces the whole secret."
              : "Manifest with plain-text values (stringData). Applying replaces the whole secret."
          }}
        </p>
        <p v-if="yamlError" class="text-danger small" role="alert">
          {{ yamlError }}
        </p>
        <p v-if="yamlLoading" class="text-muted small" role="status">
          Loading…
        </p>
        <textarea
          v-else
          v-model="yamlText"
          class="form-control font-monospace"
          rows="18"
          spellcheck="false"
          aria-label="Secret YAML manifest"
        ></textarea>
        <div class="d-flex gap-2 mt-2">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :disabled="yamlSaving || yamlLoading"
            @click="copyToClipboard(yamlText, 'YAML')"
          >
            Copy YAML
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :disabled="yamlSaving || yamlLoading"
            @click="loadYaml"
          >
            Reload
          </button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="yamlSaving || yamlLoading"
            @click="applyYaml"
          >
            <span
              v-if="yamlSaving"
              class="spinner-border spinner-border-sm me-1"
              aria-hidden="true"
            ></span>
            Apply
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
