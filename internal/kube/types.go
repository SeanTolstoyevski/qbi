package kube

// ContextInfo describes a single kubeconfig context the user can connect to.
type ContextInfo struct {
	Name      string `json:"name"`
	Cluster   string `json:"cluster"`
	User      string `json:"user"`
	Namespace string `json:"namespace"`
	Current   bool   `json:"current"`
}

// NamespaceInfo is a lightweight view of a Kubernetes namespace.
type NamespaceInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Age    string `json:"age"`
}

// PodInfo is a lightweight view of a Kubernetes pod.
type PodInfo struct {
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	Phase      string   `json:"phase"`
	Ready      string   `json:"ready"`
	Restarts   int32    `json:"restarts"`
	Age        string   `json:"age"`
	Node       string   `json:"node"`
	Owner      string   `json:"owner"` // e.g. "ReplicaSet/my-deploy-6f8c", empty for bare pods
	Containers []string `json:"containers"`
}

// ContainerStatusInfo summarises a single container's runtime state.
type ContainerStatusInfo struct {
	Name         string `json:"name"`
	Image        string `json:"image"`
	Ready        bool   `json:"ready"`
	RestartCount int32  `json:"restartCount"`
	State        string `json:"state"`        // Running | Waiting | Terminated
	StateReason  string `json:"stateReason"`  // e.g. CrashLoopBackOff, OOMKilled
	StateMessage string `json:"stateMessage"` // extra detail when present
}

// PodConditionInfo is a single pod condition (e.g. Ready, PodScheduled).
type PodConditionInfo struct {
	Type   string `json:"type"`
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// PodDetail is the full "describe" view of a pod.
type PodDetail struct {
	Name        string                `json:"name"`
	Namespace   string                `json:"namespace"`
	Phase       string                `json:"phase"`
	Node        string                `json:"node"`
	PodIP       string                `json:"podIP"`
	HostIP      string                `json:"hostIP"`
	ServiceAcct string                `json:"serviceAccount"`
	QOSClass    string                `json:"qosClass"`
	Age         string                `json:"age"`
	Labels      map[string]string     `json:"labels"`
	Ports       []int32               `json:"ports"` // container ports (deduped, sorted)
	Conditions  []PodConditionInfo    `json:"conditions"`
	Containers  []ContainerStatusInfo `json:"containers"`
}

// PodNetworkFiles is the pod's own DNS view: the two files that decide how
// the container resolves names — /etc/hosts (static aliases, e.g.
// `10.0.0.5 abc.ofb.local`) and /etc/resolv.conf (DNS servers and search
// domains). Per-file errors are folded in so one unreadable file never hides
// the other.
type PodNetworkFiles struct {
	Container       string `json:"container"`
	Hosts           string `json:"hosts"`
	HostsError      string `json:"hostsError"`
	ResolvConf      string `json:"resolvConf"`
	ResolvConfError string `json:"resolvConfError"`
}

// SecretInfo is a lightweight view of a Kubernetes secret (no values).
type SecretInfo struct {
	Name string   `json:"name"`
	Type string   `json:"type"`
	Keys []string `json:"keys"`
	Age  string   `json:"age"`
}

// SecretEntry is a single key/value pair from a secret. Value is the decoded
// UTF-8 text (empty for binary values); Base64 is the raw base64 of the stored
// bytes, which is what the UI shows in base64 mode and what makes binary
// values viewable at all.
type SecretEntry struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Base64   string `json:"base64"`
	IsBinary bool   `json:"isBinary"`
}

// WatchEvent is emitted by the Watcher whenever a Kubernetes resource changes.
// It carries just enough information for the frontend to announce the change
// and decide which view to refresh; the view then re-fetches the full list.
type WatchEvent struct {
	// Type is one of "ADDED", "MODIFIED", or "DELETED".
	Type      string `json:"type"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"` // empty for cluster-scoped resources
}

// SecretDetail contains the contents of a single secret.
type SecretDetail struct {
	Name    string        `json:"name"`
	Type    string        `json:"type"`
	Entries []SecretEntry `json:"entries"`
}

// SecretCreate is the form-spec for creating a secret. Data maps key names to
// values in the mode the UI is in: decoded text in transparent mode, raw
// base64 in base64 mode. The client encodes/validates before storing.
type SecretCreate struct {
	Name string            `json:"name"`
	Type string            `json:"type"`
	Data map[string]string `json:"data"`
}

// ServicePort describes one port exposed by a service.
type ServicePort struct {
	Name       string `json:"name"`
	Protocol   string `json:"protocol"`
	Port       int32  `json:"port"`
	TargetPort string `json:"targetPort"`
	NodePort   int32  `json:"nodePort"`
}

// ServiceInfo is a view of a Kubernetes service, including its in-cluster DNS
// name and the pod IPs (endpoints) currently backing it.
type ServiceInfo struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Type        string            `json:"type"`
	ClusterIP   string            `json:"clusterIP"`
	ExternalIPs []string          `json:"externalIPs"`
	DNSName     string            `json:"dnsName"`
	Ports       []ServicePort     `json:"ports"`
	Selector    map[string]string `json:"selector"`
	Endpoints   []string          `json:"endpoints"`
	Age         string            `json:"age"`
}

// IngressPath is a single path rule routing to a backend service, enriched
// with a health status so the user can see at a glance whether the backend is
// currently usable. Status is one of:
//   - "ok":           the target service exists and has ready endpoints
//   - "no-service":   the target service does not exist in this namespace
//   - "no-endpoints": the target service exists but has no ready endpoints
//   - "unknown":      health could not be checked (RBAC or API error)
type IngressPath struct {
	Path           string `json:"path"`
	PathType       string `json:"pathType"`
	ServiceName    string `json:"serviceName"`
	ServicePort    string `json:"servicePort"`
	Status         string `json:"status"`
	ReadyEndpoints int    `json:"readyEndpoints"`
}

// IngressBackend is a default-backend reference (no host/path), with the same
// health status vocabulary as IngressPath.
type IngressBackend struct {
	ServiceName    string `json:"serviceName"`
	ServicePort    string `json:"servicePort"`
	Status         string `json:"status"`
	ReadyEndpoints int    `json:"readyEndpoints"`
}

// IngressTLS is one TLS block of an ingress: the hosts it covers and the
// secret holding the certificate, plus whether that secret actually exists in
// the namespace (a missing secret is the classic cause of TLS failures).
type IngressTLS struct {
	Hosts        []string `json:"hosts"`
	SecretName   string   `json:"secretName"`
	SecretStatus string   `json:"secretStatus"` // ok | missing | unknown
}

// IngressRule groups the paths served for a given host.
type IngressRule struct {
	Host  string        `json:"host"`
	Paths []IngressPath `json:"paths"`
}

// IngressInfo is a view of a Kubernetes ingress: its addresses, TLS entries,
// routing rules and a plain-language list of problems worth looking at. All
// addresses are kept (an ingress can be backed by several load balancer
// entries), and TLS secrets/backend services are checked for existence so the
// list can warn before the user opens the detail view.
type IngressInfo struct {
	Name           string            `json:"name"`
	Namespace      string            `json:"namespace"`
	Class          string            `json:"class"`
	Addresses      []string          `json:"addresses"`
	TLS            []IngressTLS      `json:"tls"`
	Rules          []IngressRule     `json:"rules"`
	DefaultBackend *IngressBackend   `json:"defaultBackend"`
	Annotations    map[string]string `json:"annotations"`
	Issues         []string          `json:"issues"`
	Age            string            `json:"age"`
}

// IngressDetail is the full inspection view of one ingress: the enriched
// ingress plus the events referencing it (most recent first). Events are a
// best-effort bonus — if the events list is not readable (RBAC), the ingress
// info still loads and EventsError explains why the list is empty.
type IngressDetail struct {
	Ingress     IngressInfo `json:"ingress"`
	Events      []EventInfo `json:"events"`
	EventsError string      `json:"eventsError"`
}

// EventInfo is a view of a Kubernetes event, used for debugging why resources
// are (or are not) behaving as expected.
type EventInfo struct {
	Type      string `json:"type"`   // Normal | Warning
	Reason    string `json:"reason"` // e.g. BackOff, FailedScheduling
	Object    string `json:"object"` // "Kind/name" the event is about
	Message   string `json:"message"`
	Count     int32  `json:"count"`
	Component string `json:"component"` // reporting component
	LastSeen  string `json:"lastSeen"`  // human-readable age of last occurrence
	FirstSeen string `json:"firstSeen"`
}

// HistoryOptions controls how much rollout history is returned. The user
// chooses the breadth (MaxDeployments) and depth (RevisionsPerDeploy); the
// backend applies their choices on top of the project-wide list safety valve
// (maxListItems). A zero value means "no additional cap" — still bounded by
// the list limit, never by hidden app logic.
type HistoryOptions struct {
	MaxDeployments     int    `json:"maxDeployments"`
	RevisionsPerDeploy int    `json:"revisionsPerDeploy"`
	Filter             string `json:"filter"` // substring match on Deployment name
}

// NamespaceHistory is durable activity in a namespace, derived from resources
// that persist. Events are garbage-collected by the API server after roughly
// an hour, so they cannot answer "what changed here" retrospectively; this
// payload fills that gap with signals that survive.
type NamespaceHistory struct {
	Rollouts []RolloutInfo `json:"rollouts"` // Deployment rollout history
	Total    int           `json:"total"`    // matching Deployments before the deployment cap
}

// RolloutInfo describes a Deployment and its rollout history. Every change to
// a Deployment (including a rolling restart) makes the controller create a new
// ReplicaSet carrying an incremented revision annotation, and old ReplicaSets
// are retained — so the revisions list is a durable record of every deploy
// that was triggered in this namespace.
type RolloutInfo struct {
	Name     string         `json:"name"`
	Revision string         `json:"revision"` // current revision
	Rollouts []RevisionInfo `json:"rollouts"` // newest first
}

// RevisionInfo is one historical rollout of a Deployment.
type RevisionInfo struct {
	Revision string `json:"revision"`
	Age      string `json:"age"` // human-readable age of the ReplicaSet
}

// WorkloadRevision is one point in a workload's rollout history: the pod
// template the controller ran at that revision, plus the context needed to
// tell revisions apart (images, change cause, age). Deployments keep their
// history in ReplicaSets; StatefulSets and DaemonSets keep theirs in
// ControllerRevisions.
type WorkloadRevision struct {
	Revision    int64    `json:"revision"`
	Images      []string `json:"images"`
	ChangeCause string   `json:"changeCause"` // kubernetes.io/change-cause, if recorded
	Age         string   `json:"age"`         // human-readable age of the history object
	Current     bool     `json:"current"`     // true for the template the controller runs now
	Replicas    string   `json:"replicas"`    // Deployments only: ReplicaSet ready/desired
}

// RollbackResult reports the outcome of a rollback request. Applied is true
// when the pod template was restored; Skipped is true when the target
// revision's template already matched the current one (kubectl reports the
// same as a skipped rollback) — the request was accepted but changed nothing.
// Both false means the user cancelled the confirmation dialog. A struct keeps
// the three outcomes distinguishable across the Wails binding, which cannot
// express a third return value.
type RollbackResult struct {
	Applied bool `json:"applied"`
	Skipped bool `json:"skipped"`
}

// ConfigMapInfo is a lightweight view of a ConfigMap (keys only).
type ConfigMapInfo struct {
	Name string   `json:"name"`
	Keys []string `json:"keys"`
	Age  string   `json:"age"`
}

// ConfigMapEntry is a single key/value pair from a ConfigMap.
type ConfigMapEntry struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsBinary bool   `json:"isBinary"`
}

// ConfigMapDetail contains the full contents of a single ConfigMap.
type ConfigMapDetail struct {
	Name    string           `json:"name"`
	Entries []ConfigMapEntry `json:"entries"`
}

// JobInfo summarises a Kubernetes Job — a finite workload that runs to
// completion rather than continuously like a Deployment.
type JobInfo struct {
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	Completions string `json:"completions"` // "succeeded/total" or "succeeded" if no limit
	Active      int32  `json:"active"`
	Failed      int32  `json:"failed"`
	Status      string `json:"status"` // Complete | Running | Failed | Suspended
	Age         string `json:"age"`
}

// CronJobInfo summarises a Kubernetes CronJob.
type CronJobInfo struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	Schedule          string `json:"schedule"`
	Suspended         bool   `json:"suspended"`
	Active            int32  `json:"active"`
	LastSchedule      string `json:"lastSchedule"` // human-readable, empty if never
	Age               string `json:"age"`
	Image             string `json:"image"`             // first container image
	ConcurrencyPolicy string `json:"concurrencyPolicy"` // Allow | Forbid | Replace
}

// CronJobUpdate carries the editable fields of a CronJob. Pointer fields keep
// "not sent" (nil) distinct from "set to empty/false", so the frontend only
// sends what the user changed.
type CronJobUpdate struct {
	Schedule          *string `json:"schedule"`
	Suspend           *bool   `json:"suspend"`
	ConcurrencyPolicy *string `json:"concurrencyPolicy"`
}

// CronJobCreate is the minimal spec needed to create a CronJob.
type CronJobCreate struct {
	Name              string   `json:"name"`
	Schedule          string   `json:"schedule"`
	Image             string   `json:"image"`
	Command           []string `json:"command"`
	Suspend           bool     `json:"suspend"`
	ConcurrencyPolicy string   `json:"concurrencyPolicy"` // Allow | Forbid | Replace; empty = Allow
}

// CronJobDetail is a CronJob plus its recent runs, so the UI can show "what
// ran when" and stream the logs of any run's pod. CronJobs themselves have no
// logs — they create Jobs, which create Pods — so the run/pod trail is the
// only way to inspect them like pods.
type CronJobDetail struct {
	Name              string   `json:"name"`
	Schedule          string   `json:"schedule"`
	Suspended         bool     `json:"suspended"`
	ConcurrencyPolicy string   `json:"concurrencyPolicy"`
	Image             string   `json:"image"`
	LastSchedule      string   `json:"lastSchedule"`
	Runs              []JobRun `json:"runs"` // newest first
}

// JobRun is one Job created by a CronJob, with the pods it produced.
type JobRun struct {
	Name   string   `json:"name"`
	Status string   `json:"status"` // Complete | Running | Failed | Suspended
	Age    string   `json:"age"`
	Pods   []PodRef `json:"pods"`
}

// PodRef identifies a pod and its containers for log streaming.
type PodRef struct {
	Name       string   `json:"name"`
	Containers []string `json:"containers"`
}

// PortForwardStatus is the live state of one port-forward session, emitted to
// the frontend on every transition and returned by the listing call. State is
// one of "starting", "active", "stopped" or "failed"; Error is set only when
// the forward failed. LocalPort is always the resolved port (0 becomes a
// picked free port), so the UI can show 127.0.0.1:LocalPort immediately.
type PortForwardStatus struct {
	ID         string `json:"id"`
	Namespace  string `json:"namespace"`
	Pod        string `json:"pod"`
	LocalPort  int    `json:"localPort"`
	RemotePort int    `json:"remotePort"`
	State      string `json:"state"`
	Error      string `json:"error"`
}

// DeploymentCreate is the user-facing spec for creating a Deployment. The UI
// form fills it, the backend turns it into a real Deployment manifest (which
// can also be previewed as YAML). The most useful subset of a Deployment is
// exposed; anything else is reachable through YAML.
type DeploymentCreate struct {
	Name            string             `json:"name"`
	Image           string             `json:"image"`
	Command         []string           `json:"command"` // overrides ENTRYPOINT
	Args            []string           `json:"args"`    // overrides CMD
	Replicas        int32              `json:"replicas"`
	Port            int32              `json:"port"` // 0 = no port exposed
	Protocol        string             `json:"protocol"`
	Labels          map[string]string  `json:"labels"`
	Env             []DeploymentEnvVar `json:"env"`
	Resources       ResourceSpec       `json:"resources"`
	ImagePullPolicy string             `json:"imagePullPolicy"` // Always | IfNotPresent | Never; empty = cluster default
	UpdateStrategy  string             `json:"updateStrategy"`  // RollingUpdate | Recreate; empty = cluster default
	NodeSelector    map[string]string  `json:"nodeSelector"`
}

// DeploymentEnvVar is one environment variable for the created container.
type DeploymentEnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ResourceSpec carries the CPU/memory requests and limits, in Kubernetes
// quantity format (e.g. "100m", "128Mi", "1Gi"). Empty means "not set".
type ResourceSpec struct {
	CPURequest    string `json:"cpuRequest"`
	MemoryRequest string `json:"memoryRequest"`
	CPULimit      string `json:"cpuLimit"`
	MemoryLimit   string `json:"memoryLimit"`
}

// ServiceCreate is the user-facing spec for creating a Service, so pods (e.g.
// a Deployment's pods) can be exposed. The user chooses everything — type,
// selector, ports, node ports, affinity, IPs; nothing is inferred.
type ServiceCreate struct {
	Name            string              `json:"name"`
	Type            string              `json:"type"` // ClusterIP | NodePort | LoadBalancer; empty = ClusterIP
	Selector        map[string]string   `json:"selector"`
	Ports           []ServicePortCreate `json:"ports"`
	SessionAffinity string              `json:"sessionAffinity"` // None | ClientIP; empty = None
	ClusterIP       string              `json:"clusterIP"`       // empty = auto-assigned
	ExternalIPs     []string            `json:"externalIPs"`
}

// ServicePortCreate is one port mapping of a Service.
type ServicePortCreate struct {
	Name       string `json:"name"`
	Port       int32  `json:"port"`       // the Service's port
	TargetPort string `json:"targetPort"` // number or named port; empty = same as Port
	Protocol   string `json:"protocol"`   // TCP | UDP | SCTP; empty = TCP
	NodePort   int32  `json:"nodePort"`   // 0 = cluster-assigned (NodePort/LoadBalancer)
}

// IngressPathCreate is one HTTP path rule of an Ingress: which path on the
// host is routed to which service. ServicePort is a number (1-65535) or a
// named port (IANA service name); the backend parses and validates it.
type IngressPathCreate struct {
	Path        string `json:"path"`        // must start with "/"; "/" is the root
	PathType    string `json:"pathType"`    // Prefix | Exact | ImplementationSpecific
	ServiceName string `json:"serviceName"` // backend service in this namespace
	ServicePort string `json:"servicePort"` // number or named port of that service
}

// IngressRuleCreate groups the paths served for one host. An empty host
// means "all hosts".
type IngressRuleCreate struct {
	Host  string              `json:"host"`
	Paths []IngressPathCreate `json:"paths"`
}

// IngressTLSCreate is one TLS block: the hosts it covers (empty means all
// hosts) and the secret holding the certificate (empty means the controller
// default certificate).
type IngressTLSCreate struct {
	Hosts      []string `json:"hosts"`
	SecretName string   `json:"secretName"`
}

// IngressBackendCreate is the optional catch-all backend served for requests
// that match no host/path rule.
type IngressBackendCreate struct {
	ServiceName string `json:"serviceName"`
	ServicePort string `json:"servicePort"`
}

// IngressCreate is the user-facing spec for creating an Ingress. The user
// chooses everything — class, host rules, TLS, default backend, annotations,
// labels; nothing is inferred. The backend turns it into a real Ingress
// manifest (which can also be previewed as YAML before applying).
type IngressCreate struct {
	Name             string                `json:"name"`
	IngressClassName string                `json:"ingressClassName"` // empty = cluster default
	Rules            []IngressRuleCreate   `json:"rules"`
	TLS              []IngressTLSCreate    `json:"tls"`
	DefaultBackend   *IngressBackendCreate `json:"defaultBackend"` // nil = no catch-all
	Annotations      map[string]string     `json:"annotations"`
	Labels           map[string]string     `json:"labels"`
}

// IngressEditSpec is the load-into-form view of an existing Ingress: the
// fields the form owns, plus a list of constructs the form cannot express
// (e.g. a path with a resource backend instead of a service). Unsupported
// entries are still mapped into the form (with empty service fields) so the
// user must explicitly resolve them — fill in a service or remove the row —
// before saving; nothing is dropped silently.
type IngressEditSpec struct {
	Spec        IngressCreate `json:"spec"`
	Unsupported []string      `json:"unsupported"`
}

// NodeInfo is a cluster-scoped view of a Kubernetes node. Kept flat and
// summary-oriented: enough to spot an unhealthy or cordoned node at a glance.
type NodeInfo struct {
	Name         string   `json:"name"`
	Status       string   `json:"status"`      // Ready | NotReady | Unknown
	Schedulable  bool     `json:"schedulable"` // false when cordoned
	Roles        []string `json:"roles"`       // e.g. control-plane, worker
	Version      string   `json:"version"`     // kubelet version
	OSImage      string   `json:"osImage"`     // node OS image
	Architecture string   `json:"architecture"`
	InternalIP   string   `json:"internalIP"`
	CPU          string   `json:"cpu"`        // allocatable CPU (cores)
	Memory       string   `json:"memory"`     // allocatable memory (human-readable)
	Pods         string   `json:"pods"`       // allocatable pod capacity
	Conditions   []string `json:"conditions"` // active pressure conditions
	Age          string   `json:"age"`
}

// NodeMetric is the live CPU/memory usage of a single node alongside its
// capacity and allocatable. Usage fields are empty when the Metrics API is
// unavailable.
type NodeMetric struct {
	Name              string  `json:"name"`
	CPUCapacity       string  `json:"cpuCapacity"`
	CPUAllocatable    string  `json:"cpuAllocatable"`
	CPUUsage          string  `json:"cpuUsage"`
	CPUPercent        float64 `json:"cpuPercent"`
	MemoryCapacity    string  `json:"memoryCapacity"`
	MemoryAllocatable string  `json:"memoryAllocatable"`
	MemoryUsage       string  `json:"memoryUsage"`
	MemoryPercent     float64 `json:"memoryPercent"`
}

// ClusterResources is a cluster-wide rollup of node capacity and usage,
// equivalent to what `kubectl top nodes` aggregates.
type ClusterResources struct {
	Nodes             int     `json:"nodes"`
	CPUCapacity       string  `json:"cpuCapacity"`
	CPUAllocatable    string  `json:"cpuAllocatable"`
	CPUUsage          string  `json:"cpuUsage"`
	CPUPercent        float64 `json:"cpuPercent"`
	MemoryCapacity    string  `json:"memoryCapacity"`
	MemoryAllocatable string  `json:"memoryAllocatable"`
	MemoryUsage       string  `json:"memoryUsage"`
	MemoryPercent     float64 `json:"memoryPercent"`
}

// NodeMetricsView is the cluster resource screen payload: per-node metrics
// plus a cluster-wide rollup. MetricsAvailable is false when metrics-server is
// not installed, in which case the usage fields are empty.
type NodeMetricsView struct {
	Nodes            []NodeMetric     `json:"nodes"`
	Cluster          ClusterResources `json:"cluster"`
	MetricsAvailable bool             `json:"metricsAvailable"`
}

// PodMetric is the live CPU/memory usage of a single pod, plus its requests
// and limits (empty when unset) so headroom is visible at a glance.
type PodMetric struct {
	CPU           string `json:"cpu"`
	Memory        string `json:"memory"`
	CPURequest    string `json:"cpuRequest"`
	CPULimit      string `json:"cpuLimit"`
	MemoryRequest string `json:"memoryRequest"`
	MemoryLimit   string `json:"memoryLimit"`
}

// WorkloadInfo is a view of a workload controller (Deployment, StatefulSet,
// DaemonSet). Replica fields are expressed as strings so DaemonSets (which use
// scheduled/desired counts) fit the same shape.
type WorkloadInfo struct {
	Kind      string   `json:"kind"`
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Ready     string   `json:"ready"` // e.g. "3/3"
	Replicas  int32    `json:"replicas"`
	UpToDate  int32    `json:"upToDate"`
	Available int32    `json:"available"`
	Images    []string `json:"images"`
	Age       string   `json:"age"`
}

// WorkloadsView is the workload screen payload: controllers plus per-kind load
// errors, so a resource type the user cannot read (RBAC) degrades gracefully
// instead of failing the whole screen.
type WorkloadsView struct {
	Workloads []WorkloadInfo `json:"workloads"`
	Errors    []string       `json:"errors"` // e.g. "StatefulSets: Forbidden"
}
