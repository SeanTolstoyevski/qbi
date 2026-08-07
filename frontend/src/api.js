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

function service() {
  const svc = window.go?.main?.Service;
  if (!svc) {
    throw new Error(
      "Wails bindings are not available. Run the app with `wails dev`.",
    );
  }
  // Wrap every Wails method once so all callers get friendly errors from this
  // single choke point instead of each component mapping raw strings.
  if (!svc.__qbiWrapped) {
    for (const key of Object.keys(svc)) {
      if (typeof svc[key] === "function") {
        const original = svc[key];
        svc[key] = (...args) =>
          Promise.resolve()
            .then(() => original(...args))
            .catch((e) => {
              throw new Error(friendlyError(e));
            });
      }
    }
    svc.__qbiWrapped = true;
  }
  return svc;
}

export const api = {
  kubeconfig: () => service().Kubeconfig(),
  selectKubeconfig: () => service().SelectKubeconfig(),
  setKubeconfig: (path) => service().SetKubeconfig(path),
  listContexts: () => service().ListContexts(),
  connect: (contextName) => service().Connect(contextName),
  listNamespaces: () => service().ListNamespaces(),
  deleteNamespace: (name) => service().DeleteNamespace(name),
  listNodes: () => service().ListNodes(),
  listNodeMetrics: () => service().ListNodeMetrics(),
  getPodMetrics: (namespace, pod) => service().GetPodMetrics(namespace, pod),
  listPods: (namespace) => service().ListPods(namespace),
  deletePod: (namespace, name) => service().DeletePod(namespace, name),
  getPod: (namespace, name) => service().GetPod(namespace, name),
  openShell: (namespace, pod, container) =>
    service().OpenShell(namespace, pod, container),
  listSecrets: (namespace) => service().ListSecrets(namespace),
  getSecret: (namespace, name) => service().GetSecret(namespace, name),
  updateSecret: (namespace, name, changes, mode) =>
    service().UpdateSecret(namespace, name, changes, mode),
  createSecret: (namespace, spec, mode) =>
    service().CreateSecret(namespace, spec, mode),
  deleteSecret: (namespace, name) => service().DeleteSecret(namespace, name),
  getSecretYaml: (namespace, name, transparent) =>
    service().GetSecretYAML(namespace, name, transparent),
  createSecretFromYaml: (namespace, yaml) =>
    service().CreateSecretFromYAML(namespace, yaml),
  updateSecretFromYaml: (namespace, name, yaml) =>
    service().UpdateSecretFromYAML(namespace, name, yaml),
  listServices: (namespace) => service().ListServices(namespace),
  createService: (namespace, spec) => service().CreateService(namespace, spec),
  deleteService: (namespace, name) => service().DeleteService(namespace, name),
  renderServiceYaml: (namespace, spec) =>
    service().RenderServiceYAML(namespace, spec),
  listIngresses: (namespace) => service().ListIngresses(namespace),
  getIngressDetail: (namespace, name) =>
    service().IngressDetail(namespace, name),
  deleteIngress: (namespace, name) => service().DeleteIngress(namespace, name),
  listIngressClasses: () => service().ListIngressClasses(),
  renderIngressYaml: (namespace, spec) =>
    service().RenderIngressYAML(namespace, spec),
  createIngress: (namespace, spec) => service().CreateIngress(namespace, spec),
  ingressEdit: (namespace, name) => service().IngressEdit(namespace, name),
  updateIngress: (namespace, name, spec) =>
    service().UpdateIngress(namespace, name, spec),
  listEvents: (namespace) => service().ListEvents(namespace),
  history: (namespace, options) => service().History(namespace, options),
  listConfigMaps: (namespace) => service().ListConfigMaps(namespace),
  getConfigMap: (namespace, name) => service().GetConfigMap(namespace, name),
  listWorkloads: (namespace) => service().ListWorkloads(namespace),
  createDeployment: (namespace, spec) =>
    service().CreateDeployment(namespace, spec),
  renderDeploymentYaml: (namespace, spec) =>
    service().RenderDeploymentYAML(namespace, spec),
  listJobs: (namespace) => service().ListJobs(namespace),
  listCronJobs: (namespace) => service().ListCronJobs(namespace),
  getCronJobDetail: (namespace, name) =>
    service().GetCronJobDetail(namespace, name),
  createCronJob: (namespace, spec) => service().CreateCronJob(namespace, spec),
  updateCronJob: (namespace, name, update) =>
    service().UpdateCronJob(namespace, name, update),
  restartWorkload: (namespace, kind, name) =>
    service().RestartWorkload(namespace, kind, name),
  deleteWorkload: (namespace, kind, name) =>
    service().DeleteWorkload(namespace, kind, name),
  scaleWorkload: (namespace, kind, name, replicas) =>
    service().ScaleWorkload(namespace, kind, name, replicas),
  getResourceYaml: (namespace, kind, name) =>
    service().GetResourceYAML(namespace, kind, name),
  startLogStream: (namespace, pod, container, options) =>
    service().StartLogStream(namespace, pod, container, options),
  stopLogStream: (key) => service().StopLogStream(key),
  saveLogs: (suggestedName, content) =>
    service().SaveLogs(suggestedName, content),
  getSettings: () => service().GetSettings(),
  setAutoRefresh: (enabled) => service().SetAutoRefresh(enabled),
  setWatchNamespace: (namespace) => service().SetWatchNamespace(namespace),
  version: () => service().Version(),
  commit: () => service().Commit(),
};

// Subscribe to a Wails runtime event. Returns an unsubscribe function.
export function onEvent(name, handler) {
  const rt = window.runtime;
  if (!rt?.EventsOn) {
    return () => {};
  }
  rt.EventsOn(name, handler);
  return () => rt.EventsOff(name);
}
