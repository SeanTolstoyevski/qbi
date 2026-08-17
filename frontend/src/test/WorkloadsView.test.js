import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import WorkloadsView from "../components/WorkloadsView.vue";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    listWorkloads: vi.fn(),
    listJobs: vi.fn(),
    listCronJobs: vi.fn(),
    restartWorkload: vi.fn(),
    scaleWorkload: vi.fn(),
    deleteWorkload: vi.fn(),
    getResourceYaml: vi.fn(),
    history: vi.fn(),
    getCronJobDetail: vi.fn(),
    createCronJob: vi.fn(),
    updateCronJob: vi.fn(),
    createDeployment: vi.fn(),
    renderDeploymentYaml: vi.fn(),

    startLogStream: vi.fn().mockResolvedValue("stream-1"),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    saveLogs: vi.fn().mockResolvedValue(null),
  },

  onEvent: vi.fn(() => () => {}),
}));

const { setConnection, setNamespace } = useStore();

beforeEach(() => {
  setConnection({ name: "test-ctx", namespace: "default" });
  setNamespace("default");

  api.history.mockResolvedValue({ rollouts: [] });
});

const WL = [
  {
    kind: "Deployment",
    name: "web",
    namespace: "default",
    ready: "2/2",
    upToDate: 2,
    available: 2,
    images: ["nginx:1.27"],
    age: "2d",
  },
];

function mountView() {
  return mount(WorkloadsView, { attachTo: document.body });
}

function findBtn(w, label) {
  return w.findAll("button").find((b) => b.text().includes(label));
}

// Actions live behind an "Actions" dropdown button; open it before clicking a
// menu item (same helper convention as PodList tests).
async function openActions(w) {
  await findBtn(w, "Actions").trigger("click");
  await nextTick();
}

// A CronJob row fixture with the fields the new actions rely on.
const CJ = {
  name: "backup",
  namespace: "default",
  schedule: "0 * * * *",
  suspended: false,
  active: 0,
  lastSchedule: "1h ago",
  age: "2d",
  image: "busybox",
  concurrencyPolicy: "Allow",
};

function mountWithCronJobs() {
  api.listWorkloads.mockResolvedValue({ workloads: [], errors: [] });
  api.listJobs.mockResolvedValue([]);
  api.listCronJobs.mockResolvedValue([CJ]);
  return mountView();
}

describe("WorkloadsView — payload shape", () => {
  it("renders workloads from the WorkloadsView payload", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("web");
    expect(w.text()).toContain("nginx:1.27");
    w.unmount();
  });

  it("shows per-kind RBAC errors but still renders readable workloads", async () => {
    api.listWorkloads.mockResolvedValue({
      workloads: WL,
      errors: ["StatefulSets: Forbidden", "DaemonSets: Forbidden"],
    });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("StatefulSets: Forbidden");
    expect(w.text()).toContain("DaemonSets: Forbidden");
    expect(w.text()).toContain("web"); // the readable kind is still shown
    w.unmount();
  });

  it("handles a legacy plain-array response defensively", async () => {
    // Older/partial responses must not crash even if the shape is unexpected.
    api.listWorkloads.mockResolvedValue(null);
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("None found.");
    w.unmount();
  });
});

describe("WorkloadsView — actions", () => {
  it("triggers a rolling restart via the API", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    api.restartWorkload.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Restart").trigger("click");
    await flushPromises();
    expect(api.restartWorkload).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
    );
    w.unmount();
  });
});

describe("WorkloadsView — delete workload", () => {
  it("deletes a workload via the API after confirmation", async () => {
    api.deleteWorkload.mockResolvedValue(true);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.deleteWorkload).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
    );
    w.unmount();
  });

  it("does NOT reload when the deletion is cancelled", async () => {
    api.deleteWorkload.mockResolvedValue(false);
    const w = mountView();
    await flushPromises();
    api.listWorkloads.mockClear();
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    await openActions(w);
    await findBtn(w, "Delete").trigger("click");
    await flushPromises();
    expect(api.listWorkloads).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("WorkloadsView — scale", () => {
  async function mountWithWorkloads() {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    return w;
  }

  async function openScaleRow(w) {
    await openActions(w);
    await findBtn(w, "Scale").trigger("click");
    await flushPromises();
  }

  it("prefills the scale input with the desired replica count", async () => {
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    expect(w.find("#scale-web").element.value).toBe("2");
    w.unmount();
  });

  it("applies the scale via the API and reloads", async () => {
    api.scaleWorkload.mockResolvedValue(true);
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    await w.find("#scale-web").setValue(5);
    api.listWorkloads.mockClear();
    await findBtn(w, "Apply").trigger("click");
    await flushPromises();
    expect(api.scaleWorkload).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
      5,
    );
    expect(api.listWorkloads).toHaveBeenCalled();
    expect(w.find("#scale-web").exists()).toBe(false);
    w.unmount();
  });

  it("keeps the row open when the user cancels the confirmation", async () => {
    api.scaleWorkload.mockResolvedValue(false);
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    api.listWorkloads.mockClear();
    await w.find("#scale-web").setValue(3);
    await findBtn(w, "Apply").trigger("click");
    await flushPromises();
    expect(api.scaleWorkload).toHaveBeenCalledWith(
      "default",
      "Deployment",
      "web",
      3,
    );
    expect(api.listWorkloads).not.toHaveBeenCalled();
    expect(w.find("#scale-web").exists()).toBe(true);
    w.unmount();
  });

  it("does not scale when the input is empty (invalid count)", async () => {
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    await w.find("#scale-web").setValue("");
    api.scaleWorkload.mockClear();
    await findBtn(w, "Apply").trigger("click");
    await flushPromises();
    expect(api.scaleWorkload).not.toHaveBeenCalled();
    expect(w.find("#scale-web").exists()).toBe(true);
    w.unmount();
  });

  it("shows the error when scaling fails", async () => {
    api.scaleWorkload.mockRejectedValue(new Error("scaling forbidden"));
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    await w.find("#scale-web").setValue(2);
    await findBtn(w, "Apply").trigger("click");
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toContain("scaling forbidden");
    w.unmount();
  });

  it("closes the scale row via Cancel", async () => {
    const w = await mountWithWorkloads();
    await openScaleRow(w);
    await findBtn(w, "Cancel").trigger("click");
    await flushPromises();
    expect(w.find("#scale-web").exists()).toBe(false);
    w.unmount();
  });

  it("hides the Scale item for DaemonSets", async () => {
    api.listWorkloads.mockResolvedValue({
      workloads: [{ ...WL[0], kind: "DaemonSet", ready: "3/3" }],
      errors: [],
    });
    const w = mountView();
    await flushPromises();
    await openActions(w);
    expect(findBtn(w, "Scale")).toBeUndefined();
    w.unmount();
  });
});

describe("WorkloadsView — namespace switch", () => {
  // The inline scale row names a workload from the previous namespace; it
  // must close when the namespace changes instead of lingering over a
  // resource that may not exist there.
  it("closes an open scale input when the namespace changes", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Scale").trigger("click");
    await flushPromises();
    expect(w.find("#scale-web").exists()).toBe(true);

    setNamespace("other");
    await flushPromises();
    expect(w.find("#scale-web").exists()).toBe(false);
    w.unmount();
  });

  it("closes an open action menu when the namespace changes", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    await openActions(w);
    expect(w.find('[role="menu"]').exists()).toBe(true);

    setNamespace("other");
    await flushPromises();
    expect(w.find('[role="menu"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("WorkloadsView — recent rollouts", () => {
  // Rollout history is the durable counterpart to events (which expire after
  // ~1h). The backend bounds it, and the view must render it and degrade
  // gracefully when the call is denied or slow.
  it("renders the rollout digest with revisions and ages", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: [], errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    api.history.mockResolvedValue({
      rollouts: [
        {
          name: "web",
          revision: "4",
          rollouts: [
            { revision: "4", age: "2m" },
            { revision: "3", age: "3d" },
          ],
        },
      ],
    });
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("web");
    expect(w.text()).toContain("revision 4");
    expect(w.text()).toContain("revision 3");
    expect(w.text()).toContain("3d");
    w.unmount();
  });

  it("shows an empty state when nothing has rolled out", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: [], errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("No rollouts match these options");
    w.unmount();
  });

  it("degrades to a note when history is unavailable, without breaking tables", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    api.history.mockRejectedValue(new Error("Forbidden"));
    const w = mountView();
    await flushPromises();
    // The main workload tables still render...
    expect(w.text()).toContain("web");
    // ...and the rollouts section shows a note instead of failing the screen.
    expect(w.text()).toContain("Rollout history unavailable");
    w.unmount();
  });

  // The user decides how much history to see: the chosen filter and caps are
  // sent to the backend rather than the app silently picking a limit.
  it("sends the chosen filter and limits to the backend", async () => {
    vi.useFakeTimers();
    try {
      api.listWorkloads.mockResolvedValue({ workloads: [], errors: [] });
      api.listJobs.mockResolvedValue([]);
      api.listCronJobs.mockResolvedValue([]);
      api.history.mockResolvedValue({ rollouts: [], total: 0 });
      const w = mountView();
      await flushPromises();
      api.history.mockClear();

      await w.find("#rollout-filter").setValue("web");
      await w.find("#rollout-limit").setValue("200");
      await w.find("#rollout-depth").setValue("10");
      await nextTick();
      await vi.advanceTimersByTimeAsync(300); // past the 250ms debounce

      expect(api.history).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({
          filter: "web",
          maxDeployments: 200,
          revisionsPerDeploy: 10,
        }),
      );
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports when the result is capped by the user's limit", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: [], errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    api.history.mockResolvedValue({
      rollouts: [
        {
          name: "web",
          revision: "2",
          rollouts: [{ revision: "2", age: "1m" }],
        },
      ],
      total: 37,
    });
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("Showing 1 of 37");
    w.unmount();
  });
});

describe("WorkloadsView — cron job logs", () => {
  it("streams the newest run's pod like a pod", async () => {
    api.getCronJobDetail.mockResolvedValue({
      name: "backup",
      schedule: "0 * * * *",
      runs: [
        {
          name: "backup-123",
          status: "Complete",
          age: "1m",
          pods: [{ name: "backup-123-abc", containers: ["main"] }],
        },
      ],
    });
    const w = mountWithCronJobs();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Logs").trigger("click");
    await flushPromises();
    expect(api.getCronJobDetail).toHaveBeenCalledWith("default", "backup");
    expect(api.startLogStream).toHaveBeenCalledWith(
      "default",
      "backup-123-abc",
      "main",
      expect.anything(),
    );
    w.unmount();
  });

  it("shows a container chooser for multi-container runs", async () => {
    api.getCronJobDetail.mockResolvedValue({
      name: "backup",
      schedule: "0 * * * *",
      runs: [
        {
          name: "backup-123",
          status: "Running",
          age: "1m",
          pods: [{ name: "backup-123-abc", containers: ["main", "sidecar"] }],
        },
      ],
    });
    const w = mountWithCronJobs();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Logs").trigger("click");
    await flushPromises();
    expect(w.find('[data-cj-log-group="backup"]').exists()).toBe(true);

    // Picking a container starts the stream for it.
    await w.find('[data-cj-log-group="backup"] button').trigger("click");
    await flushPromises();
    expect(api.startLogStream).toHaveBeenCalledWith(
      "default",
      "backup-123-abc",
      "main",
      expect.anything(),
    );
    w.unmount();
  });

  it("announces when a cron job has no recent runs", async () => {
    api.getCronJobDetail.mockResolvedValue({
      name: "backup",
      schedule: "0 * * * *",
      runs: [],
    });
    const w = mountWithCronJobs();
    await flushPromises();
    api.startLogStream.mockClear(); // ignore streams started by earlier tests
    await openActions(w);
    await findBtn(w, "Logs").trigger("click");
    await flushPromises();
    expect(api.startLogStream).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("WorkloadsView — cron job create", () => {
  it("creates a cron job from the form and reloads", async () => {
    api.createCronJob.mockResolvedValue(true);
    const w = mountWithCronJobs();
    await flushPromises();
    await findBtn(w, "Create cron job").trigger("click");
    await nextTick();
    await w.find("#cj-name").setValue("nightly");
    await w.find("#cj-schedule").setValue("0 2 * * *");
    await w.find("#cj-image").setValue("busybox");
    await w.find("#cj-command").setValue("echo hi");
    await w.find("#cj-concurrency").setValue("Forbid");
    await w.find("#cj-suspend").setValue(true);
    await w
      .findAll("button")
      .find((b) => b.text().trim() === "Create")
      .trigger("click");
    await flushPromises();
    expect(api.createCronJob).toHaveBeenCalledWith("default", {
      name: "nightly",
      schedule: "0 2 * * *",
      image: "busybox",
      command: ["echo", "hi"],
      suspend: true,
      concurrencyPolicy: "Forbid",
    });
    w.unmount();
  });

  it("rejects an invalid schedule inline", async () => {
    const w = mountWithCronJobs();
    await flushPromises();
    await findBtn(w, "Create cron job").trigger("click");
    await nextTick();
    await w.find("#cj-name").setValue("nightly");
    await w.find("#cj-schedule").setValue("not a cron");
    await w.find("#cj-image").setValue("busybox");
    api.createCronJob.mockClear(); // ignore creates sent by earlier tests
    await w
      .findAll("button")
      .find((b) => b.text().trim() === "Create")
      .trigger("click");
    await flushPromises();
    expect(api.createCronJob).not.toHaveBeenCalled();
    expect(w.text()).toContain("5-field cron expression");
    w.unmount();
  });
});

describe("WorkloadsView — cron job edit + suspend", () => {
  it("applies schedule and suspend edits", async () => {
    api.updateCronJob.mockResolvedValue(true);
    const w = mountWithCronJobs();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Edit").trigger("click");
    await nextTick();
    await w.find("#cj-edit-schedule").setValue("0 3 * * *");
    await w.find("#cj-edit-policy").setValue("Replace");
    await w.find("#cj-edit-suspend").setValue(true);
    await findBtn(w, "Apply").trigger("click");
    await flushPromises();
    expect(api.updateCronJob).toHaveBeenCalledWith("default", "backup", {
      schedule: "0 3 * * *",
      suspend: true,
      concurrencyPolicy: "Replace",
    });
    w.unmount();
  });

  it("suspends a cron job via the toggle", async () => {
    api.updateCronJob.mockResolvedValue(true);
    const w = mountWithCronJobs();
    await flushPromises();
    await openActions(w);
    await findBtn(w, "Suspend").trigger("click");
    await flushPromises();
    expect(api.updateCronJob).toHaveBeenCalledWith("default", "backup", {
      suspend: true,
    });
    w.unmount();
  });

  // The edit form is a separate panel (like pod detail/logs), so closing it
  // must return focus to the Edit button that opened it.
  it("returns focus to the Actions button when the panel closes via Escape", async () => {
    const w = mountWithCronJobs();
    await flushPromises();
    const actionsBtn = w.find("#actions-btn-cj-backup");
    await actionsBtn.trigger("click");
    await nextTick();
    await findBtn(w, "Edit").trigger("click");
    await nextTick();
    await nextTick(); // useReturnFocus moves focus to the panel heading
    expect(w.find("#cj-edit-heading").exists()).toBe(true);

    await w.find("#cj-edit-heading").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.find("#cj-edit-heading").exists()).toBe(false);
    expect(document.activeElement).toBe(actionsBtn.element);
    w.unmount();
  });
});

describe("WorkloadsView — deployment create", () => {
  function openDeployPanel(w) {
    return findBtn(w, "Create deployment").trigger("click");
  }

  it("renders a YAML preview from the form spec", async () => {
    api.renderDeploymentYaml.mockResolvedValue(
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
    );
    const w = mountWithCronJobs();
    await flushPromises();
    await openDeployPanel(w);
    await nextTick();
    await w.find("#dp-name").setValue("web");
    await w.find("#dp-image").setValue("nginx:1.27");
    await findBtn(w, "Preview YAML").trigger("click");
    await flushPromises();
    expect(api.renderDeploymentYaml).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ name: "web", image: "nginx:1.27" }),
    );
    expect(w.text()).toContain("kind: Deployment");
    w.unmount();
  });

  it("creates a deployment from the form and reloads", async () => {
    api.createDeployment.mockResolvedValue(true);
    const w = mountWithCronJobs();
    await flushPromises();
    await openDeployPanel(w);
    await nextTick();
    await w.find("#dp-name").setValue("web");
    await w.find("#dp-image").setValue("nginx:1.27");
    await w.find("#dp-replicas").setValue(3);
    await w.find("#dp-port").setValue(80);
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(api.createDeployment).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        name: "web",
        image: "nginx:1.27",
        replicas: 3,
        port: 80,
        protocol: "TCP",
      }),
    );
    w.unmount();
  });

  it("rejects creation when the form is invalid", async () => {
    const w = mountWithCronJobs();
    await flushPromises();
    await openDeployPanel(w);
    await nextTick();
    api.createDeployment.mockClear(); // ignore creates sent by earlier tests
    await w.find("form").trigger("submit"); // empty name
    await flushPromises();
    expect(api.createDeployment).not.toHaveBeenCalled();
    expect(w.text()).toContain("Name is required");
    w.unmount();
  });
});

describe("WorkloadsView — refresh button", () => {
  it("reloads workloads, jobs and cron jobs via the refresh button", async () => {
    api.listWorkloads.mockResolvedValue({ workloads: WL, errors: [] });
    api.listJobs.mockResolvedValue([]);
    api.listCronJobs.mockResolvedValue([]);
    const w = mountView();
    await flushPromises();
    api.listWorkloads.mockClear();
    await w
      .findAll("button")
      .find((b) => b.text().includes("Refresh workloads"))
      .trigger("click");
    await flushPromises();
    expect(api.listWorkloads).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
