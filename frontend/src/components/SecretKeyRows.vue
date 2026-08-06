<script setup>
/*
 * Shared key/value row editor for the secret form (create and edit).
 *
 * The parent owns the `rows` array (see useSecretDraft.js) and handles
 * add/remove so it can focus the new key input; this component only renders
 * and reports events. Existing keys stay readonly in edit mode (rename = drop
 * the key and add it again, or edit the YAML) because renaming in place makes
 * the change diff ambiguous. Binary rows are readonly in transparent mode —
 * their bytes cannot be shown as text — but fully editable in base64 mode.
 */
defineProps({
  rows: { type: Array, required: true },
  // "transparent" shows/accepts plain text; "base64" shows/accepts raw base64.
  mode: { type: String, default: "transparent" },
  // When true, keys of existing rows (isNew === false) are readonly.
  readonlyKeys: { type: Boolean, default: false },
});
const emit = defineEmits(["add", "toggle-delete"]);
</script>

<template>
  <div class="d-flex flex-column gap-2">
    <div
      v-for="row in rows"
      :key="row.id"
      class="border rounded p-2"
      :class="{ 'border-danger': row.deleted }"
    >
      <div class="d-flex align-items-center justify-content-between gap-2 mb-1">
        <div class="flex-grow-1">
          <label :for="`secret-key-${row.id}`" class="form-label mb-1 small"
            >Key</label
          >
          <input
            :id="`secret-key-${row.id}`"
            v-model="row.key"
            type="text"
            class="form-control form-control-sm font-monospace"
            :readonly="!row.isNew && readonlyKeys"
            :disabled="row.deleted"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <button
          type="button"
          class="btn btn-sm align-self-end"
          :class="row.deleted ? 'btn-outline-secondary' : 'btn-outline-danger'"
          :aria-pressed="row.deleted"
          :aria-label="
            row.deleted
              ? `Restore key ${row.key || 'new'}`
              : `Remove key ${row.key || 'new'}`
          "
          @click="emit('toggle-delete', row)"
        >
          {{ row.deleted ? "Undo" : "Remove" }}
        </button>
      </div>

      <label :for="`secret-val-${row.id}`" class="form-label mb-1 small"
        >Value</label
      >
      <textarea
        v-if="!row.isBinary || mode === 'base64'"
        :id="`secret-val-${row.id}`"
        v-model="row.value"
        class="form-control form-control-sm font-monospace"
        rows="2"
        :disabled="row.deleted"
        :placeholder="mode === 'base64' ? 'base64 value' : 'plain text value'"
        spellcheck="false"
      ></textarea>
      <p v-else class="small text-body-secondary mb-0">
        {{ row.value }} — binary value, preserved unchanged.
      </p>
    </div>

    <div>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        @click="emit('add')"
      >
        Add key
      </button>
    </div>
  </div>
</template>
