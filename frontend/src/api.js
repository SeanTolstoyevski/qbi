import * as ServiceBindings from "../wailsjs/go/main/Service.js";
import * as RuntimeBindings from "../wailsjs/runtime/runtime.js";

const Service = ServiceBindings.default ?? ServiceBindings;
const EventsOn = RuntimeBindings.EventsOn ?? RuntimeBindings.default?.EventsOn;
const EventsOff =
  RuntimeBindings.EventsOff ?? RuntimeBindings.default?.EventsOff;

// Map low-level Go/Kubernetes error strings to short, actionable messages.
// Raw client-go errors ("Forbidden", "context deadline exceeded") are cryptic
// for a screen-reader user and generate support noise.
function friendlyError(e) {
  const msg = String(e?.message ?? e ?? "");
  const low = msg.toLowerCase();
  if (/forbidden|unauthorized/.test(low)) {
    return "You don't have permission to access this resource. Check your cluster role.";
  }
  if (/context deadline exceeded|deadline exceeded/.test(low)) {
    return "The request timed out. The cluster may be slow or unreachable.";
  }
  if (
    /connection refused|no such host|network is unreachable|dial tcp/.test(low)
  ) {
    return "Cannot reach the cluster. Check your connection.";
  }
  if (/not found|doesn't exist|does not exist/.test(low)) {
    return "The resource was not found. It may have been deleted.";
  }
  if (/metrics-server|metrics.*not available/.test(low)) {
    return "Live usage metrics are unavailable (metrics-server not installed or starting).";
  }
  return msg;
}

// Wrap one generated binding so every caller gets friendly errors from this
// single choke point instead of each component mapping raw strings.
function wrap(fn) {
  return (...args) => {
    // In a plain browser (vite dev without the Wails shell) bindings exist
    // but would throw a cryptic TypeError on the first call.
    if (!window.go?.main?.Service) {
      return Promise.reject(
        new Error(
          "Wails bindings are not available. Run the app with `wails dev`.",
        ),
      );
    }
    return Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => {
        throw new Error(friendlyError(e));
      });
  };
}

// camelCase aliases over the generated PascalCase bindings; this is the
// stable surface components import. Adding a backend method = one line.
export const api = {
  kubeconfig: wrap(Service.Kubeconfig),
  selectKubeconfig: wrap(Service.SelectKubeconfig),
  setKubeconfig: wrap(Service.SetKubeconfig),
  listContexts: wrap(Service.ListContexts),
  connect: wrap(Service.Connect),
  listNamespaces: wrap(Service.ListNamespaces),
  deleteNamespace: wrap(Service.DeleteNamespace),
  listNodes: wrap(Service.ListNodes),
  listNodeMetrics: wrap(Service.ListNodeMetrics),
  getPodMetrics: wrap(Service.GetPodMetrics),
  listPods: wrap(Service.ListPods),
  deletePod: wrap(Service.DeletePod),
  getPod: wrap(Service.GetPod),
  getPodNetworkFiles: wrap(Service.GetPodNetworkFiles),
  openShell: wrap(Service.OpenShell),
  listSecrets: wrap(Service.ListSecrets),
  getSecret: wrap(Service.GetSecret),
  updateSecret: wrap(Service.UpdateSecret),
  createSecret: wrap(Service.CreateSecret),
  deleteSecret: wrap(Service.DeleteSecret),
  getSecretYaml: wrap(Service.GetSecretYAML),
  createSecretFromYaml: wrap(Service.CreateSecretFromYAML),
  updateSecretFromYaml: wrap(Service.UpdateSecretFromYAML),
  listServices: wrap(Service.ListServices),
  createService: wrap(Service.CreateService),
  deleteService: wrap(Service.DeleteService),
  renderServiceYaml: wrap(Service.RenderServiceYAML),
  listIngresses: wrap(Service.ListIngresses),
  getIngressDetail: wrap(Service.IngressDetail),
  deleteIngress: wrap(Service.DeleteIngress),
  listIngressClasses: wrap(Service.ListIngressClasses),
  renderIngressYaml: wrap(Service.RenderIngressYAML),
  createIngress: wrap(Service.CreateIngress),
  ingressEdit: wrap(Service.IngressEdit),
  updateIngress: wrap(Service.UpdateIngress),
  listEvents: wrap(Service.ListEvents),
  history: wrap(Service.History),
  listConfigMaps: wrap(Service.ListConfigMaps),
  getConfigMap: wrap(Service.GetConfigMap),
  listWorkloads: wrap(Service.ListWorkloads),
  createDeployment: wrap(Service.CreateDeployment),
  renderDeploymentYaml: wrap(Service.RenderDeploymentYAML),
  listJobs: wrap(Service.ListJobs),
  listCronJobs: wrap(Service.ListCronJobs),
  getCronJobDetail: wrap(Service.GetCronJobDetail),
  createCronJob: wrap(Service.CreateCronJob),
  updateCronJob: wrap(Service.UpdateCronJob),
  restartWorkload: wrap(Service.RestartWorkload),
  deleteWorkload: wrap(Service.DeleteWorkload),
  scaleWorkload: wrap(Service.ScaleWorkload),
  getResourceYaml: wrap(Service.GetResourceYAML),
  startLogStream: wrap(Service.StartLogStream),
  stopLogStream: wrap(Service.StopLogStream),
  saveLogs: wrap(Service.SaveLogs),
  getSettings: wrap(Service.GetSettings),
  acknowledgeWelcome: wrap(Service.AcknowledgeWelcome),
  setAutoRefresh: wrap(Service.SetAutoRefresh),
  setExperimental: wrap(Service.SetExperimental),
  setWatchNamespace: wrap(Service.SetWatchNamespace),
  buildInfo: wrap(Service.BuildInfo),
};

export function onEvent(name, handler) {
  // Without the Wails shell the generated binding throws; return a no-op
  // unsubscribe so callers can still pair on/off.
  try {
    EventsOn(name, handler);
    return () => EventsOff(name);
  } catch {
    return () => {};
  }
}
