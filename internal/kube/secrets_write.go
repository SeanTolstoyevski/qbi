package kube

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/util/retry"
)

// Value modes for secret create/update. The UI passes the mode through so the
// backend stays the single authority on base64 validation.
const (
	ModeTransparent = "transparent"
	ModeBase64      = "base64"
)

// SecretChange describes a single mutation to apply to a secret's data.
// Delete takes precedence: when true, the key is removed and Value is ignored.
type SecretChange struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Delete bool   `json:"delete"`
}

// encodeSecretValue turns a UI-supplied value into the bytes to store.
//
// In transparent mode the user types plain text and we store it as-is (the
// API server base64-encodes on write). In base64 mode the user supplies raw
// base64 themselves; we are only responsible for validating it at patch time,
// then storing the decoded bytes so the round trip is lossless.
func encodeSecretValue(mode, key, value string) ([]byte, error) {
	if mode == ModeBase64 {
		b, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("key %q is not valid base64: %v", key, err)
		}
		return b, nil
	}
	return []byte(value), nil
}

// CreateSecret creates a new secret from the form spec. Values are encoded
// according to mode (see encodeSecretValue). The name is validated up front so
// typos fail fast instead of surfacing as an API error.
func (c *Client) CreateSecret(ctx context.Context, namespace string, spec SecretCreate, mode string) error {
	if err := validateSecretCreate(spec); err != nil {
		return err
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}

	secretType := spec.Type
	if secretType == "" {
		secretType = string(corev1.SecretTypeOpaque)
	}

	data := make(map[string][]byte, len(spec.Data))
	for k, v := range spec.Data {
		b, err := encodeSecretValue(mode, k, v)
		if err != nil {
			return err
		}
		data[k] = b
	}

	_, err = cs.CoreV1().Secrets(namespace).Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: spec.Name},
		Type:       corev1.SecretType(secretType),
		Data:       data,
	}, metav1.CreateOptions{})
	return err
}

// validateSecretCreate checks the fields the form produces. Key names follow
// the same rules as the edit path; base64 validation itself happens inside
// encodeSecretValue so the error mentions the offending key.
func validateSecretCreate(spec SecretCreate) error {
	if spec.Name == "" {
		return fmt.Errorf("a secret name is required")
	}
	if errs := utilvalidation.IsDNS1123Subdomain(spec.Name); len(errs) > 0 {
		return fmt.Errorf("invalid secret name %q: %s", spec.Name, strings.Join(errs, "; "))
	}
	if len(spec.Data) == 0 {
		return fmt.Errorf("a secret must contain at least one key")
	}
	for k := range spec.Data {
		if k == "" {
			return fmt.Errorf("a key name cannot be empty")
		}
	}
	return nil
}

// UpdateSecret applies a set of key changes to an existing secret and returns
// the refreshed detail. Keys not mentioned in changes are left untouched, so
// binary values the UI cannot display are preserved. Values are encoded
// according to mode (see encodeSecretValue).
//
// The Get-modify-Update is wrapped in RetryOnConflict so that a concurrent
// change (by another user or a controller) results in a re-read and re-apply
// rather than a lost update or a surfaced 409 conflict.
func (c *Client) UpdateSecret(ctx context.Context, namespace, name string, changes []SecretChange, mode string) (SecretDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return SecretDetail{}, err
	}

	// Validate up front so we fail fast before touching the API server.
	for _, ch := range changes {
		if ch.Key == "" {
			return SecretDetail{}, fmt.Errorf("a key name cannot be empty")
		}
	}

	secrets := cs.CoreV1().Secrets(namespace)

	var updated *corev1.Secret
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		s, getErr := secrets.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}

		if s.Data == nil {
			s.Data = map[string][]byte{}
		}

		for _, ch := range changes {
			if ch.Delete {
				delete(s.Data, ch.Key)
				continue
			}
			b, encErr := encodeSecretValue(mode, ch.Key, ch.Value)
			if encErr != nil {
				return encErr
			}
			s.Data[ch.Key] = b
		}

		if len(s.Data) == 0 {
			return fmt.Errorf("a secret must contain at least one key")
		}

		var updErr error
		updated, updErr = secrets.Update(ctx, s, metav1.UpdateOptions{})
		return updErr
	})
	if err != nil {
		return SecretDetail{}, err
	}

	return decodeSecret(updated), nil
}

// DeleteSecret permanently removes a secret from the cluster.
func (c *Client) DeleteSecret(ctx context.Context, namespace, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	return cs.CoreV1().Secrets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
