<script setup>
import { ref, computed, useId, watch } from "vue";

const props = defineProps({
  // id forwarded to the <input>, so an external <label for> can point at it.
  id: { type: String, default: "" },
  modelValue: { type: [String, Number], default: "" },
  options: { type: Array, required: true },
  readonly: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: "" },
  ariaLabel: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "select"]);

const uid = useId();
const listId = `qba-combobox-list-${uid}`;
const wrapper = ref(null);
const open = ref(false);
const activeIndex = ref(-1);

// Normalize string options to { value, label } so all modes rely on one
// shape; plain strings use themselves as both value and label.
const optionList = computed(() =>
  props.options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  ),
);

// Case-insensitive substring match on labels: typing "tls" finds
// "kubernetes.io/tls". Single implementation used both for rendering
// (filtered) and for the live open/close decision in onInput (which must
// filter from the event value, since props.modelValue lags one tick behind
// the input).
function filterOptions(value) {
  const q = value.trim().toLowerCase();
  if (!q) return optionList.value;
  return optionList.value.filter((o) => o.label.toLowerCase().includes(q));
}

// Readonly mode shows all options; editable mode filters by the input text.
const filtered = computed(() =>
  props.readonly ? optionList.value : filterOptions(props.modelValue),
);

// What the input shows: free text in editable mode, the current option's
// label in readonly mode (raw values like "" or 100 would be meaningless).
const displayValue = computed(() => {
  if (!props.readonly) return props.modelValue;
  const i = optionList.value.findIndex((o) => o.value === props.modelValue);
  return i >= 0 ? optionList.value[i].label : "";
});

// Keep the highlight aligned with the current value when it changes.
watch(
  () => props.modelValue,
  (val) => {
    const i = optionList.value.findIndex((o) => o.value === val);
    if (i >= 0) activeIndex.value = i;
  },
  { immediate: true },
);

// A disabled combobox must not keep an open popup.
watch(
  () => props.disabled,
  (d) => {
    if (d) closeList();
  },
);

const activeDescendant = computed(() =>
  open.value && activeIndex.value >= 0
    ? `${listId}-opt-${activeIndex.value}`
    : undefined,
);

function optionId(i) {
  return `${listId}-opt-${i}`;
}

function scrollActiveIntoView() {
  wrapper.value
    ?.querySelector(`#${optionId(activeIndex.value)}`)
    ?.scrollIntoView?.({ block: "nearest" });
}

// Where the highlight starts when the list opens: the current selection in
// readonly mode (native-select feel), the first option otherwise.
function initialIndex() {
  const i = optionList.value.findIndex((o) => o.value === props.modelValue);
  return i >= 0 ? i : 0;
}

function openList(initial) {
  const len = filtered.value.length;
  if (len === 0) return;
  open.value = true;
  activeIndex.value = Math.min(Math.max(initial, 0), len - 1);
  scrollActiveIntoView();
}

function closeList() {
  open.value = false;
  activeIndex.value = -1;
}

function move(to) {
  const len = filtered.value.length;
  if (len === 0) return;
  activeIndex.value = Math.min(Math.max(to, 0), len - 1);
  scrollActiveIntoView();
}

// Emit the option's value as-is (string or number) so numeric selects keep
// their type without relying on v-model.number conversion.
function pick(i) {
  const opt = filtered.value[i];
  if (opt === undefined) return;
  emit("update:modelValue", opt.value);
  emit("select", opt.value);
  closeList();
}

function onInput(e) {
  if (props.readonly) return; // readonly inputs cannot be typed in
  const value = e.target.value;
  emit("update:modelValue", value);

  const matches = filterOptions(value);
  if (matches.length > 0) {
    open.value = true;
    activeIndex.value = 0;
    scrollActiveIntoView();
  } else {
    closeList();
  }
}

let typeBuffer = "";
let typeTimer = null;

function typeahead(char) {
  clearTimeout(typeTimer);
  typeBuffer += char.toLowerCase();
  typeTimer = setTimeout(() => (typeBuffer = ""), 600);

  if (!open.value) openList(initialIndex());
  const len = filtered.value.length;

  for (let step = 1; step <= len; step++) {
    const i = (activeIndex.value + step) % len;
    if (filtered.value[i].label.toLowerCase().startsWith(typeBuffer)) {
      move(i);
      return;
    }
  }
}

function onKeydown(e) {
  if (props.disabled) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (open.value) move(activeIndex.value + 1);
      else openList(props.readonly ? initialIndex() : 0);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (open.value) move(activeIndex.value - 1);
      else
        openList(props.readonly ? initialIndex() : filtered.value.length - 1);
      break;
    case "Home":
      e.preventDefault();
      if (open.value) move(0);
      break;
    case "End":
      e.preventDefault();
      if (open.value) move(filtered.value.length - 1);
      break;
    case "Enter":
      if (open.value && activeIndex.value >= 0) {
        e.preventDefault();
        e.stopPropagation();
        pick(activeIndex.value);
      }
      break;
    case " ":
      if (props.readonly) {
        e.preventDefault();
        e.stopPropagation();
        if (open.value && activeIndex.value >= 0) pick(activeIndex.value);
        else openList(initialIndex());
      }
      break;
    case "Escape":
      if (open.value) {
        e.preventDefault();
        e.stopPropagation();
        closeList();
      }
      break;
    case "Tab":
      closeList();
      break;
    default:
      if (props.readonly && e.key.length === 1 && /\S/.test(e.key)) {
        e.preventDefault();
        typeahead(e.key);
      }
  }
}

// Clicking an option must not steal focus from the input: mousedown.prevent
// keeps the input focused (and the popup open), then click picks the option.
function onOptionMouseDown(e) {
  e.preventDefault();
}

function onBlur() {
  closeList();
}
</script>

<template>
  <div ref="wrapper" class="qba-combobox">
    <input
      :id="id || undefined"
      :value="displayValue"
      type="text"
      role="combobox"
      class="form-control form-control-sm"
      :class="{ 'qba-combobox-open': open, 'qba-combobox-readonly': readonly }"
      :aria-label="ariaLabel || undefined"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="activeDescendant"
      :placeholder="placeholder"
      :readonly="readonly || undefined"
      :disabled="disabled || undefined"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <ul
      v-show="open"
      :id="listId"
      role="listbox"
      class="qba-combobox-list"
      aria-label="Suggested values"
    >
      <li
        v-for="(opt, i) in filtered"
        :id="optionId(i)"
        :key="opt.value"
        :data-value="opt.value"
        role="option"
        :aria-selected="i === activeIndex"
        class="qba-combobox-option"
        :class="{ active: i === activeIndex }"
        @mousedown="onOptionMouseDown"
        @click="pick(i)"
      >
        {{ opt.label }}
      </li>
    </ul>
    <i
      v-if="readonly && !disabled"
      class="bi bi-chevron-down qba-combobox-arrow"
      aria-hidden="true"
    ></i>
  </div>
</template>

<style scoped>
.qba-combobox {
  position: relative;
}

.qba-combobox-readonly {
  padding-right: 2rem; /* room for the chevron */
}

.qba-combobox-arrow {
  position: absolute;
  right: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--bs-secondary-color, #6c757d);
}

.qba-combobox-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 1050;
  margin: 0.125rem 0 0;
  padding: 0.25rem 0;
  max-height: 16rem;
  overflow-y: auto;
  list-style: none;
  background: var(--bs-body-bg, #fff);
  border: 1px solid var(--bs-border-color, #dee2e6);
  border-radius: var(--bs-border-radius, 0.375rem);
  box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.15);
}

.qba-combobox-option {
  padding: 0.25rem 0.75rem;
  cursor: pointer;
  color: var(--bs-body-color, inherit);
}

.qba-combobox-option.active {
  background: var(--bs-primary-bg-subtle, #e7f1ff);
  color: var(--bs-body-color, inherit);
}
</style>
