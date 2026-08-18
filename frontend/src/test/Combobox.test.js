import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import Combobox from "../components/Combobox.vue";

const OPTIONS = [
  "Opaque",
  "kubernetes.io/tls",
  "kubernetes.io/basic-auth",
  "kubernetes.io/dockerconfigjson",
  "kubernetes.io/ssh-auth",
  "kubernetes.io/service-account-token",
];

async function mountBox(props = {}) {
  const w = mount(Combobox, {
    props: {
      id: "type-field",
      modelValue: "",
      options: OPTIONS,
      ...props,
    },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

async function syncModel(w) {
  const ev = w.emitted("update:modelValue");
  if (ev?.length) await w.setProps({ modelValue: ev.at(-1)[0] });
}

function input(w) {
  return w.find('input[role="combobox"]');
}
function list(w) {
  return w.find('ul[role="listbox"]');
}
function options(w) {
  return w.findAll('li[role="option"]');
}
function activeOption(w) {
  const id = input(w).attributes("aria-activedescendant");
  return id ? w.find(`#${id}`) : null;
}

async function key(w, key) {
  await input(w).trigger("keydown", { key });
  await syncModel(w);
}

describe("Combobox - keyboard navigation", () => {
  it("ArrowDown opens the list, highlights the first option and announces both to assistive tech", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    expect(list(w).isVisible()).toBe(true);
    expect(input(w).attributes("aria-expanded")).toBe("true");
    const active = activeOption(w);
    expect(active).not.toBeNull();
    expect(active.text()).toBe("Opaque");
    expect(active.attributes("aria-selected")).toBe("true");
    expect(activeOption(w).element.id).toBe(
      input(w).attributes("aria-activedescendant"),
    );
    w.unmount();
  });

  it("ArrowDown moves the highlight through the options", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    expect(activeOption(w).text()).toBe("kubernetes.io/basic-auth");
    w.unmount();
  });

  it("ArrowDown stops at the last option", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    for (let i = 0; i < OPTIONS.length + 3; i++) await key(w, "ArrowDown");
    expect(activeOption(w).text()).toBe("kubernetes.io/service-account-token");
    w.unmount();
  });

  it("ArrowUp moves the highlight back", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    await key(w, "ArrowUp");
    expect(activeOption(w).text()).toBe("Opaque");
    w.unmount();
  });

  it("ArrowUp with a closed list opens it on the last option", async () => {
    const w = await mountBox();
    await key(w, "ArrowUp");
    expect(list(w).isVisible()).toBe(true);
    expect(activeOption(w).text()).toBe("kubernetes.io/service-account-token");
    w.unmount();
  });

  it("Home and End jump to the first and last visible option", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    await key(w, "End");
    expect(activeOption(w).text()).toBe("kubernetes.io/service-account-token");
    await key(w, "Home");
    expect(activeOption(w).text()).toBe("Opaque");
    w.unmount();
  });

  it("Enter picks the highlighted option, fills the input and closes the list", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    await key(w, "Enter");
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual([
      "kubernetes.io/tls",
    ]);
    expect(w.emitted("select")?.at(-1)).toEqual(["kubernetes.io/tls"]);
    expect(input(w).element.value).toBe("kubernetes.io/tls");
    // Closed again after the pick: no expanded popup, no announced option.
    expect(input(w).attributes("aria-expanded")).toBe("false");
    expect(input(w).attributes("aria-activedescendant")).toBeUndefined();
    w.unmount();
  });

  it("Enter with the list closed neither picks nor emits", async () => {
    const w = await mountBox();
    await key(w, "Enter");
    expect(w.emitted("select")).toBeUndefined();
    expect(w.emitted("update:modelValue")).toBeUndefined();
    w.unmount();
  });

  it("Escape closes the list without picking and keeps the typed text", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    expect(list(w).isVisible()).toBe(true);
    await key(w, "Escape");
    expect(list(w).isVisible()).toBe(false);
    expect(input(w).attributes("aria-expanded")).toBe("false");
    expect(w.emitted("select")).toBeUndefined();
    w.unmount();
  });

  it("Escape while the list is open does not bubble to the enclosing screen", async () => {
    // The enclosing panel closes on Escape; an open combobox popup must
    // swallow it first so it only closes the list.
    const onOuterKey = vi.fn();
    const w = mount(Combobox, {
      props: { modelValue: "", options: OPTIONS },
      attachTo: document.body,
      attrs: { onKeydown: onOuterKey },
    });
    await flushPromises();
    await input(w).trigger("keydown", { key: "ArrowDown" });
    await input(w).trigger("keydown", { key: "Escape" });
    expect(list(w).isVisible()).toBe(false);
    const keysSeen = onOuterKey.mock.calls.map((c) => c[0].key);
    expect(keysSeen).not.toContain("Escape");
    w.unmount();
  });
});

describe("Combobox - filtering and free text", () => {
  it("filters options as the user types", async () => {
    const w = await mountBox();
    await input(w).setValue("tls");
    await syncModel(w);
    expect(options(w).map((o) => o.text())).toEqual(["kubernetes.io/tls"]);
    expect(activeOption(w).text()).toBe("kubernetes.io/tls");
    w.unmount();
  });

  it("shows all options again when the input is cleared", async () => {
    const w = await mountBox();
    await input(w).setValue("tls");
    await syncModel(w);
    expect(options(w)).toHaveLength(1);
    await input(w).setValue("");
    await syncModel(w);
    expect(options(w)).toHaveLength(OPTIONS.length);
    w.unmount();
  });

  it("closes the list when nothing matches", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    await input(w).setValue("zzz-no-match");
    await syncModel(w);
    expect(list(w).isVisible()).toBe(false);
    w.unmount();
  });

  it("picks an option from a filtered subset after typing", async () => {
    const w = await mountBox();
    await input(w).setValue("kubernetes");
    await syncModel(w);
    // Typing opens the list with the first match highlighted.
    expect(options(w).length).toBeGreaterThan(1);
    await key(w, "ArrowDown");
    await key(w, "Enter");
    expect(input(w).element.value).toBe("kubernetes.io/basic-auth");
    expect(list(w).isVisible()).toBe(false);
    w.unmount();
  });

  it("keeps free text the user typed even without a match", async () => {
    const w = await mountBox();
    await input(w).setValue("example.com/custom-type");
    await syncModel(w);
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual([
      "example.com/custom-type",
    ]);
    expect(input(w).element.value).toBe("example.com/custom-type");
    w.unmount();
  });
});

describe("Combobox - readonly (select-only) mode", () => {
  const RO_OPTIONS = [
    { value: 100, label: "100 lines" },
    { value: 500, label: "500 lines" },
    { value: 1000, label: "1000 lines" },
    { value: -1, label: "All" },
  ];

  async function mountRo(modelValue = 500, extra = {}) {
    const w = mount(Combobox, {
      props: {
        id: "ro-box",
        modelValue,
        options: RO_OPTIONS,
        readonly: true,
        ...extra,
      },
      attachTo: document.body,
    });
    await flushPromises();
    return w;
  }

  it("shows the current value's label and is not typeable", async () => {
    const w = await mountRo();
    expect(input(w).element.value).toBe("500 lines");
    expect(input(w).element.readOnly).toBe(true);
    w.unmount();
  });

  it("ArrowDown opens with the current selection highlighted and moves through options", async () => {
    const w = await mountRo();
    await key(w, "ArrowDown");
    expect(list(w).isVisible()).toBe(true);
    expect(activeOption(w).text()).toBe("500 lines");
    await key(w, "ArrowDown");
    expect(activeOption(w).text()).toBe("1000 lines");
    w.unmount();
  });

  it("Enter picks the highlighted option and emits the numeric value", async () => {
    const w = await mountRo();
    await key(w, "ArrowDown");
    await key(w, "ArrowDown");
    await key(w, "Enter");
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual([1000]);
    expect(w.emitted("select")?.at(-1)).toEqual([1000]);
    expect(input(w).element.value).toBe("1000 lines");
    expect(input(w).attributes("aria-expanded")).toBe("false");
    w.unmount();
  });

  it("Space opens the list when closed and picks when open", async () => {
    const w = await mountRo(100);
    await key(w, " ");
    expect(list(w).isVisible()).toBe(true);
    await key(w, " ");
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual([100]);
    expect(list(w).isVisible()).toBe(false);
    w.unmount();
  });

  it("typing does not change the value", async () => {
    const w = await mountRo();
    // The readonly attribute blocks typing in a real browser; the component
    // must additionally ignore any input event that slips through.
    expect(input(w).element.readOnly).toBe(true);
    await input(w).trigger("input");
    expect(w.emitted("update:modelValue")).toBeUndefined();
    w.unmount();
  });

  it("type-ahead jumps to the option matching the typed characters", async () => {
    const w = await mountRo();
    await key(w, "ArrowDown");
    await key(w, "a"); // "All"
    expect(activeOption(w).text()).toBe("All");
    w.unmount();
  });

  it("disabled combobox ignores keyboard input", async () => {
    const w = await mountRo(500, { disabled: true });
    expect(input(w).attributes("disabled")).toBeDefined();
    await key(w, "ArrowDown");
    expect(list(w).isVisible()).toBe(false);
    w.unmount();
  });
});

describe("Combobox - pointer interaction and blur", () => {
  it("picks an option on click and keeps focus in the input", async () => {
    const w = await mountBox();
    await input(w).element.focus();
    await key(w, "ArrowDown");
    await options(w)[1].trigger("click");
    await syncModel(w);
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual([
      "kubernetes.io/tls",
    ]);
    expect(input(w).element.value).toBe("kubernetes.io/tls");
    expect(list(w).isVisible()).toBe(false);
    // Focus must stay in the input, not the (unfocusable) option.
    expect(document.activeElement).toBe(input(w).element);
    w.unmount();
  });

  it("closes the list when the input loses focus", async () => {
    const w = await mountBox();
    await key(w, "ArrowDown");
    expect(list(w).isVisible()).toBe(true);
    await input(w).trigger("blur");
    expect(list(w).isVisible()).toBe(false);
    w.unmount();
  });
});
