/*
 * Generic action-menu composable — keyboard navigation, focus management, and
 * click-outside dismissal for the dropdown action menus used across resource
 * list views (PodList, WorkloadsView, NetworkingView).
 *
 * The menu convention:
 *   - Trigger button:  id="actions-btn-<key>"
 *   - Menu container:  data-menu="<key>"
 *   - Menu items:      [role="menuitem"]
 *
 * Usage (inside <script setup>):
 *
 *   const { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
 *     useActionMenu();
 *
 *   // In template:
 *   // <button :id="`actions-btn-${key}`" @click="openMenu(key)">…</button>
 *   // <div v-if="menuOpen === key" :data-menu="key" @keydown="onMenuKeydown($event, key)">
 *   //   <button role="menuitem" @click="closeMenu(key); doSomething()">…</button>
 *   // </div>
 *
 * The composable handles its own document-level click-outside listener (mounted
 * capture-phase) and cleans up on unmount, so the consumer's <script setup> block
 * does not need onMounted / onUnmounted boilerplate.
 */

import { ref, onMounted, onUnmounted, nextTick } from "vue";

export function useActionMenu(externalRef) {
  const menuOpen = externalRef || ref(""); // key of the currently open action menu

  function openMenu(key) {
    menuOpen.value = key;
    nextTick(() =>
      document
        .querySelector(`[data-menu="${key}"] [role="menuitem"]:not(:disabled)`)
        ?.focus(),
    );
  }

  /**
   * closeMenu closes the menu for `key`. By default it returns focus to the
   * trigger button. Pass `{ skipFocus: true }` when the triggered action
   * itself manages focus (e.g. a panel that uses useReturnFocus).
   */
  function closeMenu(key, { skipFocus = false } = {}) {
    menuOpen.value = "";
    if (!skipFocus) {
      nextTick(() => document.getElementById(`actions-btn-${key}`)?.focus());
    }
  }

  /**
   * focusTriggerAndAct closes the menu, synchronously focuses the trigger
   * button, and then executes `fn` on nextTick. This is essential when `fn`
   * opens a panel that uses useReturnFocus (which captures activeElement in
   * onMounted): the trigger must be focused *before* the panel mounts.
   */
  function focusTriggerAndAct(key, fn) {
    menuOpen.value = "";
    const btn = document.getElementById(`actions-btn-${key}`);
    btn?.focus();
    nextTick(fn);
  }

  /**
   * onMenuKeydown implements WAI-ARIA menu keyboard navigation:
   * Arrow keys cycle through items, Home/End jump to ends, Escape closes,
   * Tab closes without returning focus.
   */
  function onMenuKeydown(e, key) {
    const menu = document.querySelector(`[data-menu="${key}"]`);
    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    const idx = items.indexOf(document.activeElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closeMenu(key);
        break;
      case "ArrowDown":
        e.preventDefault();
        items[(idx + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Tab":
        menuOpen.value = "";
        break;
    }
  }

  // ── click-outside (managed internally) ──────────────────────────────────

  function onDocClick(e) {
    if (!menuOpen.value) return;
    const menu = document.querySelector(`[data-menu="${menuOpen.value}"]`);
    const btn = document.getElementById(`actions-btn-${menuOpen.value}`);
    if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
      menuOpen.value = "";
    }
  }

  onMounted(() => document.addEventListener("click", onDocClick, true));
  onUnmounted(() => document.removeEventListener("click", onDocClick, true));

  // ── exports ─────────────────────────────────────────────────────────────

  return { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown };
}
