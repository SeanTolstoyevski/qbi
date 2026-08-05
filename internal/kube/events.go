package kube

import (
	"context"
	"sort"

	"k8s.io/client-go/kubernetes"
)

// Events returns events in a namespace, most recent first. Events are the
// primary signal for diagnosing scheduling failures, image pull errors,
// crash loops and probe failures.
func (c *Client) Events(ctx context.Context, namespace string) ([]EventInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	return eventsForObject(ctx, cs, namespace, "", "")
}

// eventsForObject lists events in a namespace, optionally narrowed to the
// events about one object (kind + name). An empty kind returns all events.
// The list is most-recent-first.
func eventsForObject(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string) ([]EventInfo, error) {
	list, err := cs.CoreV1().Events(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	items := list.Items
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].LastTimestamp.After(items[j].LastTimestamp.Time)
	})

	out := make([]EventInfo, 0, len(items))
	for i := range items {
		e := &items[i]

		if kind != "" && (e.InvolvedObject.Kind != kind || e.InvolvedObject.Name != name) {
			continue
		}

		obj := e.InvolvedObject.Kind
		if e.InvolvedObject.Name != "" {
			obj += "/" + e.InvolvedObject.Name
		}

		out = append(out, EventInfo{
			Type:      e.Type,
			Reason:    e.Reason,
			Object:    obj,
			Message:   e.Message,
			Count:     e.Count,
			Component: e.Source.Component,
			LastSeen:  age(e.LastTimestamp),
			FirstSeen: age(e.FirstTimestamp),
		})
	}

	return out, nil
}
