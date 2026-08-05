package kube

import (
	"context"
	"fmt"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	sigsyaml "sigs.k8s.io/yaml"
)

// SecretYAML returns the manifest for a secret. In transparent mode the
// manifest uses stringData (plain text) for every value that is valid UTF-8,
// with only binary values staying in data as base64 — so the user edits
// readable values and Kubernetes does the encoding on apply. In base64 mode it
// returns the true stored manifest (data, base64) unchanged.
func (c *Client) SecretYAML(ctx context.Context, namespace, name string, transparent bool) (string, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return "", err
	}
	s, err := cs.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	s.ManagedFields = nil

	if !transparent {
		s.TypeMeta = metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}
		return renderCleanYAML(s)
	}

	// Rebuild with stringData for readable values and data for binary ones, so
	// a screen-reader user never has to squint at base64 in transparent mode.
	plain := &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      s.Name,
			Namespace: s.Namespace,
		},
		Type:       s.Type,
		StringData: map[string]string{},
		Data:       map[string][]byte{},
	}
	for k, v := range s.Data {
		if utf8.Valid(v) {
			plain.StringData[k] = string(v)
		} else {
			plain.Data[k] = v
		}
	}
	return renderCleanYAML(plain)
}

// ParseSecretYAML decodes a user-supplied manifest and verifies it is a
// Secret with a name, so CreateSecretFromYAML / UpdateSecretYAML fail fast
// with a clear message instead of an API "object is invalid".
func ParseSecretYAML(yaml string) (*corev1.Secret, error) {
	var s corev1.Secret
	if err := sigsyaml.Unmarshal([]byte(yaml), &s); err != nil {
		return nil, fmt.Errorf("invalid YAML: %v", err)
	}
	if s.Kind != "" && s.Kind != "Secret" {
		return nil, fmt.Errorf("manifest kind is %q, not Secret", s.Kind)
	}
	if s.Name == "" {
		return nil, fmt.Errorf("the manifest has no metadata.name")
	}
	return &s, nil
}

// CreateSecretFromYAML creates a secret from a raw manifest. Kubernetes
// accepts both data (base64) and stringData (plain text) here, so whichever
// the user wrote is applied as-is — exactly like `kubectl create -f`.
func (c *Client) CreateSecretFromYAML(ctx context.Context, namespace, yaml string) error {
	s, err := ParseSecretYAML(yaml)
	if err != nil {
		return err
	}
	if s.Type == "" {
		s.Type = corev1.SecretTypeOpaque
	}
	s.Namespace = namespace
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	_, err = cs.CoreV1().Secrets(namespace).Create(ctx, s, metav1.CreateOptions{})
	return err
}

// UpdateSecretYAML replaces a secret from a raw manifest. The name and
// namespace come from the function arguments, never from the manifest, so a
// pasted manifest for a different secret cannot clobber something unexpected.
// The re-apply is wrapped in RetryOnConflict like the form edit path.
func (c *Client) UpdateSecretYAML(ctx context.Context, namespace, name, yaml string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	secrets := cs.CoreV1().Secrets(namespace)

	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		s, err := ParseSecretYAML(yaml)
		if err != nil {
			return err
		}
		if s.Type == "" {
			s.Type = corev1.SecretTypeOpaque
		}
		s.Name = name
		s.Namespace = namespace
		s.ResourceVersion = ""
		_, err = secrets.Update(ctx, s, metav1.UpdateOptions{})
		return err
	})
}
