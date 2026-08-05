package kube

import (
	"context"
	"fmt"
	"sort"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Workloads returns the Deployments, StatefulSets and DaemonSets in a
// namespace, summarised with readiness and container images. A resource type
// the caller cannot read (RBAC) is reported in Errors instead of failing the
// whole screen, so a partially-allowed role still sees what it can.
func (c *Client) Workloads(ctx context.Context, namespace string) (WorkloadsView, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return WorkloadsView{}, err
	}

	view := WorkloadsView{}

	collect := func(kind string, list func() ([]WorkloadInfo, error)) {
		items, err := list()
		if err != nil {
			view.Errors = append(view.Errors, fmt.Sprintf("%s: %v", kind, err))
			return
		}
		view.Workloads = append(view.Workloads, items...)
	}

	collect("Deployments", func() ([]WorkloadInfo, error) {
		deploys, err := cs.AppsV1().Deployments(namespace).List(ctx, listOptions())
		if err != nil {
			return nil, err
		}
		out := []WorkloadInfo{}
		for i := range deploys.Items {
			d := &deploys.Items[i]
			out = append(out, WorkloadInfo{
				Kind:      "Deployment",
				Name:      d.Name,
				Namespace: d.Namespace,
				Ready:     fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, d.Status.Replicas),
				UpToDate:  d.Status.UpdatedReplicas,
				Available: d.Status.AvailableReplicas,
				Images:    containerImages(d.Spec.Template.Spec.Containers),
				Age:       age(d.CreationTimestamp),
			})
		}
		return out, nil
	})

	collect("StatefulSets", func() ([]WorkloadInfo, error) {
		sts, err := cs.AppsV1().StatefulSets(namespace).List(ctx, listOptions())
		if err != nil {
			return nil, err
		}
		out := []WorkloadInfo{}
		for i := range sts.Items {
			s := &sts.Items[i]
			out = append(out, WorkloadInfo{
				Kind:      "StatefulSet",
				Name:      s.Name,
				Namespace: s.Namespace,
				Ready:     fmt.Sprintf("%d/%d", s.Status.ReadyReplicas, s.Status.Replicas),
				UpToDate:  s.Status.UpdatedReplicas,
				Available: s.Status.CurrentReplicas,
				Images:    containerImages(s.Spec.Template.Spec.Containers),
				Age:       age(s.CreationTimestamp),
			})
		}
		return out, nil
	})

	collect("DaemonSets", func() ([]WorkloadInfo, error) {
		ds, err := cs.AppsV1().DaemonSets(namespace).List(ctx, listOptions())
		if err != nil {
			return nil, err
		}
		out := []WorkloadInfo{}
		for i := range ds.Items {
			d := &ds.Items[i]
			out = append(out, WorkloadInfo{
				Kind:      "DaemonSet",
				Name:      d.Name,
				Namespace: d.Namespace,
				Ready:     fmt.Sprintf("%d/%d", d.Status.NumberReady, d.Status.DesiredNumberScheduled),
				UpToDate:  d.Status.UpdatedNumberScheduled,
				Available: d.Status.NumberAvailable,
				Images:    containerImages(d.Spec.Template.Spec.Containers),
				Age:       age(d.CreationTimestamp),
			})
		}
		return out, nil
	})

	sort.Slice(view.Workloads, func(i, j int) bool {
		if view.Workloads[i].Kind != view.Workloads[j].Kind {
			return view.Workloads[i].Kind < view.Workloads[j].Kind
		}
		return view.Workloads[i].Name < view.Workloads[j].Name
	})
	return view, nil
}

func containerImages(cs []corev1.Container) []string {
	images := make([]string, 0, len(cs))
	for i := range cs {
		images = append(images, cs[i].Image)
	}
	return images
}

// RestartWorkload triggers a rolling restart of a workload, mirroring
// `kubectl rollout restart`. Kubernetes has no "restart pod" concept; instead
// we stamp the pod template with a restartedAt annotation, which the controller
// treats as a spec change and rolls out fresh pods (respecting the workload's
// update strategy and availability guarantees).
func (c *Client) RestartWorkload(ctx context.Context, namespace, kind, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}

	// Strategic-merge patch on the pod template annotations. The same shape
	// works for Deployments, StatefulSets and DaemonSets.
	stamp := time.Now().Format(time.RFC3339)
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`,
		stamp,
	))

	switch kind {
	case "Deployment":
		_, err = cs.AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	case "StatefulSet":
		_, err = cs.AppsV1().StatefulSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	case "DaemonSet":
		_, err = cs.AppsV1().DaemonSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	default:
		return fmt.Errorf("cannot restart unsupported workload kind %q", kind)
	}
	return err
}

// ScaleWorkload sets the replica count for a Deployment or StatefulSet via the
// scale subresource. DaemonSets are excluded — their replica count is managed
// by the scheduler based on node selectors, not a user-set number.
func (c *Client) ScaleWorkload(ctx context.Context, namespace, kind, name string, replicas int32) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas))
	switch kind {
	case "Deployment":
		_, err = cs.AppsV1().Deployments(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	case "StatefulSet":
		_, err = cs.AppsV1().StatefulSets(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	default:
		return fmt.Errorf("cannot scale workload kind %q", kind)
	}
	return err
}

// DeleteWorkload removes a Deployment, StatefulSet or DaemonSet. Only the
// controller is deleted: its pods are terminated by the cluster, and for a
// StatefulSet any PersistentVolumeClaims are retained (the data survives).
func (c *Client) DeleteWorkload(ctx context.Context, namespace, kind, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	switch kind {
	case "Deployment":
		return cs.AppsV1().Deployments(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	case "StatefulSet":
		return cs.AppsV1().StatefulSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	case "DaemonSet":
		return cs.AppsV1().DaemonSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	default:
		return fmt.Errorf("cannot delete workload kind %q", kind)
	}
}

// Jobs returns the Jobs in a namespace with a summarised completion status.
func (c *Client) Jobs(ctx context.Context, namespace string) ([]JobInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	list, err := cs.BatchV1().Jobs(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}
	out := make([]JobInfo, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, summariseJob(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func summariseJob(j *batchv1.Job) JobInfo {
	info := JobInfo{
		Name:      j.Name,
		Namespace: j.Namespace,
		Active:    j.Status.Active,
		Failed:    j.Status.Failed,
		Status:    "Running",
		Age:       age(j.CreationTimestamp),
	}
	// Completions string: "succeeded / desired" or just "succeeded" for open-ended.
	if j.Spec.Completions != nil {
		info.Completions = fmt.Sprintf("%d/%d", j.Status.Succeeded, *j.Spec.Completions)
	} else {
		info.Completions = fmt.Sprintf("%d", j.Status.Succeeded)
	}
	// Determine overall status from conditions.
	for _, cond := range j.Status.Conditions {
		if cond.Type == batchv1.JobComplete && cond.Status == corev1.ConditionTrue {
			info.Status = "Complete"
		} else if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
			info.Status = "Failed"
		} else if cond.Type == batchv1.JobSuspended && cond.Status == corev1.ConditionTrue {
			info.Status = "Suspended"
		}
	}
	return info
}

// CronJobs returns the CronJobs in a namespace.
func (c *Client) CronJobs(ctx context.Context, namespace string) ([]CronJobInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	list, err := cs.BatchV1().CronJobs(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}
	out := make([]CronJobInfo, 0, len(list.Items))
	for i := range list.Items {
		cj := &list.Items[i]
		info := CronJobInfo{
			Name:              cj.Name,
			Namespace:         cj.Namespace,
			Schedule:          cj.Spec.Schedule,
			Suspended:         cj.Spec.Suspend != nil && *cj.Spec.Suspend,
			Active:            int32(len(cj.Status.Active)),
			Age:               age(cj.CreationTimestamp),
			ConcurrencyPolicy: string(cj.Spec.ConcurrencyPolicy),
			Image:             firstContainerImage(cj.Spec.JobTemplate.Spec.Template.Spec.Containers),
		}
		if cj.Status.LastScheduleTime != nil {
			info.LastSchedule = age(*cj.Status.LastScheduleTime) + " ago"
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
