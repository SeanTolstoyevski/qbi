import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import WorkloadRollback from "../components/WorkloadRollback.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    listWorkloadRevisions: vi.fn(),
    rollbackWorkload: vi.fn(),
  },
  onEvent: vi.fn(() => () => {}),
}));

const rAF = () => new Promise((r) => requestAnimationFrame(r));

const { state, setConnection, setNamespace } = useStore();

const REVS = [
  {
    revision: 3,
    images: ["nginx:1.27"],
    changeCause: "go live 1.27",
    age: "1h",
    current: true,
    replicas: "3/3",
  },
  {
    revision: 2,
    images: ["nginx:1.24"],
    changeCause: "bump to 1.24",
    age: "2d",
    current: false,
    replicas: "3/3",
  },
  {
    revision: 1,
    images: ["nginx:1.21"],
    changeCause: "",
    age: "9d",
    current: false,
    replicas: "0/1",
  },
];

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");
  api.listWorkloadRevisions.mockResolvedValue(REVS);
  api.rollbackWorkload.mockResolvedValue({ applied: true, skipped: false });
});

function mountPanel(props = {}) {
  return mount(WorkloadRollback, {
    attachTo: document.body,
    props: {
      namespace: "default",
      kind: "Deployment",
      name: "web",
      ...props,
    },
  });
}

describe("WorkloadRollback - history picker", () => {
  it("loads revisions and offers every non-current one, newest first", async () => {
    const w = mountPanel();
    await flushPromises();

    expect(api.listWorkloadRevisions).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
    );
    expect(w.text()).toContain("Current revision: 3");
    expect(w.text()).toContain("nginx:1.27");
    const options = w.findAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0].text()).toContain("Revision 2");
    expect(options[1].text()).toContain("Revision 1");
    expect(options[0].text()).toContain("nginx:1.24");
    expect(options[0].text()).toContain("bump to 1.24");
    expect(options[0].text()).toContain("3/3 ready");
    expect(options[0].text()).toContain("2d ago");

    expect(options[0].attributes("aria-selected")).toBe("true");
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    expect(btn.text()).toContain("Roll back to revision 2");
    expect(btn.attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("rolls back to the selected revision and reports the result", async () => {
    const w = mountPanel();
    await flushPromises();
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    await btn.trigger("click");
    await flushPromises();

    expect(api.rollbackWorkload).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
      2,
    );
    expect(w.emitted("rolled-back")).toEqual([[{ revision: 2 }]]);
    w.unmount();
  });

  it("preselects the revision the digest was opened from", async () => {
    const w = mountPanel({ preselect: 1 });
    await flushPromises();

    const options = w.findAll('[role="option"]');
    expect(options[1].attributes("aria-selected")).toBe("true");
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    expect(btn.text()).toContain("Roll back to revision 1");
    w.unmount();
  });

  it("keeps the panel open and explains a skipped rollback", async () => {
    api.rollbackWorkload.mockResolvedValue({ applied: false, skipped: true });
    const w = mountPanel();
    await flushPromises();
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    await btn.trigger("click");
    await flushPromises();
    await rAF();

    expect(w.emitted("rolled-back")).toBeUndefined();
    expect(w.text()).toContain("Current revision: 3");
    expect(state.status).toContain("already runs the template of revision 2");
    w.unmount();
  });

  it("stays silent when the user cancels the native confirmation", async () => {
    api.rollbackWorkload.mockResolvedValue({ applied: false, skipped: false });
    const w = mountPanel();
    await flushPromises();
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    await btn.trigger("click");
    await flushPromises();
    await rAF();

    expect(w.emitted("rolled-back")).toBeUndefined();
    expect(state.status).not.toContain("nothing to roll back");
    expect(w.text()).toContain("Current revision: 3"); // panel stays open
    w.unmount();
  });

  it("announces a rollback failure without closing", async () => {
    api.rollbackWorkload.mockRejectedValue(new Error("cluster exploded"));
    const w = mountPanel();
    await flushPromises();
    const btn = w.findAll("button").find((b) => b.text().includes("Roll back"));
    await btn.trigger("click");
    await flushPromises();
    await rAF();

    expect(w.emitted("rolled-back")).toBeUndefined();
    expect(state.status).toContain("Failed to roll back Deployment web");
    w.unmount();
  });

  it("shows the error when revisions cannot be loaded", async () => {
    api.listWorkloadRevisions.mockRejectedValue(new Error("Forbidden"));
    const w = mountPanel();
    await flushPromises();
    await rAF();

    expect(w.find('[role="alert"]').text()).toContain("Forbidden");
    expect(state.status).toContain(
      "Failed to load revisions for Deployment web",
    );
    w.unmount();
  });

  it("explains an empty history without offering a rollback button", async () => {
    api.listWorkloadRevisions.mockResolvedValue([]);
    const w = mountPanel();
    await flushPromises();

    expect(w.text()).toContain("No rollback targets");
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    expect(
      w.findAll("button").find((b) => b.text().includes("Roll back")),
    ).toBeUndefined();
    w.unmount();
  });

  it("closes via the panel Close button", async () => {
    const w = mountPanel();
    await flushPromises();
    await w
      .findAll("button")
      .find((b) => b.text() === "Close")
      .trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });
});
