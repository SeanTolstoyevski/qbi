package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// Nodes returns the cluster's nodes with a summarised health, role and capacity
// view. Nodes are cluster-scoped, so this call ignores the selected namespace.
func (c *Client) Nodes(ctx context.Context) ([]NodeInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Nodes().List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	out := make([]NodeInfo, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, summariseNode(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// summariseNode flattens a node into the display DTO.
func summariseNode(n *corev1.Node) NodeInfo {
	info := NodeInfo{
		Name:         n.Name,
		Status:       "Unknown",
		Schedulable:  !n.Spec.Unschedulable,
		Roles:        nodeRoles(n),
		Version:      n.Status.NodeInfo.KubeletVersion,
		OSImage:      n.Status.NodeInfo.OSImage,
		Architecture: n.Status.NodeInfo.Architecture,
		InternalIP:   nodeInternalIP(n),
		Age:          age(n.CreationTimestamp),
	}

	// Overall readiness comes from the Ready condition; any active pressure
	// condition is surfaced so a degraded node is obvious at a glance.
	for i := range n.Status.Conditions {
		cond := &n.Status.Conditions[i]
		switch cond.Type {
		case corev1.NodeReady:
			if cond.Status == corev1.ConditionTrue {
				info.Status = "Ready"
			} else {
				info.Status = "NotReady"
			}
		case corev1.NodeMemoryPressure, corev1.NodeDiskPressure, corev1.NodePIDPressure, corev1.NodeNetworkUnavailable:
			if cond.Status == corev1.ConditionTrue {
				info.Conditions = append(info.Conditions, string(cond.Type))
			}
		}
	}

	// Allocatable reflects what the scheduler can actually place, which is more
	// useful than raw capacity when judging headroom.
	if alloc := n.Status.Allocatable; alloc != nil {
		if cpu, ok := alloc[corev1.ResourceCPU]; ok {
			info.CPU = cpu.String()
		}
		if mem, ok := alloc[corev1.ResourceMemory]; ok {
			info.Memory = humanBytes(mem.Value())
		}
		if pods, ok := alloc[corev1.ResourcePods]; ok {
			info.Pods = pods.String()
		}
	}

	return info
}

// nodeRoles extracts role names from the standard node-role.kubernetes.io/<role>
// labels. A node with no such label is reported as "worker".
func nodeRoles(n *corev1.Node) []string {
	const prefix = "node-role.kubernetes.io/"
	roles := []string{}
	for label := range n.Labels {
		if strings.HasPrefix(label, prefix) {
			if role := strings.TrimPrefix(label, prefix); role != "" {
				roles = append(roles, role)
			}
		}
	}
	sort.Strings(roles)
	if len(roles) == 0 {
		return []string{"worker"}
	}
	return roles
}

// nodeInternalIP returns the node's primary internal address, if reported.
func nodeInternalIP(n *corev1.Node) string {
	for i := range n.Status.Addresses {
		if n.Status.Addresses[i].Type == corev1.NodeInternalIP {
			return n.Status.Addresses[i].Address
		}
	}
	return ""
}

// humanBytes renders a byte count in binary units (KiB, MiB, GiB) so large
// memory allocatables read naturally in the UI.
func humanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	return fmt.Sprintf("%.1f %s", float64(b)/float64(div), units[exp])
}
