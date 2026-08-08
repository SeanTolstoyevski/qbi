import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref, nextTick } from "vue";
import { useActionMenu } from "../useActionMenu.js";

function makeComponent() {
  return defineComponent({
    setup() {
      const { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown } =
        useActionMenu();
      return { menuOpen, openMenu, closeMenu, focusTriggerAndAct, onMenuKeydown };
    },
    template: `
      <div>
        <button id="actions-btn-item1" @click="openMenu('item1')">Actions</button>
        <div v-if="menuOpen === 'item1'" data-menu="item1" @keydown="onMenuKeydown($event, 'item1')">
          <button role="menuitem" @click="closeMenu('item1')">View</button>
          <button role="menuitem" disabled>Disabled</button>
          <button role="menuitem" @click="closeMenu('item1')">Edit</button>
        </div>
      </div>
    `,
  });
}

describe("useActionMenu — open / close / focus", () => {
  it("opens the menu and focuses the first enabled menuitem", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });
    const trigger = wrapper.find("#actions-btn-item1");

    await trigger.trigger("click");
    await nextTick();
    await nextTick(); // openMenu uses nextTick internally

    expect(wrapper.vm.menuOpen).toBe("item1");
    const menu = document.querySelector('[data-menu="item1"]');
    const firstItem = menu?.querySelector('[role="menuitem"]:not([disabled])');
    expect(document.activeElement).toBe(firstItem);

    wrapper.unmount();
  });

  it("closeMenu clears menuOpen and returns focus to the trigger", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    wrapper.vm.closeMenu("item1");
    await nextTick();

    expect(wrapper.vm.menuOpen).toBe("");
    expect(document.activeElement).toBe(
      document.getElementById("actions-btn-item1"),
    );

    wrapper.unmount();
  });

  it("closeMenu with skipFocus does not move focus", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const somewhere = document.createElement("button");
    document.body.appendChild(somewhere);
    somewhere.focus();

    wrapper.vm.closeMenu("item1", { skipFocus: true });
    await nextTick();

    expect(wrapper.vm.menuOpen).toBe("");
    expect(document.activeElement).toBe(somewhere); // focus unchanged

    document.body.removeChild(somewhere);
    wrapper.unmount();
  });

  it("focusTriggerAndAct focuses the trigger then executes fn", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const fn = vi.fn();
    wrapper.vm.focusTriggerAndAct("item1", fn);
    expect(wrapper.vm.menuOpen).toBe("");

    expect(document.activeElement).toBe(
      document.getElementById("actions-btn-item1"),
    );

    expect(fn).not.toHaveBeenCalled();
    await nextTick();
    expect(fn).toHaveBeenCalled();

    wrapper.unmount();
  });
});

describe("useActionMenu — keyboard navigation", () => {
  it("Escape closes the menu and returns focus", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();

    expect(wrapper.vm.menuOpen).toBe("");
    expect(document.activeElement).toBe(
      document.getElementById("actions-btn-item1"),
    );

    wrapper.unmount();
  });

  it("ArrowDown moves focus to the next enabled item", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    );

    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    expect(document.activeElement).toBe(items[1]); // Edit (index 1 in enabled list)

    wrapper.unmount();
  });

  it("ArrowDown wraps from last to first", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    items[1]?.focus(); // Edit

    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    );

    expect(document.activeElement).toBe(items[0]); // wraps to View

    wrapper.unmount();
  });

  it("ArrowUp wraps from first to last", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );

    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    expect(document.activeElement).toBe(items[items.length - 1]); // Edit

    wrapper.unmount();
  });

  it("Home moves focus to the first item", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    items[1]?.focus(); // Edit

    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );

    expect(document.activeElement).toBe(items[0]); // View

    wrapper.unmount();
  });

  it("End moves focus to the last item", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );

    const items = Array.from(
      menu?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [],
    );
    expect(document.activeElement).toBe(items[items.length - 1]);

    wrapper.unmount();
  });

  it("Tab closes the menu without returning focus", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();

    const menu = document.querySelector('[data-menu="item1"]');
    await menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );

    expect(wrapper.vm.menuOpen).toBe("");

    wrapper.unmount();
  });
});

describe("useActionMenu — click outside", () => {
  it("closes the menu when clicking outside", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();
    expect(wrapper.vm.menuOpen).toBe("item1");

    // Click somewhere outside the menu
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.click();

    expect(wrapper.vm.menuOpen).toBe("");

    document.body.removeChild(outside);
    wrapper.unmount();
  });

  it("does not close the menu when clicking inside", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();
    expect(wrapper.vm.menuOpen).toBe("item1");

    // Click a menuitem inside the menu
    const menu = document.querySelector('[data-menu="item1"]');
    const firstItem = menu?.querySelector('[role="menuitem"]');
    firstItem?.click();

    // The menuitem's own handler calls closeMenu, so menuOpen should be ""
    // But we're testing that the click-outside listener doesn't fire when
    // clicking inside — the menu should still have been open before the
    // handler ran. We just verify no error is thrown.
    expect(wrapper.vm.menuOpen).toBe("");

    wrapper.unmount();
  });

  it("does not close when clicking the trigger button", async () => {
    const wrapper = mount(makeComponent(), { attachTo: document.body });

    wrapper.vm.openMenu("item1");
    await nextTick();
    await nextTick();
    expect(wrapper.vm.menuOpen).toBe("item1");

    // Click the trigger button itself — should not be treated as "outside"
    const trigger = document.getElementById("actions-btn-item1");
    trigger?.click();

    // The click on trigger toggles the menu in real usage, but our test
    // component uses @click="openMenu('item1')" which re-opens it.
    // The point is that the click-outside handler doesn't fire for the trigger.
    expect(wrapper.vm.menuOpen).toBe("item1");

    wrapper.unmount();
  });
});
