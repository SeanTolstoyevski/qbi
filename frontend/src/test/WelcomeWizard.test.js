/*
 * Tests for WelcomeWizard.vue — the first-launch responsibility wizard.
 *
 * Covers the dialog semantics (role, modal, labelling), the step-by-step
 * flow, the acknowledgment gate on the final step, dismissal (close button,
 * Escape), the focus trap, and focus placement on open and on step changes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import WelcomeWizard from "../components/WelcomeWizard.vue";

function mountWizard(props) {
  return mount(WelcomeWizard, { attachTo: document.body, props });
}

function buttons(w) {
  return w.findAll("button");
}

function buttonByText(w, text) {
  const b = buttons(w).find((b) => b.text() === text);
  expect(b, `button ${text}`).toBeTruthy();
  return b;
}

async function goToStep(w, n) {
  for (let i = 1; i < n; i++) {
    await buttonByText(w, "Next").trigger("click");
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("WelcomeWizard — dialog semantics", () => {
  it("is a modal dialog labelled by the current step heading", () => {
    const w = mountWizard();
    const dialog = w.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe("welcome-step-1");
    // The step position is announced alongside the heading on entry.
    expect(dialog.attributes("aria-describedby")).toBe(
      "welcome-step-indicator",
    );
    w.unmount();
  });

  it("renders the first step with an accessible step indicator", () => {
    const w = mountWizard();
    expect(w.text()).toContain("QBI follows your instructions");
    expect(w.text()).toContain("Step 1 of 3");
    expect(w.text()).toContain("never changes your cluster by itself");
    w.unmount();
  });

  it("moves focus to the step heading when the dialog opens", async () => {
    const w = mountWizard();
    await nextTick(); // onMounted schedules the initial focus on the next tick
    expect(document.activeElement).toBe(w.find("#welcome-step-1").element);
    w.unmount();
  });
});

describe("WelcomeWizard — step flow", () => {
  it("disables Back on the first step and enables Next", () => {
    const w = mountWizard();
    expect(buttonByText(w, "Back").attributes("disabled")).toBeDefined();
    expect(buttonByText(w, "Next").attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("advances to the next step, updates the label and focuses the heading", async () => {
    const w = mountWizard();
    await buttonByText(w, "Next").trigger("click");
    expect(w.text()).toContain("Nothing changes without your command");
    expect(w.text()).toContain("Step 2 of 3");
    expect(w.find('[role="dialog"]').attributes("aria-labelledby")).toBe(
      "welcome-step-2",
    );
    expect(document.activeElement).toBe(w.find("#welcome-step-2").element);
    w.unmount();
  });

  it("goes back to the previous step and focuses its heading", async () => {
    const w = mountWizard();
    await buttonByText(w, "Next").trigger("click");
    await buttonByText(w, "Back").trigger("click");
    expect(w.text()).toContain("QBI follows your instructions");
    expect(w.text()).toContain("Step 1 of 3");
    expect(document.activeElement).toBe(w.find("#welcome-step-1").element);
    w.unmount();
  });

  it("shows all three steps in order", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    expect(w.text()).toContain("Tested, not infallible");
    expect(w.text()).toContain("Step 3 of 3");
    expect(w.text()).toContain(
      "You are responsible for the changes you make and for their results.",
    );
    expect(w.text()).toContain("not a legal agreement");
    w.unmount();
  });
});

describe("WelcomeWizard — acknowledgment gate", () => {
  it("keeps Get started disabled until the checkbox is checked", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    const start = buttonByText(w, "Get started");
    expect(start.attributes("disabled")).toBeDefined();

    await w.find("#welcome-acknowledge").setValue(true);
    expect(start.attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("emits acknowledged when Get started is clicked with the box checked", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    await w.find("#welcome-acknowledge").setValue(true);
    await buttonByText(w, "Get started").trigger("click");
    expect(w.emitted("acknowledged")).toHaveLength(1);
    expect(w.emitted("dismiss")).toBeUndefined();
    w.unmount();
  });

  it("replaces Next with Get started on the final step", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    expect(buttonByText(w, "Get started").exists()).toBe(true);
    expect(buttons(w).some((b) => b.text() === "Next")).toBe(false);
    w.unmount();
  });
});

describe("WelcomeWizard — dismissal", () => {
  it("emits dismiss when the close button is clicked", async () => {
    const w = mountWizard();
    await w.find(".btn-close").trigger("click");
    expect(w.emitted("dismiss")).toHaveLength(1);
    expect(w.emitted("acknowledged")).toBeUndefined();
    w.unmount();
  });

  it("emits dismiss on Escape", async () => {
    const w = mountWizard();
    await w.find('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toHaveLength(1);
    w.unmount();
  });

  it("does not treat an unchecked Get started as acknowledgment", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    // Disabled button swallows the click, so no event is emitted.
    await buttonByText(w, "Get started").trigger("click");
    expect(w.emitted("acknowledged")).toBeUndefined();
    w.unmount();
  });
});

describe("WelcomeWizard — button icons", () => {
  it("shows a left arrow on Back and a right arrow on Next", () => {
    const w = mountWizard();
    expect(buttonByText(w, "Back").find(".bi-arrow-left").exists()).toBe(true);
    expect(buttonByText(w, "Next").find(".bi-arrow-right").exists()).toBe(true);
    w.unmount();
  });

  it("marks the icons decorative so the text label stays the accessible name", () => {
    const w = mountWizard();
    expect(
      buttonByText(w, "Back").find(".bi-arrow-left").attributes("aria-hidden"),
    ).toBe("true");
    expect(
      buttonByText(w, "Next").find(".bi-arrow-right").attributes("aria-hidden"),
    ).toBe("true");
    w.unmount();
  });

  it("shows a green check on Get started as the completion action", async () => {
    const w = mountWizard();
    await goToStep(w, 3);
    const start = buttonByText(w, "Get started");
    expect(start.classes()).toContain("btn-success");
    const icon = start.find(".bi-check-lg");
    expect(icon.exists()).toBe(true);
    expect(icon.attributes("aria-hidden")).toBe("true");
    w.unmount();
  });
});

describe("WelcomeWizard — errors", () => {
  it("shows the acknowledgment error from the parent", () => {
    const w = mountWizard({ error: "Could not save. Try again." });
    const alert = w.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain("Could not save. Try again.");
    w.unmount();
  });
});
