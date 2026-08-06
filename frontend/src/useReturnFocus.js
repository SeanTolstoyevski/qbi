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
 * The opener is captured in onMounted. Pass `openerId` (the id of the trigger
 * button) when the trigger is not guaranteed to be document.activeElement at
 * mount time — in particular when panels swap in the same render pass: the
 * outgoing panel's focus-return runs after the new trigger was pre-focused
 * but before the new panel mounts, so an activeElement-based capture would
 * record the *previous* panel's button. With an explicit id the capture is
 * deterministic regardless of flush ordering.
 *
 * Usage inside a `<script setup>` overlay component:
 *
 *   const headingEl = ref(null);
 *   const { onKeydown } = useReturnFocus({
 *     focusTarget: headingEl,
 *     openerId: props.openerId,
 *     onClose: () => emit("close"),
 *   });
 *   // in the template, bind @keydown="onKeydown" on the root element and put
 *   // ref="headingEl" tabindex="-1" on the heading.
 *
 * The trigger element must still exist in the document when the screen closes
 * (it normally does — the list that spawned the screen stays mounted).
 */
export function useReturnFocus({ focusTarget, onClose, openerId } = {}) {
  let opener = null;

  onMounted(() => {
    const byId = openerId ? document.getElementById(openerId) : null;
    const active = document.activeElement;
    opener =
      byId instanceof HTMLElement
        ? byId
        : active instanceof HTMLElement
          ? active
          : null;
    nextTick(() => focusTarget?.value?.focus?.());
  });

  // focusIfPossible focuses el and reports whether focus actually landed. A
  // disabled or removed element makes focus() a silent no-op, which would
  // strand the user on <body>.
  function focusIfPossible(el) {
    if (!document.contains(el) || el.disabled) return false;
    el.focus();
    return document.activeElement === el;
  }

  onBeforeUnmount(() => {
    const target = opener;
    if (target && !focusIfPossible(target)) {
      // The opener can be disabled or not yet re-enabled at unmount time (a
      // trigger button that is disabled while its panel is open). Retry once
      // the render that closed the panel has settled — by then the button is
      // enabled again and focus() lands. Capture the element: `opener` is
      // cleared right after this hook runs.
      nextTick(() => focusIfPossible(target));
    }
    opener = null;
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
