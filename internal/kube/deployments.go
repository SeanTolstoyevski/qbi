package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	sigsyaml "sigs.k8s.io/yaml"
)

// CreateDeployment creates a Deployment from the user-facing spec. The app
// label doubles as the pod selector and template label, which is what makes a
// Deployment valid without the user having to wire selector ↔ labels by hand.
func (c *Client) CreateDeployment(ctx context.Context, namespace string, spec DeploymentCreate) error {
	if err := validateDeployment(spec); err != nil {
		return err
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	_, err = cs.AppsV1().Deployments(namespace).Create(ctx, buildDeployment(namespace, spec), metav1.CreateOptions{})
	return err
}

// RenderDeploymentYAML renders the manifest that CreateDeployment would
// apply, cleaned for drafting: empty bookkeeping fields (creationTimestamp,
// status, empty resources/strategy) are dropped so the output is a YAML the
// user can read, copy and build on. It is pure serialization — no cluster
// call.
func (c *Client) RenderDeploymentYAML(namespace string, spec DeploymentCreate) (string, error) {
	if err := validateDeployment(spec); err != nil {
		return "", err
	}
	return renderCleanYAML(buildDeployment(namespace, spec))
}

// renderCleanYAML marshals an object, then strips empty/zero fields so the
// preview reads like a hand-written manifest instead of a machine dump.
func renderCleanYAML(obj interface{}) (string, error) {
	b, err := json.Marshal(obj)
	if err != nil {
		return "", err
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		return "", err
	}
	cleanMap(m)
	out, err := sigsyaml.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// cleanMap recursively drops empty values (null, "", empty maps). Slices are
// kept unless completely empty — a container's required fields must survive.
func cleanMap(m map[string]interface{}) {
	for k, v := range m {
		switch t := v.(type) {
		case nil:
			delete(m, k)
		case string:
			if t == "" {
				delete(m, k)
			}
		case map[string]interface{}:
			cleanMap(t)
			if len(t) == 0 {
				delete(m, k)
			}
		case []interface{}:
			for i := range t {
				if mm, ok := t[i].(map[string]interface{}); ok {
					cleanMap(mm)
				}
			}
			if len(t) == 0 {
				delete(m, k)
			}
		}
	}
}

// validateDeployment checks the fields the form produces. Resource quantities
// are validated with the same parser the API server uses, so a typo like
// "128 MB" fails here instead of at the cluster.
func validateDeployment(spec DeploymentCreate) error {
	if spec.Name == "" {
		return errors.New("name is required")
	}
	if spec.Image == "" {
		return errors.New("image is required")
	}
	if spec.Replicas < 0 {
		return errors.New("replicas must be zero or more")
	}
	if spec.Port < 0 || spec.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	if spec.Protocol != "" && !strings.EqualFold(spec.Protocol, "TCP") && !strings.EqualFold(spec.Protocol, "UDP") {
		return fmt.Errorf("invalid protocol %q (want TCP or UDP)", spec.Protocol)
	}
	if spec.ImagePullPolicy != "" {
		switch spec.ImagePullPolicy {
		case "Always", "IfNotPresent", "Never":
		default:
			return fmt.Errorf("invalid image pull policy %q", spec.ImagePullPolicy)
		}
	}
	if spec.UpdateStrategy != "" {
		switch spec.UpdateStrategy {
		case "RollingUpdate", "Recreate":
		default:
			return fmt.Errorf("invalid update strategy %q", spec.UpdateStrategy)
		}
	}
	for _, e := range spec.Env {
		if e.Name == "" {
			return errors.New("environment variable name is required")
		}
	}
	for k := range spec.Labels {
		if k == "" {
			return errors.New("label key is required")
		}
	}
	for k := range spec.NodeSelector {
		if k == "" {
			return errors.New("node selector key is required")
		}
	}
	quantities := map[string]string{
		"cpu request":    spec.Resources.CPURequest,
		"memory request": spec.Resources.MemoryRequest,
		"cpu limit":      spec.Resources.CPULimit,
		"memory limit":   spec.Resources.MemoryLimit,
	}
	for label, q := range quantities {
		if q == "" {
			continue
		}
		if _, err := resource.ParseQuantity(q); err != nil {
			return fmt.Errorf("invalid %s %q", label, q)
		}
	}
	return nil
}

// buildDeployment turns the form spec into a Deployment object. Fields left
// empty stay empty so the rendered YAML only shows what the user chose.
func buildDeployment(namespace string, spec DeploymentCreate) *appsv1.Deployment {
	replicas := spec.Replicas
	labels := map[string]string{"app": spec.Name}
	for k, v := range spec.Labels {
		if k != "" {
			labels[k] = v
		}
	}

	container := corev1.Container{
		Name:    sanitizeContainerName(spec.Name),
		Image:   spec.Image,
		Command: spec.Command,
		Args:    spec.Args,
	}
	if spec.ImagePullPolicy != "" {
		container.ImagePullPolicy = corev1.PullPolicy(spec.ImagePullPolicy)
	}
	if spec.Port > 0 {
		protocol := corev1.ProtocolTCP
		if strings.EqualFold(spec.Protocol, "UDP") {
			protocol = corev1.ProtocolUDP
		}
		container.Ports = []corev1.ContainerPort{{ContainerPort: spec.Port, Protocol: protocol}}
	}
	if len(spec.Env) > 0 {
		env := make([]corev1.EnvVar, 0, len(spec.Env))
		for _, e := range spec.Env {
			if e.Name == "" {
				continue
			}
			env = append(env, corev1.EnvVar{Name: e.Name, Value: e.Value})
		}
		container.Env = env
	}
	if r := spec.Resources; r.CPURequest != "" || r.MemoryRequest != "" || r.CPULimit != "" || r.MemoryLimit != "" {
		req := corev1.ResourceList{}
		lim := corev1.ResourceList{}
		if r.CPURequest != "" {
			req[corev1.ResourceCPU] = resource.MustParse(r.CPURequest)
		}
		if r.MemoryRequest != "" {
			req[corev1.ResourceMemory] = resource.MustParse(r.MemoryRequest)
		}
		if r.CPULimit != "" {
			lim[corev1.ResourceCPU] = resource.MustParse(r.CPULimit)
		}
		if r.MemoryLimit != "" {
			lim[corev1.ResourceMemory] = resource.MustParse(r.MemoryLimit)
		}
		container.Resources = corev1.ResourceRequirements{Requests: req, Limits: lim}
	}

	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: spec.Name, Namespace: namespace, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": spec.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec:       corev1.PodSpec{Containers: []corev1.Container{container}},
			},
		},
	}
	if len(spec.NodeSelector) > 0 {
		ns := map[string]string{}
		for k, v := range spec.NodeSelector {
			if k != "" {
				ns[k] = v
			}
		}
		if len(ns) > 0 {
			deploy.Spec.Template.Spec.NodeSelector = ns
		}
	}
	if spec.UpdateStrategy == "Recreate" {
		deploy.Spec.Strategy = appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType}
	} else if spec.UpdateStrategy == "RollingUpdate" {
		deploy.Spec.Strategy = appsv1.DeploymentStrategy{Type: appsv1.RollingUpdateDeploymentStrategyType}
	}
	return deploy
}

// sanitizeContainerName derives a valid DNS label (container names cannot
// contain dots or start with a digit) from a Deployment name.
func sanitizeContainerName(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		return "main"
	}
	if s[0] >= '0' && s[0] <= '9' {
		s = "c-" + s
	}
	return s
}
