package kube

import (
	"context"
	"fmt"
	"sort"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConfigMaps returns ConfigMap metadata (names and keys) in a namespace.
func (c *Client) ConfigMaps(ctx context.Context, namespace string) ([]ConfigMapInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().ConfigMaps(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	out := make([]ConfigMapInfo, 0, len(list.Items))
	for i := range list.Items {
		cm := &list.Items[i]
		keys := make([]string, 0, len(cm.Data)+len(cm.BinaryData))
		for k := range cm.Data {
			keys = append(keys, k)
		}
		for k := range cm.BinaryData {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out = append(out, ConfigMapInfo{
			Name: cm.Name,
			Keys: keys,
			Age:  age(cm.CreationTimestamp),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ConfigMap returns a single ConfigMap's full contents.
func (c *Client) ConfigMap(ctx context.Context, namespace, name string) (ConfigMapDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return ConfigMapDetail{}, err
	}

	cm, err := cs.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return ConfigMapDetail{}, err
	}

	return decodeConfigMap(cm), nil
}

func decodeConfigMap(cm *corev1.ConfigMap) ConfigMapDetail {
	entries := make([]ConfigMapEntry, 0, len(cm.Data)+len(cm.BinaryData))
	for k, v := range cm.Data {
		entries = append(entries, ConfigMapEntry{Key: k, Value: v})
	}
	for k, v := range cm.BinaryData {
		entry := ConfigMapEntry{Key: k}
		if utf8.Valid(v) {
			entry.Value = string(v)
		} else {
			entry.IsBinary = true
			entry.Value = fmt.Sprintf("<%d bytes of binary data>", len(v))
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
	return ConfigMapDetail{Name: cm.Name, Entries: entries}
}
