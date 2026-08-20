/*
 * Generic action-menu composable. Keyboard navigation, focus management, and
 * click-outside dismissal for the dropdown action menus used across resource
 * list views (PodList, WorkloadsView, NetworkingView, NamespaceList).
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
 *
 * Options:
 *   getTrigger(key) - optional. Returns the element focus returns to when the
 *                     menu closes. Defaults to the trigger button
 *                     `#actions-btn-<key>`; views whose "trigger" is a list row
 *                     rather than a dedicated button pass their own lookup.
 */

import { ref, onMounted, onUnmounted, nextTick } from "vue";

export function useActionMenu(externalRef, options = {}) {
  const menuOpen = externalRef || ref(""); // key of the currently open action menu
  const getTrigger =
    options.getTrigger ||
    ((key) => document.getElementById(`actions-btn-${key}`));

  function openMenu(key) {
    menuOpen.value = key;
    nextTick(() => {
      const menu = document.querySelector(`[data-menu="${key}"]`);
      const btn = getTrigger(key);
      if (menu && btn) {
        const r = btn.getBoundingClientRect();
        const vw = window.innerWidth || 800;
        const vh = window.innerHeight || 600;
        const menuHeight = menu.offsetHeight || 0;
        const spaceBelow = vh - r.bottom;
        const top =
          spaceBelow >= menuHeight + 8
            ? r.bottom + 4
            : Math.max(8, r.top - menuHeight - 4);
        const left = Math.min(r.left, Math.max(8, vw - 8 - 220));
        menu.style.position = "fixed";
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.maxHeight = `${Math.max(160, Math.min(320, vh - top - 8))}px`;
        menu.style.overflowY = "auto";
      }
      menu?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    });
  }

  /**
   * closeMenu closes the menu for `key`. By default it returns focus to the
   * trigger button. Pass `{ skipFocus: true }` when the triggered action
   * itself manages focus (e.g. a panel that uses useReturnFocus).
   */
  function closeMenu(key, { skipFocus = false } = {}) {
    menuOpen.value = "";
    if (!skipFocus) {
      nextTick(() => getTrigger(key)?.focus());
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
    const btn = getTrigger(key);
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

  // ── click-outside / scroll / resize (managed internally) ───────────────

  function onDocClick(e) {
    if (!menuOpen.value) return;
    const menu = document.querySelector(`[data-menu="${menuOpen.value}"]`);
    const btn = getTrigger(menuOpen.value);
    if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
      menuOpen.value = "";
    }
  }

  // Right-click fires contextmenu, not click; without this a menu stays open
  // after the user right-clicks somewhere else (until Escape/left-click).
  function onDocContextMenu(e) {
    if (!menuOpen.value) return;
    const menu = document.querySelector(`[data-menu="${menuOpen.value}"]`);
    const btn = getTrigger(menuOpen.value);
    if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
      menuOpen.value = "";
    }
  }

  // A fixed-position menu would drift away from its row once the page moves;
  // closing on any scroll/resize keeps it honest. Scrolling INSIDE the open
  // menu itself (overflow-y: auto, e.g. ArrowDown auto-scrolling a long menu)
  // is interaction, not the page moving — leave it alone. When the focus was
  // inside the closed menu, return it to the trigger so keyboard users never
  // drop to <body>.
  function onDocScroll(e) {
    if (!menuOpen.value) return;
    if (
      e.target instanceof Element &&
      e.target.closest(`[data-menu="${menuOpen.value}"]`)
    ) {
      return;
    }
    const focusInMenu = document.activeElement?.closest?.(
      `[data-menu="${menuOpen.value}"]`,
    );
    closeMenu(menuOpen.value, { skipFocus: !focusInMenu });
  }

  function onWinResize() {
    if (menuOpen.value) closeMenu(menuOpen.value, { skipFocus: true });
  }

  onMounted(() => {
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("contextmenu", onDocContextMenu, true);
    document.addEventListener("scroll", onDocScroll, true);
    window.addEventListener("resize", onWinResize);
  });
  onUnmounted(() => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("contextmenu", onDocContextMenu, true);
    document.removeEventListener("scroll", onDocScroll, true);
    window.removeEventListener("resize", onWinResize);
  });

  return { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown };
}
