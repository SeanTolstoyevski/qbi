package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// maxCronRuns caps how many recent runs a CronJobDetail returns. A run trail
// is bounded like every other List here; the user can still page by looking
// at the Jobs table if they need older history.
const maxCronRuns = 10

// CronJobDetail returns a CronJob and its recent runs (newest first), each
// with the pods it created, so the frontend can show run history and stream a
// run's logs.
func (c *Client) CronJobDetail(ctx context.Context, namespace, name string) (CronJobDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return CronJobDetail{}, err
	}
	cj, err := cs.BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return CronJobDetail{}, err
	}
	detail := CronJobDetail{
		Name:              cj.Name,
		Schedule:          cj.Spec.Schedule,
		Suspended:         cj.Spec.Suspend != nil && *cj.Spec.Suspend,
		ConcurrencyPolicy: string(cj.Spec.ConcurrencyPolicy),
		Image:             firstContainerImage(cj.Spec.JobTemplate.Spec.Template.Spec.Containers),
	}
	if cj.Status.LastScheduleTime != nil {
		detail.LastSchedule = age(*cj.Status.LastScheduleTime) + " ago"
	}

	// Runs and their pods come from two List calls; both are capped by the
	// project-wide list safety valve.
	jobs, err := cs.BatchV1().Jobs(namespace).List(ctx, listOptions())
	if err != nil {
		return CronJobDetail{}, err
	}
	pods, err := cs.CoreV1().Pods(namespace).List(ctx, listOptions())
	if err != nil {
		return CronJobDetail{}, err
	}

	// Index pods by the Job that owns them.
	podsByJob := make(map[string][]PodRef)
	for i := range pods.Items {
		p := &pods.Items[i]
		for _, owner := range p.OwnerReferences {
			if owner.Kind == "Job" && owner.Name != "" {
				podsByJob[owner.Name] = append(podsByJob[owner.Name], PodRef{
					Name:       p.Name,
					Containers: containerNames(p.Spec.Containers),
				})
			}
		}
	}

	type runWithTime struct {
		run JobRun
		at  time.Time
	}
	var runs []runWithTime
	for i := range jobs.Items {
		j := &jobs.Items[i]
		if !ownedBy(j.OwnerReferences, "CronJob", name) {
			continue
		}
		podRefs := podsByJob[j.Name]
		sort.SliceStable(podRefs, func(a, b int) bool {
			return podRefs[a].Name > podRefs[b].Name
		})
		runs = append(runs, runWithTime{
			run: JobRun{
				Name:   j.Name,
				Status: summariseJob(j).Status,
				Age:    age(j.CreationTimestamp),
				Pods:   podRefs,
			},
			at: j.CreationTimestamp.Time,
		})
	}
	sort.SliceStable(runs, func(a, b int) bool { return runs[a].at.After(runs[b].at) })
	for i, r := range runs {
		if i >= maxCronRuns {
			break
		}
		detail.Runs = append(detail.Runs, r.run)
	}
	return detail, nil
}

// UpdateCronJob applies the user's edits (schedule, suspend, concurrency
// policy) to a CronJob via a merge patch, so untouched fields are left alone.
func (c *Client) UpdateCronJob(ctx context.Context, namespace, name string, upd CronJobUpdate) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	if upd.ConcurrencyPolicy != nil && !validConcurrencyPolicy(*upd.ConcurrencyPolicy) {
		return fmt.Errorf("invalid concurrency policy %q (want Allow, Forbid or Replace)", *upd.ConcurrencyPolicy)
	}
	spec := map[string]any{}
	if upd.Schedule != nil {
		spec["schedule"] = *upd.Schedule
	}
	if upd.Suspend != nil {
		spec["suspend"] = *upd.Suspend
	}
	if upd.ConcurrencyPolicy != nil {
		spec["concurrencyPolicy"] = *upd.ConcurrencyPolicy
	}
	if len(spec) == 0 {
		return nil // nothing to change
	}
	b, err := json.Marshal(map[string]any{"spec": spec})
	if err != nil {
		return err
	}
	_, err = cs.BatchV1().CronJobs(namespace).Patch(ctx, name, types.MergePatchType, b, metav1.PatchOptions{})
	return err
}

// CreateCronJob creates a CronJob from a minimal user spec. The job template
// runs the given image with the given command; history limits use the cluster
// defaults. The concurrency policy is the user's choice (Allow/Forbid/Replace).
func (c *Client) CreateCronJob(ctx context.Context, namespace string, spec CronJobCreate) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	if !validConcurrencyPolicy(spec.ConcurrencyPolicy) {
		return fmt.Errorf("invalid concurrency policy %q (want Allow, Forbid or Replace)", spec.ConcurrencyPolicy)
	}
	suspend := spec.Suspend
	cronSpec := batchv1.CronJobSpec{
		Schedule: spec.Schedule,
		Suspend:  &suspend,
		JobTemplate: batchv1.JobTemplateSpec{
			Spec: batchv1.JobSpec{
				Template: corev1.PodTemplateSpec{
					Spec: corev1.PodSpec{
						RestartPolicy: corev1.RestartPolicyOnFailure,
						Containers: []corev1.Container{{
							Name:    spec.Name,
							Image:   spec.Image,
							Command: spec.Command,
						}},
					},
				},
			},
		},
	}
	if spec.ConcurrencyPolicy != "" {
		cronSpec.ConcurrencyPolicy = batchv1.ConcurrencyPolicy(spec.ConcurrencyPolicy)
	}
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: spec.Name, Namespace: namespace}, Spec: cronSpec}
	_, err = cs.BatchV1().CronJobs(namespace).Create(ctx, cj, metav1.CreateOptions{})
	return err
}

// validConcurrencyPolicy reports whether v is a real CronJob concurrency
// policy (or empty, meaning the cluster default Allow).
func validConcurrencyPolicy(v string) bool {
	switch v {
	case "", string(batchv1.AllowConcurrent), string(batchv1.ForbidConcurrent), string(batchv1.ReplaceConcurrent):
		return true
	}
	return false
}

// ownedBy reports whether an owner reference points at the given kind/name.
func ownedBy(owners []metav1.OwnerReference, kind, name string) bool {
	for _, o := range owners {
		if o.Kind == kind && o.Name == name {
			return true
		}
	}
	return false
}

// firstContainerImage returns the image of the first container, if any.
func firstContainerImage(containers []corev1.Container) string {
	if len(containers) == 0 {
		return ""
	}
	return containers[0].Image
}

// containerNames extracts the container names of a pod for log streaming.
func containerNames(containers []corev1.Container) []string {
	out := make([]string, 0, len(containers))
	for i := range containers {
		out = append(out, containers[i].Name)
	}
	return out
}
