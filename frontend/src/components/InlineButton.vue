<!--
  InlineButton.vue — icon-first inline copy button for dense rows.

  Every table/detail row that offers a copy action shares one look: a bare
  icon that appears only when the row is hovered or the button receives
  keyboard focus, so rows stay visually clean. On keyboard focus the text
  label (default "Copy") is revealed next to the icon — a sighted keyboard
  user always gets an explicit word, never a bare icon.

    - variant="cell"   → absolutely positioned inside a .name-cell, right edge
                         (the pods/nodes name-column look)
    - variant="inline" → flows inline after the cell content (event messages,
                         DNS names, detail entries)

  Copy behaviour lives here too: clicking writes `copyText` and announces it,
  so callers don't re-import clipboard.js. No aria-label is set: the visible
  text (default "Copy") is the accessible name, so a screen reader announces
  "Copy button" without per-row label noise.
-->
<script setup>
import { copyToClipboard } from "../clipboard.js";

const props = defineProps({
  /** Value written to the clipboard on click. */
  copyText: { type: String, default: "" },
  /** Human-readable label for the copy announcement, e.g. "Pod web-abc12". */
  announce: { type: String, default: "Value" },
  /** Optional hover tooltip for sighted users; ignored by screen readers
      once the button has a name from its text. */
  title: { type: String, default: "" },
  /** Text label, revealed on keyboard focus; also the accessible name. */
  text: { type: String, default: "Copy" },
  /** "cell" = anchored in a .name-cell; "inline" = flows with the content. */
  variant: { type: String, default: "cell" },
});
</script>

<template>
  <button
    type="button"
    class="copy-inline"
    :class="variant === 'inline' ? 'copy-inline--inline' : null"
    :title="title || undefined"
    @click="copyToClipboard(copyText, announce)"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span class="inline-button-text">{{ text }}</span>
  </button>
</template>
