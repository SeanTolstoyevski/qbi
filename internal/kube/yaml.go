package kube

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	sigsyaml "sigs.k8s.io/yaml"
)

// ResourceYAML returns a clean YAML representation of a cluster resource.
// ManagedFields are stripped because they are noisy internal bookkeeping that
// is never useful when inspecting a resource by eye.
//
// Supported kinds: Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob,
// Service, Ingress, ConfigMap, Secret, Node.
// namespace is ignored for cluster-scoped kinds (Node).
func (c *Client) ResourceYAML(ctx context.Context, namespace, kind, name string) (string, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return "", err
	}

	var obj interface{}

	switch kind {
	case "Pod":
		o, e := cs.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Deployment":
		o, e := cs.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "StatefulSet":
		o, e := cs.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "DaemonSet":
		o, e := cs.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Job":
		o, e := cs.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "CronJob":
		o, e := cs.BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Service":
		o, e := cs.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Ingress":
		o, e := cs.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "ConfigMap":
		o, e := cs.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Secret":
		o, e := cs.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	case "Node":
		o, e := cs.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", e
		}
		o.ManagedFields = nil
		obj = o

	default:
		return "", fmt.Errorf("unsupported resource kind %q", kind)
	}

	data, err := sigsyaml.Marshal(obj)
	if err != nil {
		return "", fmt.Errorf("marshal %s %q: %w", kind, name, err)
	}
	return string(data), nil
}
