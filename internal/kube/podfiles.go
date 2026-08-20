package kube

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

var podFilePaths = []string{"/etc/hosts", "/etc/resolv.conf"}

func podFilePathAllowed(path string) bool {
	for _, p := range podFilePaths {
		if path == p {
			return true
		}
	}
	return false
}

// validateExecTarget rejects names that are not valid Kubernetes identifiers.
// These values travel as kubectl argv: a "-"-prefixed value would be parsed
// as a kubectl flag (e.g. --kubeconfig=…) instead of a name, silently
// redirecting the exec to a different cluster.
func validateExecTarget(namespace, pod, container string) error {
	if namespace == "" || pod == "" {
		return errors.New("pod and namespace are required")
	}
	if errs := validation.IsDNS1123Subdomain(pod); len(errs) > 0 {
		return fmt.Errorf("invalid pod name %q", pod)
	}
	if errs := validation.IsDNS1123Label(namespace); len(errs) > 0 {
		return fmt.Errorf("invalid namespace %q", namespace)
	}
	if container != "" {
		if errs := validation.IsDNS1123Label(container); len(errs) > 0 {
			return fmt.Errorf("invalid container name %q", container)
		}
	}
	return nil
}

// PodFile reads a single file from inside a pod container by running
// `kubectl exec … cat <path>` as a subprocess and capturing its output. The
// same --context/--kubeconfig flags as OpenShell pin the cluster being
// inspected. Only allowlisted files (podFilePaths) may be read; pod and
// container names travel as argv, never through a shell string, and are
// validated as Kubernetes identifiers first. This client method itself is
// not gated, the experimental gate lives on Service.GetPodNetworkFiles,
// keeping policy out of this layer.
func (c *Client) PodFile(ctx context.Context, namespace, pod, container, path string) (string, error) {
	if err := validateExecTarget(namespace, pod, container); err != nil {
		return "", err
	}
	if !podFilePathAllowed(path) {
		return "", fmt.Errorf("reading %q is not supported", path)
	}

	args := []string{"exec", pod, "-n", namespace}
	args = append(args, kubectlBaseArgs(c)...)
	if container != "" {
		args = append(args, "-c", container)
	}
	args = append(args, "--", "cat", path)

	cmd := exec.CommandContext(ctx, "kubectl", args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {

		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("kubectl exec failed: %s", msg)
	}
	return stdout.String(), nil
}
