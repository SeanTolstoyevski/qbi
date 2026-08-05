package kube

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// CreateService creates a Service from the user-facing spec. A Service is a
// sibling of the Deployment in the namespace — it selects pods by label, it
// does not wrap the Deployment. The user supplies the selector explicitly.
func (c *Client) CreateService(ctx context.Context, namespace string, spec ServiceCreate) error {
	if err := validateService(spec); err != nil {
		return err
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	_, err = cs.CoreV1().Services(namespace).Create(ctx, buildService(namespace, spec), metav1.CreateOptions{})
	return err
}

// RenderServiceYAML renders the exact manifest CreateService would apply,
// cleaned for drafting (like RenderDeploymentYAML). Pure serialization.
func (c *Client) RenderServiceYAML(namespace string, spec ServiceCreate) (string, error) {
	if err := validateService(spec); err != nil {
		return "", err
	}
	return renderCleanYAML(buildService(namespace, spec))
}

// validateService checks the fields the form produces. Node ports follow the
// cluster's allocatable range; target ports may be a number or a named port.
func validateService(spec ServiceCreate) error {
	if spec.Name == "" {
		return errors.New("name is required")
	}
	switch spec.Type {
	case "", "ClusterIP", "NodePort", "LoadBalancer":
	default:
		return fmt.Errorf("invalid service type %q (want ClusterIP, NodePort or LoadBalancer)", spec.Type)
	}
	if len(spec.Ports) == 0 {
		return errors.New("at least one port is required")
	}
	for _, p := range spec.Ports {
		if p.Port < 1 || p.Port > 65535 {
			return errors.New("service port must be between 1 and 65535")
		}
		if p.Protocol != "" {
			switch strings.ToUpper(p.Protocol) {
			case "TCP", "UDP", "SCTP":
			default:
				return fmt.Errorf("invalid protocol %q (want TCP, UDP or SCTP)", p.Protocol)
			}
		}
		if p.TargetPort != "" {
			if n, err := strconv.Atoi(p.TargetPort); err == nil && (n < 1 || n > 65535) {
				return errors.New("target port must be between 1 and 65535 (or a named port)")
			}
		}
		if p.NodePort != 0 && (p.NodePort < 30000 || p.NodePort > 32767) {
			return errors.New("node port must be between 30000 and 32767, or empty to auto-assign")
		}
	}
	for k := range spec.Selector {
		if k == "" {
			return errors.New("selector key is required")
		}
	}
	switch spec.SessionAffinity {
	case "", "None", "ClientIP":
	default:
		return fmt.Errorf("invalid session affinity %q (want None or ClientIP)", spec.SessionAffinity)
	}
	return nil
}

// buildService turns the form spec into a Service object. Empty fields stay
// empty so the preview only shows what the user chose.
func buildService(namespace string, spec ServiceCreate) *corev1.Service {
	ports := make([]corev1.ServicePort, 0, len(spec.Ports))
	for _, p := range spec.Ports {
		sp := corev1.ServicePort{
			Name:     p.Name,
			Port:     p.Port,
			Protocol: corev1.ProtocolTCP,
		}
		if p.Protocol != "" {
			sp.Protocol = corev1.Protocol(strings.ToUpper(p.Protocol))
		}
		switch {
		case p.TargetPort == "":
			sp.TargetPort = intstr.FromInt(int(p.Port))
		default:
			if n, err := strconv.Atoi(p.TargetPort); err == nil {
				sp.TargetPort = intstr.FromInt(n)
			} else {
				sp.TargetPort = intstr.FromString(p.TargetPort)
			}
		}
		if p.NodePort != 0 {
			sp.NodePort = p.NodePort
		}
		ports = append(ports, sp)
	}

	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: spec.Name, Namespace: namespace},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: spec.Selector,
			Ports:    ports,
		},
	}
	if spec.Type != "" {
		svc.Spec.Type = corev1.ServiceType(spec.Type)
	}
	if spec.SessionAffinity != "" {
		svc.Spec.SessionAffinity = corev1.ServiceAffinity(spec.SessionAffinity)
	}
	if spec.ClusterIP != "" {
		svc.Spec.ClusterIP = spec.ClusterIP
	}
	if len(spec.ExternalIPs) > 0 {
		svc.Spec.ExternalIPs = spec.ExternalIPs
	}
	return svc
}
