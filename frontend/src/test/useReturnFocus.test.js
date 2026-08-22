/*
 * Tests for useReturnFocus.js
 *
 * This composable has three jobs:
 *   1. Capture the opener element passed by the parent (the trigger button).
 *   2. Move focus to the overlay's heading after mount.
 *   3. Return focus to the opener on unmount, and close on Escape.
 *
 * We mount a minimal wrapper component so the Vue lifecycle hooks fire
 * exactly as they do in production.
 */

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref, nextTick } from "vue";
import { useReturnFocus } from "../useReturnFocus.js";

// A tiny overlay component that mirrors real usage. The opener is an element
// handed down by the parent (template refs in production).
function makeOverlay(onClose = vi.fn(), opener = null) {
  return defineComponent({
    props: { opener: { type: Object, default: null } },
    setup(props) {
      const headingEl = ref(null);
      const { onKeydown } = useReturnFocus({
        focusTarget: headingEl,
        opener: props.opener || opener,
        onClose,
      });
      return { headingEl, onKeydown };
    },
    template: `
      <section @keydown="onKeydown">
        <h2 ref="headingEl" tabindex="-1">Overlay</h2>
        <button id="close-btn">Close</button>
      </section>
    `,
  });
}

describe("useReturnFocus — focus capture and return", () => {
  it("returns focus to the trigger element when the overlay unmounts", async () => {
    // Create a trigger button in the document and focus it.
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const wrapper = mount(makeOverlay(vi.fn(), trigger), {
      attachTo: document.body,
    });
    await nextTick();

    // Unmounting should return focus to the trigger.
    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("moves focus to the heading element on mount", async () => {
    const wrapper = mount(makeOverlay(), { attachTo: document.body });
    await nextTick();
    await nextTick(); // two ticks: onMounted fires, then nextTick inside it
    const heading = wrapper.find("h2").element;
    expect(document.activeElement).toBe(heading);
    wrapper.unmount();
  });

  it("captures the explicit opener even when a different element has focus", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "elsewhere";
    document.body.appendChild(elsewhere);
    elsewhere.focus(); // activeElement is NOT the trigger

    const wrapper = mount(makeOverlay(vi.fn(), trigger), {
      attachTo: document.body,
    });
    await nextTick();
    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
    document.body.removeChild(elsewhere);
  });

  it("does not move focus when no opener was provided", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(), { attachTo: document.body });
    await nextTick();
    const heading = wrapper.find("h2").element;
    expect(document.activeElement).toBe(heading);

    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).not.toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("retries focus when the trigger is disabled at unmount time", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(vi.fn(), trigger), {
      attachTo: document.body,
    });
    await nextTick();

    trigger.disabled = true;
    wrapper.unmount();
    trigger.disabled = false;
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("does not refocus when the trigger is removed from the document", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(vi.fn(), trigger), {
      attachTo: document.body,
    });
    await nextTick();

    document.body.removeChild(trigger);
    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).not.toBe(trigger);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});

describe("useReturnFocus — Escape key", () => {
  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const wrapper = mount(makeOverlay(onClose), { attachTo: document.body });
    await nextTick();

    await wrapper.find("section").trigger("keydown", { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("does not call onClose for other keys", async () => {
    const onClose = vi.fn();
    const wrapper = mount(makeOverlay(onClose), { attachTo: document.body });
    await nextTick();

    await wrapper.find("section").trigger("keydown", { key: "Enter" });
    await wrapper.find("section").trigger("keydown", { key: "Tab" });
    expect(onClose).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
