<script setup>
/*
 * An accessible editable combobox with list autocomplete, following the
 * WAI-ARIA APG "Editable Combobox with List Autocomplete" pattern:
 *
 *   input role="combobox" with aria-expanded / aria-controls /
 *   aria-activedescendant, and a listbox popup of role="option" elements.
 *
 * The input keeps focus at all times; the highlighted option is exposed via
 * aria-activedescendant, so a screen reader announces it on every move
 * without focus ever leaving the field.
 *
 * Keyboard support (while the input is focused):
 *   ArrowDown / ArrowUp  open the list (if closed) or move the highlight
 *   Home / End           jump to the first / last visible option
 *   Enter                pick the highlighted option (when the list is open)
 *   Escape               close the list without picking
 *   typing               filters the options (case-insensitive substring)
 *
 * The input stays free-text: typing anything (including a value that is not
 * in the list) is allowed, matching the native-combobox feel. Escape is
 * stopPropagation'd while the list is open so enclosing screens (which use
 * Escape to close) don't close underneath an open popup.
 */
import { ref, computed, useId } from "vue";

const props = defineProps({
  id: { type: String, default: "" },
  modelValue: { type: String, default: "" },
  options: { type: Array, required: true },
  placeholder: { type: String, default: "" },
  ariaLabel: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "select"]);

const uid = useId();
const listId = `qba-combobox-list-${uid}`;
const wrapper = ref(null);
const open = ref(false);
const activeIndex = ref(-1);

// Case-insensitive substring match: typing "tls" finds "kubernetes.io/tls".
// Single implementation used both for rendering (filtered) and for the live
// open/close decision in onInput (which must filter from the event value,
// since props.modelValue lags one tick behind the input).
function filterOptions(value) {
  const q = value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.toLowerCase().includes(q));
}

const filtered = computed(() => filterOptions(props.modelValue));

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

function pick(i) {
  const opt = filtered.value[i];
  if (opt === undefined) return;
  emit("update:modelValue", opt);
  emit("select", opt);
  closeList();
}

function onInput(e) {
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

function onKeydown(e) {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (open.value) move(activeIndex.value + 1);
      else openList(0);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (open.value) move(activeIndex.value - 1);
      else openList(filtered.value.length - 1);
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
      :value="modelValue"
      type="text"
      role="combobox"
      class="form-control form-control-sm"
      :class="{ 'qba-combobox-open': open }"
      :aria-label="ariaLabel || undefined"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="activeDescendant"
      :placeholder="placeholder"
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
        :key="opt"
        role="option"
        :aria-selected="i === activeIndex"
        class="qba-combobox-option"
        :class="{ active: i === activeIndex }"
        @mousedown="onOptionMouseDown"
        @click="pick(i)"
      >
        {{ opt }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.qba-combobox {
  position: relative;
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
