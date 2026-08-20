<script setup>
/* 
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
*/

import { copyToClipboard } from "../clipboard.js";

const props = defineProps({
  copyText: { type: String, default: "" },
  announce: { type: String, default: "Value" },
  title: { type: String, default: "" },
  text: { type: String, default: "Copy" },
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
    <i class="bi bi-files" aria-hidden="true"></i>
    <span class="inline-button-text">{{ text }}</span>
  </button>
</template>
