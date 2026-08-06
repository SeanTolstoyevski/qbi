/*
 * Tests for useReturnFocus.js
 *
 * This composable has three jobs:
 *   1. Capture document.activeElement at mount time (the trigger button).
 *   2. Move focus to the overlay's heading after mount.
 *   3. Return focus to the trigger on unmount, and close on Escape.
 *
 * We mount a minimal wrapper component so the Vue lifecycle hooks fire
 * exactly as they do in production.
 */

import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref, nextTick } from "vue";
import { useReturnFocus } from "../useReturnFocus.js";

// A tiny overlay component that mirrors real usage.
function makeOverlay(onClose = vi.fn(), openerId = null) {
  return defineComponent({
    props: { openerId: { type: String, default: null } },
    setup(props) {
      const headingEl = ref(null);
      const { onKeydown } = useReturnFocus({
        focusTarget: headingEl,
        openerId: props.openerId || openerId,
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

    const wrapper = mount(makeOverlay(), { attachTo: document.body });
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

  it("captures the opener by id when a different element has focus", async () => {
    // Panel swaps: the outgoing panel's focus-return can leave a stale
    // element focused when the new panel mounts. An explicit openerId must
    // win over document.activeElement.
    const trigger = document.createElement("button");
    trigger.id = "open-overlay";
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "elsewhere";
    document.body.appendChild(elsewhere);
    elsewhere.focus(); // activeElement is NOT the trigger

    const wrapper = mount(makeOverlay(vi.fn(), "open-overlay"), {
      attachTo: document.body,
    });
    await nextTick();
    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
    document.body.removeChild(elsewhere);
  });

  it("falls back to activeElement when the opener id is not found", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(vi.fn(), "missing-id"), {
      attachTo: document.body,
    });
    await nextTick();
    wrapper.unmount();
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("retries focus when the trigger is disabled at unmount time", async () => {
    // A trigger button is often disabled while its panel is open. If it is
    // still disabled at unmount, focus() is a silent no-op and the user
    // lands on <body>; the deferred retry (after the close re-render
    // re-enables the button) must bring focus back.
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(), { attachTo: document.body });
    await nextTick();

    trigger.disabled = true;
    wrapper.unmount();
    trigger.disabled = false; // the close re-render re-enables it
    await nextTick();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("does not refocus when the trigger is removed from the document", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open overlay";
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(makeOverlay(), { attachTo: document.body });
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
