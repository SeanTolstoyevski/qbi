package kube

import (
	"context"
	"fmt"
	"math"
	"sort"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// metricsOrErr returns the metrics clientset, or an error if not connected.
func (c *Client) metricsOrErr() (metricsclient.Interface, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.metrics == nil {
		return nil, fmt.Errorf("not connected to a cluster")
	}
	return c.metrics, nil
}

// NodeMetricsView returns live CPU/memory usage for every node plus a
// cluster-wide rollup. Capacity/allocatable come from the node objects; usage
// comes from the Metrics API (metrics-server). If metrics-server is not
// installed, MetricsAvailable is false and the usage fields are empty, so the
// UI degrades to capacity-only instead of failing the whole screen.
func (c *Client) NodeMetricsView(ctx context.Context) (NodeMetricsView, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return NodeMetricsView{}, err
	}
	mc, err := c.metricsOrErr()
	if err != nil {
		return NodeMetricsView{}, err
	}

	nodes, err := cs.CoreV1().Nodes().List(ctx, listOptions())
	if err != nil {
		return NodeMetricsView{}, err
	}

	view := NodeMetricsView{MetricsAvailable: true}
	usage := map[string]metricsv1beta1.NodeMetrics{}
	if ml, err := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{}); err != nil {
		view.MetricsAvailable = false
	} else {
		for i := range ml.Items {
			usage[ml.Items[i].Name] = ml.Items[i]
		}
	}

	// Totals are accumulated in canonical units (CPU in millicores, memory in
	// bytes) so the cluster rollup round-trips through the same formatters.
	var sumCapCPU, sumCapMem, sumAllocCPU, sumAllocMem, sumUsedCPU, sumUsedMem int64

	for i := range nodes.Items {
		n := &nodes.Items[i]
		var m *metricsv1beta1.NodeMetrics
		if um, ok := usage[n.Name]; ok {
			m = &um
		}
		view.Nodes = append(view.Nodes, summariseNodeMetric(n, m))

		if cap := n.Status.Capacity; cap != nil {
			if q, ok := cap[corev1.ResourceCPU]; ok {
				sumCapCPU += q.MilliValue()
			}
			if q, ok := cap[corev1.ResourceMemory]; ok {
				sumCapMem += q.Value()
			}
		}
		if alloc := n.Status.Allocatable; alloc != nil {
			if q, ok := alloc[corev1.ResourceCPU]; ok {
				sumAllocCPU += q.MilliValue()
			}
			if q, ok := alloc[corev1.ResourceMemory]; ok {
				sumAllocMem += q.Value()
			}
		}
		if m != nil {
			if q, ok := m.Usage[corev1.ResourceCPU]; ok {
				sumUsedCPU += q.MilliValue()
			}
			if q, ok := m.Usage[corev1.ResourceMemory]; ok {
				sumUsedMem += q.Value()
			}
		}
	}

	sort.Slice(view.Nodes, func(i, j int) bool { return view.Nodes[i].Name < view.Nodes[j].Name })

	view.Cluster = ClusterResources{
		Nodes:             len(view.Nodes),
		CPUCapacity:       resource.NewMilliQuantity(sumCapCPU, resource.DecimalSI).String(),
		CPUAllocatable:    resource.NewMilliQuantity(sumAllocCPU, resource.DecimalSI).String(),
		MemoryCapacity:    humanBytes(sumCapMem),
		MemoryAllocatable: humanBytes(sumAllocMem),
	}
	if view.MetricsAvailable {
		view.Cluster.CPUUsage = resource.NewMilliQuantity(sumUsedCPU, resource.DecimalSI).String()
		view.Cluster.CPUPercent = pct(sumUsedCPU, sumAllocCPU)
		view.Cluster.MemoryUsage = humanBytes(sumUsedMem)
		view.Cluster.MemoryPercent = pct(sumUsedMem, sumAllocMem)
	}

	return view, nil
}

// summariseNodeMetric combines a node's capacity/allocatable with its live
// usage from the Metrics API into a display DTO.
func summariseNodeMetric(n *corev1.Node, m *metricsv1beta1.NodeMetrics) NodeMetric {
	info := NodeMetric{Name: n.Name}

	var allocCPU, allocMem int64
	if cap := n.Status.Capacity; cap != nil {
		if q, ok := cap[corev1.ResourceCPU]; ok {
			info.CPUCapacity = q.String()
		}
		if q, ok := cap[corev1.ResourceMemory]; ok {
			info.MemoryCapacity = humanBytes(q.Value())
		}
	}
	if alloc := n.Status.Allocatable; alloc != nil {
		if q, ok := alloc[corev1.ResourceCPU]; ok {
			info.CPUAllocatable = q.String()
			allocCPU = q.MilliValue()
		}
		if q, ok := alloc[corev1.ResourceMemory]; ok {
			info.MemoryAllocatable = humanBytes(q.Value())
			allocMem = q.Value()
		}
	}

	if m != nil {
		if q, ok := m.Usage[corev1.ResourceCPU]; ok {
			info.CPUUsage = q.String()
			info.CPUPercent = pct(q.MilliValue(), allocCPU)
		}
		if q, ok := m.Usage[corev1.ResourceMemory]; ok {
			info.MemoryUsage = humanBytes(q.Value())
			info.MemoryPercent = pct(q.Value(), allocMem)
		}
	}
	return info
}

// PodMetrics returns the live CPU/memory usage of a single pod, together with
// the pod's CPU/memory requests and limits (empty when unset) so the user can
// judge headroom against the limits that matter. Requires the Metrics API.
func (c *Client) PodMetrics(ctx context.Context, namespace, pod string) (PodMetric, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return PodMetric{}, err
	}
	mc, err := c.metricsOrErr()
	if err != nil {
		return PodMetric{}, err
	}

	p, err := cs.CoreV1().Pods(namespace).Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return PodMetric{}, err
	}
	pm, err := mc.MetricsV1beta1().PodMetricses(namespace).Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return PodMetric{}, err
	}

	info := PodMetric{}

	// Aggregate requests/limits across the pod's containers.
	var reqCPU, reqMem, limCPU, limMem resource.Quantity
	for i := range p.Spec.Containers {
		r := &p.Spec.Containers[i].Resources
		if q, ok := r.Requests[corev1.ResourceCPU]; ok {
			reqCPU.Add(q)
		}
		if q, ok := r.Requests[corev1.ResourceMemory]; ok {
			reqMem.Add(q)
		}
		if q, ok := r.Limits[corev1.ResourceCPU]; ok {
			limCPU.Add(q)
		}
		if q, ok := r.Limits[corev1.ResourceMemory]; ok {
			limMem.Add(q)
		}
	}
	if !reqCPU.IsZero() {
		info.CPURequest = reqCPU.String()
	}
	if !limCPU.IsZero() {
		info.CPULimit = limCPU.String()
	}
	if !reqMem.IsZero() {
		info.MemoryRequest = humanBytes(reqMem.Value())
	}
	if !limMem.IsZero() {
		info.MemoryLimit = humanBytes(limMem.Value())
	}

	// Aggregate live usage across the pod's containers.
	var usedCPU, usedMem resource.Quantity
	for i := range pm.Containers {
		if q, ok := pm.Containers[i].Usage[corev1.ResourceCPU]; ok {
			usedCPU.Add(q)
		}
		if q, ok := pm.Containers[i].Usage[corev1.ResourceMemory]; ok {
			usedMem.Add(q)
		}
	}
	if !usedCPU.IsZero() {
		info.CPU = usedCPU.String()
	}
	if !usedMem.IsZero() {
		info.Memory = humanBytes(usedMem.Value())
	}

	return info, nil
}

// pct returns used/total as a percentage rounded to one decimal place.
func pct(used, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return math.Round(float64(used)/float64(total)*1000) / 10
}
