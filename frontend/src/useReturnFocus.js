import { onMounted, onBeforeUnmount, nextTick } from "vue";

/*
 * Generic focus management for triggered overlays — any panel/screen that is
 * opened from a button and takes over focus (pod detail, logs, and future
 * screens). It gives every such screen the same accessible behaviour:
 *
 *   - Remembers the element that had focus when the screen opened (the button
 *     that triggered it) and returns focus there when the screen closes, so a
 *     keyboard/screen-reader user never loses their place.
 *   - Moves focus into the screen on open (to `focusTarget`, usually its
 *     heading) so the reader lands on the new content.
 *   - Wires Escape to close the screen.
 *
 * The opener is captured in onMounted. Pass `opener` (the trigger element)
 * when the trigger is not guaranteed to be document.activeElement at mount
 * panel's focus-return runs after the new trigger was pre-focused but before
 * time — in particular when panels swap in the same render pass: the outgoing
 * the new panel mounts, so capturing at mount would record the *previous*
 * panel's button. With an explicit element the capture is deterministic
 * regardless of flush ordering. Parents keep trigger elements in template
 * refs and hand them down as props.
 *
 * Usage inside a `<script setup>` overlay component:
 *
 *   const headingEl = ref(null);
 *   const { onKeydown } = useReturnFocus({
 *     focusTarget: headingEl,
 *     opener: props.opener,
 *     onClose: () => emit("close"),
 *   });
 *   // in the template, bind @keydown="onKeydown" on the root element and put
 *   // ref="headingEl" tabindex="-1" on the heading.
 *
 * The trigger element must still be connected when the screen closes (it
 * normally does — the list that spawned the screen stays mounted).
 */
export function useReturnFocus({ focusTarget, onClose, opener } = {}) {
  let openerEl = null;

  onMounted(() => {
    const o = opener?.value instanceof HTMLElement ? opener.value : opener;
    openerEl = o instanceof HTMLElement ? o : null;
    nextTick(() => focusTarget?.value?.focus?.());
  });

  // focusIfPossible focuses el and reports whether focus actually landed. A
  // disabled or removed element makes focus() a silent no-op, which would
  // strand the user on <body>.
  function focusIfPossible(el) {
    if (!el?.isConnected || el.disabled) return false;
    el.focus();
    return el.matches(":focus");
  }

  onBeforeUnmount(() => {
    const target = openerEl;
    if (target && !focusIfPossible(target)) {
      nextTick(() => focusIfPossible(target));
    }
    openerEl = null;
  });

  function onKeydown(e) {
    if (e.key === "Escape" && onClose) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return { onKeydown };
}
