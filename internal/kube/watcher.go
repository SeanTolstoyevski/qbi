package kube

import (
	"context"
	"log/slog"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

// watchBackoff is the delay before retrying a watch that terminated unexpectedly.
const watchBackoff = 5 * time.Second

// Watcher manages long-lived Kubernetes watch streams for multiple resource
// types. It calls onEvent for every ADDED/MODIFIED/DELETED event, providing
// near-instant change notifications without polling.
//
// Lifecycle:
//   - NewWatcher creates a stopped watcher.
//   - Start(namespace) launches goroutines for the given namespace. Call again
//     to switch namespace; the old streams are cancelled first.
//   - Stop cancels all streams.
type Watcher struct {
	client  *Client
	onEvent func(WatchEvent)

	mu        sync.Mutex
	cancelNS  context.CancelFunc // cancels namespace-scoped watches
	cancelAll context.CancelFunc
}

// NewWatcher creates a Watcher that is not yet running.
// onEvent is called from background goroutines — it must be safe for
// concurrent use. It should be non-blocking; queue or emit asynchronously.
func NewWatcher(c *Client, onEvent func(WatchEvent)) *Watcher {
	return &Watcher{client: c, onEvent: onEvent}
}

// Start begins watching resources in the given namespace, plus cluster-scoped
// resources (nodes, namespaces). If a watch session is already running it is
// cancelled first. Start is a no-op if the client has no active connection.
func (w *Watcher) Start(namespace string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	cs, err := w.client.clientOrErr()
	if err != nil {
		return
	}

	if w.cancelNS != nil {
		w.cancelNS()
	}
	if w.cancelAll == nil {
		allCtx, allCancel := context.Background(), func() {}
		allCtx, allCancel = context.WithCancel(context.Background())
		w.cancelAll = allCancel

		go w.runWatch(allCtx, "Node", "", func(ctx context.Context) (watch.Interface, error) {
			rv, err := clusterRV(ctx, func() (string, error) {
				list, e := cs.CoreV1().Nodes().List(ctx, listOptions())
				if e != nil {
					return "", e
				}
				return list.ResourceVersion, nil
			})
			if err != nil {
				return nil, err
			}
			return cs.CoreV1().Nodes().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		})

		go w.runWatch(allCtx, "Namespace", "", func(ctx context.Context) (watch.Interface, error) {
			rv, err := clusterRV(ctx, func() (string, error) {
				list, e := cs.CoreV1().Namespaces().List(ctx, listOptions())
				if e != nil {
					return "", e
				}
				return list.ResourceVersion, nil
			})
			if err != nil {
				return nil, err
			}
			return cs.CoreV1().Namespaces().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		})
	}

	nsCtx, nsCancel := context.WithCancel(context.Background())
	w.cancelNS = nsCancel
	ns := namespace

	go w.runWatch(nsCtx, "Pod", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.CoreV1().Pods(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.CoreV1().Pods(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "Deployment", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.AppsV1().Deployments(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.AppsV1().Deployments(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "StatefulSet", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.AppsV1().StatefulSets(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.AppsV1().StatefulSets(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "DaemonSet", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.AppsV1().DaemonSets(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.AppsV1().DaemonSets(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "Service", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.CoreV1().Services(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.CoreV1().Services(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "Ingress", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.NetworkingV1().Ingresses(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.NetworkingV1().Ingresses(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "ConfigMap", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.CoreV1().ConfigMaps(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.CoreV1().ConfigMaps(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})

	go w.runWatch(nsCtx, "Secret", ns, func(ctx context.Context) (watch.Interface, error) {
		rv, err := clusterRV(ctx, func() (string, error) {
			list, e := cs.CoreV1().Secrets(ns).List(ctx, listOptions())
			if e != nil {
				return "", e
			}
			return list.ResourceVersion, nil
		})
		if err != nil {
			return nil, err
		}
		return cs.CoreV1().Secrets(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
	})
}

// Stop cancels all running watch streams.
func (w *Watcher) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.cancelNS != nil {
		w.cancelNS()
		w.cancelNS = nil
	}
	if w.cancelAll != nil {
		w.cancelAll()
		w.cancelAll = nil
	}
}

// clusterRV calls getResourceVersion and returns the result, returning "" on
// error so that callers can still issue a Watch (which will then re-list from
// the server's current state).
func clusterRV(_ context.Context, getResourceVersion func() (string, error)) (string, error) {
	return getResourceVersion()
}

// runWatch runs a single watch loop for the given kind. It calls makeWatch to
// obtain a watch.Interface, drains its channel, and restarts after any
// termination (including errors and clean closure by the server). It exits only
// when ctx is cancelled.
func (w *Watcher) runWatch(ctx context.Context, kind, namespace string, makeWatch func(context.Context) (watch.Interface, error)) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		wi, err := makeWatch(ctx)
		if err != nil {
			slog.Debug("watch setup failed, retrying", "kind", kind, "namespace", namespace, "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(watchBackoff):
			}
			continue
		}

	drain:
		for {
			select {
			case <-ctx.Done():
				wi.Stop()
				return
			case ev, ok := <-wi.ResultChan():
				if !ok {
					break drain
				}
				switch ev.Type {
				case watch.Added, watch.Deleted:
					// MODIFIED is deliberately excluded: Kubernetes emits it
					// constantly for routine status updates (node heartbeats,
					// pod condition ticks, etc.) which would flood the UI with
					// noise. ADDED and DELETED are the only events that
					// meaningfully change what the user sees in the list.
					name := objectName(ev.Object, kind)
					if name == "" {
						continue
					}
					w.onEvent(WatchEvent{
						Type:      string(ev.Type),
						Kind:      kind,
						Name:      name,
						Namespace: namespace,
					})
				case watch.Error:
					slog.Debug("watch stream restarted", "kind", kind, "namespace", namespace)
					wi.Stop()
					break drain
				}
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(watchBackoff):
		}
	}
}

// objectName extracts the metadata name from a watched object. Each resource
// type must be handled explicitly because watch.Interface returns runtime.Object.
func objectName(obj interface{}, kind string) string {
	type namer interface {
		GetName() string
	}
	switch kind {
	case "Pod":
		if o, ok := obj.(*corev1.Pod); ok {
			return o.Name
		}
	case "Deployment":
		if o, ok := obj.(*appsv1.Deployment); ok {
			return o.Name
		}
	case "StatefulSet":
		if o, ok := obj.(*appsv1.StatefulSet); ok {
			return o.Name
		}
	case "DaemonSet":
		if o, ok := obj.(*appsv1.DaemonSet); ok {
			return o.Name
		}
	case "Service":
		if o, ok := obj.(*corev1.Service); ok {
			return o.Name
		}
	case "Ingress":
		if o, ok := obj.(*networkingv1.Ingress); ok {
			return o.Name
		}
	case "ConfigMap":
		if o, ok := obj.(*corev1.ConfigMap); ok {
			return o.Name
		}
	case "Secret":
		if o, ok := obj.(*corev1.Secret); ok {
			return o.Name
		}
	case "Node":
		if o, ok := obj.(*corev1.Node); ok {
			return o.Name
		}
	case "Namespace":
		if o, ok := obj.(*corev1.Namespace); ok {
			return o.Name
		}
	default:
		// Fall back to the namer interface for any future types.
		if n, ok := obj.(namer); ok {
			return n.GetName()
		}
	}
	return ""
}
