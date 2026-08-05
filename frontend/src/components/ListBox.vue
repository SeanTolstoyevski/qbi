<script setup>
/*
 * An accessible single-select listbox implementing the WAI-ARIA listbox
 * pattern with roving tabindex.
 *
 * Keyboard support once focus is inside the list:
 *   ArrowUp / ArrowDown  move focus between options
 *   Home / End           jump to first / last option
 *   Enter / Space        select the focused option
 *   printable characters  type-ahead: jump to the next option whose label
 *                         starts with the typed string
 *
 * Selection does NOT follow focus, because selecting a namespace triggers a
 * network load; users move with arrows and confirm with Enter/Space/click.
 */
import { ref, watch, nextTick, useId } from "vue";

const props = defineProps({
  // Each option: { value: string, label: string, description?: string }
  options: { type: Array, required: true },
  modelValue: { type: [String, null], default: null },
  ariaLabel: { type: String, required: true },
  // id of an element describing how to navigate the list (help text), wired
  // via aria-describedby so screen readers announce it on focus.
  describedBy: { type: String, default: "" },
  // When true, items advertise a context menu and emit context-action on
  // right-click / application key (both normalised to the contextmenu event).
  hasContextMenu: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue", "select", "context-action"]);

const uid = useId();
const listRef = ref(null);
// The roving-focus index. Distinct from the selected value: you can move focus
// to explore options without changing the current selection.
const activeIndex = ref(0);

// Keep the focus index aligned with the current selection when it changes.
watch(
  () => props.modelValue,
  (val) => {
    const i = props.options.findIndex((o) => o.value === val);
    if (i >= 0) activeIndex.value = i;
  },
  { immediate: true }
);

// Clamp focus if the option list shrinks (e.g. after filtering).
watch(
  () => props.options.length,
  (len) => {
    if (activeIndex.value > len - 1) activeIndex.value = Math.max(0, len - 1);
  }
);

function optionDomId(i) {
  return `${uid}-opt-${i}`;
}

function focusOption(i) {
  nextTick(() => {
    listRef.value
      ?.querySelector(`[data-index="${i}"]`)
      ?.focus();
  });
}

function move(to) {
  const len = props.options.length;
  if (len === 0) return;
  const i = Math.min(Math.max(to, 0), len - 1);
  activeIndex.value = i;
  focusOption(i);
}

function select(i) {
  const opt = props.options[i];
  if (!opt) return;
  emit("update:modelValue", opt.value);
  emit("select", opt.value);
}

// --- type-ahead ------------------------------------------------------------
let typeBuffer = "";
let typeTimer = null;

function typeahead(char) {
  clearTimeout(typeTimer);
  typeBuffer += char.toLowerCase();
  typeTimer = setTimeout(() => (typeBuffer = ""), 600);

  const len = props.options.length;
  // Search starting just after the current option so repeated presses cycle.
  for (let step = 1; step <= len; step++) {
    const i = (activeIndex.value + step) % len;
    if (props.options[i].label.toLowerCase().startsWith(typeBuffer)) {
      move(i);
      return;
    }
  }
}

function onKeydown(e) {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(activeIndex.value + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(activeIndex.value - 1);
      break;
    case "Home":
      e.preventDefault();
      move(0);
      break;
    case "End":
      e.preventDefault();
      move(props.options.length - 1);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      select(activeIndex.value);
      break;
    default:
      if (e.key.length === 1 && /\S/.test(e.key)) {
        e.preventDefault();
        typeahead(e.key);
      }
  }
}

function onOptionClick(i) {
  activeIndex.value = i;
  select(i);
}

function onContextMenu(e, i) {
  if (!props.hasContextMenu) return;
  e.preventDefault();
  activeIndex.value = i;
  focusOption(i);
  // For keyboard-triggered contextmenu events, clientX/Y may be 0; fall back
  // to the element's bottom-left corner so the menu appears nearby.
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX || rect.left;
  const y = e.clientY || rect.bottom;
  emit("context-action", { value: props.options[i].value, x, y });
}

// ⋮ button click: open context menu anchored below the button itself.
function onMenuBtnClick(e, i) {
  e.stopPropagation();
  activeIndex.value = i;
  focusOption(i);
  const rect = e.currentTarget.getBoundingClientRect();
  emit("context-action", { value: props.options[i].value, x: rect.left, y: rect.bottom });
}

defineExpose({ focusActive: () => focusOption(activeIndex.value) });
</script>

<template>
  <ul
    ref="listRef"
    class="list-group qba-listbox"
    role="listbox"
    :aria-label="ariaLabel"
    :aria-describedby="describedBy || undefined"
    @keydown="onKeydown"
  >
    <li
      v-for="(opt, i) in options"
      :id="optionDomId(i)"
      :key="opt.value"
      :data-index="i"
      class="list-group-item list-group-item-action qba-option-row"
      role="option"
      :aria-selected="modelValue === opt.value"
      :aria-haspopup="hasContextMenu ? 'menu' : undefined"
      :class="{ active: modelValue === opt.value }"
      :tabindex="i === activeIndex ? 0 : -1"
      @click="onOptionClick(i)"
      @contextmenu="onContextMenu($event, i)"
    >
      <div class="qba-option-content">
        <span class="fw-semibold">{{ opt.label }}</span>
        <span v-if="opt.description" class="d-block small text-body-secondary">
          {{ opt.description }}
        </span>
      </div>
      <button
        v-if="hasContextMenu"
        type="button"
        class="qba-option-menu-btn"
        tabindex="-1"
        :aria-label="`Actions for ${opt.label}`"
        @click.stop="onMenuBtnClick($event, i)"
      >
        <span aria-hidden="true">&#8942;</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.qba-listbox {
  overflow-y: auto;
  height: 100%;
}
/* Options are not native buttons, so give the focused option a clear cursor
   and pointer affordance. The global focus-ring rule covers the outline. */
.qba-listbox [role="option"] {
  cursor: pointer;
}

/* Row layout: content fills available space, kebab button stays at the end. */
.qba-option-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.qba-option-content {
  flex: 1;
  min-width: 0;
}

.qba-option-menu-btn {
  flex-shrink: 0;
  padding: 0.125rem 0.375rem;
  background: none;
  border: none;
  border-radius: var(--bs-border-radius, 0.25rem);
  line-height: 1;
  font-size: 1rem;
  /* Subtle by default so it doesn't clutter the list; revealed on interaction. */
  opacity: 0;
  cursor: pointer;
  color: inherit;
  transition: opacity 0.1s;
}

/* Show the button when the row is hovered, when the row has focus, or when
   the button itself is focused (e.g. via a pointer user tabbing into it). */
.qba-option-row:hover .qba-option-menu-btn,
.qba-option-row:focus .qba-option-menu-btn,
.qba-option-menu-btn:focus {
  opacity: 1;
}

.qba-option-menu-btn:focus {
  outline: 2px solid currentColor;
  outline-offset: -1px;
}
</style>
