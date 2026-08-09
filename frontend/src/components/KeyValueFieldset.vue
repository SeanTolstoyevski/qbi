<script setup>
import { addRow, removeRow } from "../keyValueRows.js";

defineProps({
  rows: { type: Array, required: true },
  legend: { type: String, required: true },
  idPrefix: { type: String, required: true },
  keyPlaceholder: { type: String, default: "key" },
  valuePlaceholder: { type: String, default: "value" },
  addLabel: { type: String, default: "Add" },
  removeLabel: { type: String, default: "Remove" },
  keyLabel: { type: String, default: "Key" },
  valLabel: { type: String, default: "Value" },
});
</script>

<template>
  <fieldset>
    <legend class="h6 small text-body-secondary">{{ legend }}</legend>
    <div v-for="(row, i) in rows" :key="i" class="row g-2 mb-1">
      <div class="col-5">
        <label class="visually-hidden" :for="`${idPrefix}-key-${i}`">{{
          keyLabel
        }}</label>
        <input
          :id="`${idPrefix}-key-${i}`"
          v-model="row.key"
          type="text"
          class="form-control form-control-sm"
          :placeholder="keyPlaceholder"
          autocomplete="off"
        />
      </div>
      <div class="col-5">
        <label class="visually-hidden" :for="`${idPrefix}-val-${i}`">{{
          valLabel
        }}</label>
        <input
          :id="`${idPrefix}-val-${i}`"
          v-model="row.value"
          type="text"
          class="form-control form-control-sm"
          :placeholder="valuePlaceholder"
          autocomplete="off"
        />
      </div>
      <div class="col-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :aria-label="`Remove ${removeLabel} ${i + 1}`"
          @click="removeRow(rows, i)"
        >
          Remove
        </button>
      </div>
    </div>
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary"
      @click="addRow(rows)"
    >
      {{ addLabel }}
    </button>
  </fieldset>
</template>
