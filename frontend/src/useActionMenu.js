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
 * DOM access stays inside the consumer's own rendered elements: pass
 * `triggerRefs` / `menuRefs` (plain maps keyed by menu key, kept current by
 * `:ref` callbacks) so the composable never reaches into the document. Views
 * with a dynamic trigger (e.g. a listbox row instead of a dedicated button)
 * pass `getTrigger(key)` / `getMenu(key)` overrides instead.
 *
 * Usage (inside <script setup>):
 *
 *   const actionTriggers = {};
 *   const menuEls = {};
 *   function setActionTrigger(key, el) {
 *     if (el) actionTriggers[key] = el;
 *     else delete actionTriggers[key];
 *   }
 *   function setMenuEl(key, el) {
 *     if (el) menuEls[key] = el;
 *     else delete menuEls[key];
 *   }
 *
 *   const { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
 *     useActionMenu(menuOpen, { triggerRefs: actionTriggers, menuRefs: menuEls });
 *
 *   // In template:
 *   // <button :ref="(el) => setActionTrigger(key, el)" :id="`actions-btn-${key}`" @click="openMenu(key)">…</button>
 *   // <div v-if="menuOpen === key" :ref="(el) => setMenuEl(key, el)" :data-menu="key" @keydown="onMenuKeydown($event, key)">
 *   //   <button role="menuitem" @click="closeMenu(key); doSomething()">…</button>
 *   // </div>
 *
 * The composable handles its own document-level click-outside listener
 * (mounted capture-phase) and cleans up on unmount, so the consumer's
 * <script setup> block does not need onMounted / onUnmounted boilerplate.
 */

import { ref, onMounted, onUnmounted, nextTick } from "vue";

export function useActionMenu(externalRef, options = {}) {
  const menuOpen = externalRef || ref(""); // key of the currently open action menu
  const triggerRefs = options.triggerRefs || {};
  const menuRefs = options.menuRefs || {};
  const getTrigger = options.getTrigger || ((key) => triggerRefs[key]);
  const getMenu = options.getMenu || ((key) => menuRefs[key]);
  let focusInMenu = false;

  function openMenu(key) {
    menuOpen.value = key;
    focusInMenu = false; // the focusin listener flips this once an item gets focus
    nextTick(() => {
      const menu = getMenu(key);
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
   * opens a panel that uses useReturnFocus (which captures the opener in
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
   * Tab closes without returning focus. Items come from the element the
   * handler is bound to and the focused item is the event target, so no
   * document or container lookups are needed.
   */
  function onMenuKeydown(e, key) {
    const items = Array.from(
      e.currentTarget.querySelectorAll('[role="menuitem"]:not([disabled])'),
    );
    const idx = items.indexOf(e.target);
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
    const menu = getMenu(menuOpen.value);
    const btn = getTrigger(menuOpen.value);
    if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
      menuOpen.value = "";
    }
  }

  // Right-click fires contextmenu, not click; without this a menu stays open
  // after the user right-clicks somewhere else (until Escape/left-click).
  function onDocContextMenu(e) {
    if (!menuOpen.value) return;
    const menu = getMenu(menuOpen.value);
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
    const menu = getMenu(menuOpen.value);
    if (e.target instanceof Element && menu?.contains(e.target)) {
      return;
    }
    closeMenu(menuOpen.value, { skipFocus: !focusInMenu });
  }

  // Where focus is while the menu is open, tracked via focusin/focusout so
  // onDocScroll knows whether returning focus to the trigger is required
  // without reaching into the document.
  function onDocFocusIn(e) {
    if (!menuOpen.value) return;
    focusInMenu = !!getMenu(menuOpen.value)?.contains(e.target);
  }

  function onDocFocusOut(e) {
    const menu = getMenu(menuOpen.value);
    if (menu && !menu.contains(e.relatedTarget)) focusInMenu = false;
  }

  function onWinResize() {
    if (menuOpen.value) closeMenu(menuOpen.value, { skipFocus: true });
  }

  onMounted(() => {
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("contextmenu", onDocContextMenu, true);
    document.addEventListener("scroll", onDocScroll, true);
    document.addEventListener("focusin", onDocFocusIn, true);
    document.addEventListener("focusout", onDocFocusOut, true);
    window.addEventListener("resize", onWinResize);
  });
  onUnmounted(() => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("contextmenu", onDocContextMenu, true);
    document.removeEventListener("scroll", onDocScroll, true);
    document.removeEventListener("focusin", onDocFocusIn, true);
    document.removeEventListener("focusout", onDocFocusOut, true);
    window.removeEventListener("resize", onWinResize);
  });

  return { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown };
}
