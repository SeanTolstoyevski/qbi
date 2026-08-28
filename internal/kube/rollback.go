package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"
)

// changeCauseAnnotation is the standard "why did this rollout happen" note
// (kubectl sets it from `kubectl rollout`/`kubectl apply --record`); copying
// it across a rollback is what keeps history readable.
const changeCauseAnnotation = "kubernetes.io/change-cause"

// rollbackSkippedAnnotations are controller bookkeeping, not user intent:
// when a rollback restores a Deployment's template it must not resurrect
// them. Mirrors the skip set in kubectl's deployment rollbacker.
var rollbackSkippedAnnotations = map[string]bool{
	corev1.LastAppliedConfigAnnotation:          true,
	deploymentRevisionAnnotation:                true,
	"deployment.kubernetes.io/revision-history": true,
	"deployment.kubernetes.io/desired-replicas": true,
	"deployment.kubernetes.io/max-replicas":     true,
	appsv1.DeprecatedRollbackTo:                 true,
}

// WorkloadRevisions returns the rollout history of a Deployment, StatefulSet
// or DaemonSet, newest revision first. Deployments keep one ReplicaSet per
// revision; StatefulSets and DaemonSets keep one ControllerRevision per
// revision. The current revision is marked so the UI can offer the others as
// rollback targets; a revision whose template equals the live one is a
// rollback no-op and the backend reports it as such.
func (c *Client) WorkloadRevisions(ctx context.Context, namespace, kind, name string) ([]WorkloadRevision, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	switch kind {
	case "Deployment":
		return deploymentRevisions(ctx, cs, namespace, name)
	case "StatefulSet", "DaemonSet":
		return controllerRevisionRevisions(ctx, cs, namespace, kind, name)
	default:
		return nil, fmt.Errorf("cannot list revisions for unsupported workload kind %q", kind)
	}
}

// deploymentRevisions reads a Deployment's revision trail from the ReplicaSets
// it owns. ReplicaSets are retained (bounded by revisionHistoryLimit), each
// stamped with the revision it served, so they are the durable record of
// every deploy that was triggered.
func deploymentRevisions(ctx context.Context, cs kubernetes.Interface, namespace, name string) ([]WorkloadRevision, error) {
	deploy, err := cs.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	rsList, err := cs.AppsV1().ReplicaSets(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	current, _ := parseRevision(deploy.Annotations)
	out := []WorkloadRevision{}
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		if !ownedBy(rs.OwnerReferences, "Deployment", name) {
			continue
		}
		rev, ok := parseRevision(rs.Annotations)
		if !ok {
			continue
		}
		out = append(out, WorkloadRevision{
			Revision:    rev,
			Images:      containerImages(rs.Spec.Template.Spec.Containers),
			ChangeCause: rs.Annotations[changeCauseAnnotation],
			Age:         age(rs.CreationTimestamp),
			Current:     rev == current,
			Replicas:    fmt.Sprintf("%d/%d", rs.Status.ReadyReplicas, rs.Status.Replicas),
		})
	}
	sortRevisionsDesc(out)
	return out, nil
}

// controllerRevisionRevisions reads a StatefulSet's or DaemonSet's revision
// trail from the ControllerRevisions it owns. Each ControllerRevision stores
// the pod template as a strategic-merge patch; the template is decoded to
// describe the revision and to detect which one is current (the one whose
// template matches the live workload, hash-free).
func controllerRevisionRevisions(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string) ([]WorkloadRevision, error) {
	revs, err := cs.AppsV1().ControllerRevisions(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	currentTemplate, err := liveTemplate(ctx, cs, namespace, kind, name)
	if err != nil {
		return nil, err
	}

	out := []WorkloadRevision{}
	for i := range revs.Items {
		cr := &revs.Items[i]
		if !ownedBy(cr.OwnerReferences, kind, name) {
			continue
		}
		tpl, err := decodeRevisionTemplate(cr.Data.Raw)
		if err != nil {
			continue // malformed history entry: skip rather than fail the list
		}
		changeCause := cr.Annotations[changeCauseAnnotation]
		if changeCause == "" && tpl.Annotations != nil {
			changeCause = tpl.Annotations[changeCauseAnnotation]
		}
		out = append(out, WorkloadRevision{
			Revision:    cr.Revision,
			Images:      containerImages(tpl.Spec.Containers),
			ChangeCause: changeCause,
			Age:         age(cr.CreationTimestamp),
			Current:     apiequality.Semantic.DeepEqual(tpl, currentTemplate),
		})
	}
	sortRevisionsDesc(out)
	return out, nil
}

// liveTemplate fetches the pod template a StatefulSet or DaemonSet runs now;
// it is the reference for which revision is current.
func liveTemplate(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string) (*corev1.PodTemplateSpec, error) {
	switch kind {
	case "StatefulSet":
		sts, err := cs.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		return &sts.Spec.Template, nil
	case "DaemonSet":
		ds, err := cs.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		return &ds.Spec.Template, nil
	default:
		return nil, fmt.Errorf("cannot read revisions for unsupported workload kind %q", kind)
	}
}

// decodeRevisionTemplate extracts the pod template from a ControllerRevision's
// data — a strategic-merge patch of the form {"spec":{"template":{...}}} with
// a "$patch":"replace" directive inside the template map (unknown keys are
// ignored by the decoder).
func decodeRevisionTemplate(raw []byte) (*corev1.PodTemplateSpec, error) {
	var patch struct {
		Spec struct {
			Template corev1.PodTemplateSpec `json:"template"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(raw, &patch); err != nil {
		return nil, err
	}
	return &patch.Spec.Template, nil
}

// RollbackWorkload restores a workload's pod template from a past revision,
// mirroring `kubectl rollout undo --to-revision=N` (0 = the previous
// revision). The result distinguishes an applied rollback from a skipped one:
// the target template already matches the current template, which kubectl
// reports as a skipped rollback rather than a failure. On success the
// controller replaces pods gradually according to the workload's update
// strategy.
func (c *Client) RollbackWorkload(ctx context.Context, namespace, kind, name string, revision int64) (RollbackResult, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return RollbackResult{}, err
	}
	switch kind {
	case "Deployment":
		return rollbackDeployment(ctx, cs, namespace, name, revision)
	case "StatefulSet", "DaemonSet":
		return rollbackControllerRevision(ctx, cs, namespace, kind, name, revision)
	default:
		return RollbackResult{}, fmt.Errorf("cannot roll back unsupported workload kind %q", kind)
	}
}

// rollbackDeployment restores a Deployment from one of its retained
// ReplicaSets. The pod template and the user-facing annotations are replaced
// wholesale with the revision's, exactly the patch kubectl applies; the
// controller then creates a new ReplicaSet and rolls pods over.
func rollbackDeployment(ctx context.Context, cs kubernetes.Interface, namespace, name string, revision int64) (RollbackResult, error) {
	deploy, err := cs.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return RollbackResult{}, err
	}

	target, err := deploymentRevisionRS(ctx, cs, deploy, revision)
	if err != nil {
		return RollbackResult{}, err
	}

	// kubectl refuses to roll back a paused deployment; the revision lookup
	// above runs first so an unknown revision is reported as such.
	if deploy.Spec.Paused {
		return RollbackResult{}, fmt.Errorf("cannot roll back a paused deployment; resume it first")
	}

	// A revision whose template already matches the live one is a no-op
	// (kubectl skips it too). Only the pod-template-hash label differs, and it
	// is deployment-internal, so it is ignored in the comparison.
	if equalIgnoreHash(&target.Spec.Template, &deploy.Spec.Template) {
		return RollbackResult{Skipped: true}, nil
	}

	// The hash label must not land on the Deployment template; the controller
	// re-derives it for the ReplicaSet it creates next. Work on a copy: the
	// listed ReplicaSet is shared state, not a scratch object.
	template := target.Spec.Template.DeepCopy()
	delete(template.Labels, appsv1.DefaultDeploymentUniqueLabelKey)

	// Mirror kubectl's annotation merge: the Deployment's own bookkeeping
	// annotations (revision, desired/max replicas, ...) are preserved, the
	// revision's bookkeeping values are NOT copied over them (they describe
	// the old rollout), and user annotations — e.g. kubernetes.io/change-cause
	// — come from the revision being restored.
	annotations := map[string]string{}
	for k := range rollbackSkippedAnnotations {
		if v, ok := deploy.Annotations[k]; ok {
			annotations[k] = v
		}
	}
	for k, v := range target.Annotations {
		if !rollbackSkippedAnnotations[k] {
			annotations[k] = v
		}
	}

	patch, err := json.Marshal([]interface{}{
		map[string]interface{}{"op": "replace", "path": "/spec/template", "value": template},
		map[string]interface{}{"op": "replace", "path": "/metadata/annotations", "value": annotations},
	})
	if err != nil {
		return RollbackResult{}, err
	}

	// The patch is idempotent, so RetryOnConflict is belt-and-braces rather
	// than a lost-update guard.
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		_, err := cs.AppsV1().Deployments(namespace).Patch(ctx, name, types.JSONPatchType, patch, metav1.PatchOptions{})
		return err
	})
	if err != nil {
		return RollbackResult{}, err
	}
	return RollbackResult{Applied: true}, nil
}

// equalIgnoreHash reports whether two pod templates match once the
// deployment-internal pod-template-hash label is set aside (the Deployment
// template never carries it, its ReplicaSets always do).
func equalIgnoreHash(t1, t2 *corev1.PodTemplateSpec) bool {
	c1 := t1.DeepCopy()
	c2 := t2.DeepCopy()
	delete(c1.Labels, appsv1.DefaultDeploymentUniqueLabelKey)
	delete(c2.Labels, appsv1.DefaultDeploymentUniqueLabelKey)
	return apiequality.Semantic.DeepEqual(c1, c2)
}

// deploymentRevisionRS selects the ReplicaSet serving the requested revision:
// an explicit one, or — for revision 0 — the previous revision, mirroring
// kubectl's "undo to last revision" rules.
func deploymentRevisionRS(ctx context.Context, cs kubernetes.Interface, deploy *appsv1.Deployment, toRevision int64) (*appsv1.ReplicaSet, error) {
	if toRevision < 0 {
		return nil, revisionNotFoundErr(toRevision)
	}
	rsList, err := cs.AppsV1().ReplicaSets(deploy.Namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	var (
		latestRS, previousRS *appsv1.ReplicaSet
		latestRev, prevRev   int64
	)
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		if !ownedBy(rs.OwnerReferences, "Deployment", deploy.Name) {
			continue
		}
		rev, ok := parseRevision(rs.Annotations)
		if !ok {
			continue
		}
		if toRevision == 0 {
			if latestRS == nil || rev > latestRev {
				previousRS = latestRS
				prevRev = latestRev
				latestRS = rs
				latestRev = rev
			} else if previousRS == nil || rev > prevRev {
				previousRS = rs
				prevRev = rev
			}
		} else if rev == toRevision {
			return rs, nil
		}
	}
	if toRevision == 0 {
		if previousRS == nil {
			return nil, fmt.Errorf("no rollout history found for deployment %q", deploy.Name)
		}
		return previousRS, nil
	}
	return nil, revisionNotFoundErr(toRevision)
}

// rollbackControllerRevision restores a StatefulSet or DaemonSet by applying
// the target ControllerRevision's stored patch directly — the same bytes the
// controller recorded, so the restored template is exactly what ran at that
// revision.
func rollbackControllerRevision(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string, revision int64) (RollbackResult, error) {
	if revision < 0 {
		return RollbackResult{}, revisionNotFoundErr(revision)
	}
	currentTemplate, err := liveTemplate(ctx, cs, namespace, kind, name)
	if err != nil {
		return RollbackResult{}, err
	}

	hist, err := cs.AppsV1().ControllerRevisions(namespace).List(ctx, listOptions())
	if err != nil {
		return RollbackResult{}, err
	}
	var revisions []*appsv1.ControllerRevision
	for i := range hist.Items {
		cr := &hist.Items[i]
		if ownedBy(cr.OwnerReferences, kind, name) {
			revisions = append(revisions, cr)
		}
	}

	var target *appsv1.ControllerRevision
	if revision == 0 {
		if len(revisions) <= 1 {
			return RollbackResult{}, fmt.Errorf("no last revision to roll back to")
		}
		sort.Slice(revisions, func(i, j int) bool { return revisions[i].Revision < revisions[j].Revision })
		target = revisions[len(revisions)-2]
	} else {
		for _, cr := range revisions {
			if cr.Revision == revision {
				target = cr
				break
			}
		}
		if target == nil {
			return RollbackResult{}, revisionNotFoundErr(revision)
		}
	}

	tpl, err := decodeRevisionTemplate(target.Data.Raw)
	if err != nil {
		return RollbackResult{}, fmt.Errorf("revision %d has unreadable history data: %v", target.Revision, err)
	}
	if apiequality.Semantic.DeepEqual(tpl, currentTemplate) {
		return RollbackResult{Skipped: true}, nil
	}

	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var err error
		switch kind {
		case "StatefulSet":
			_, err = cs.AppsV1().StatefulSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, target.Data.Raw, metav1.PatchOptions{})
		case "DaemonSet":
			_, err = cs.AppsV1().DaemonSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, target.Data.Raw, metav1.PatchOptions{})
		}
		return err
	})
	if err != nil {
		return RollbackResult{}, err
	}
	return RollbackResult{Applied: true}, nil
}

// parseRevision reads a revision annotation, reporting whether it was present
// and numeric.
func parseRevision(annotations map[string]string) (int64, bool) {
	if annotations == nil {
		return 0, false
	}
	v, err := strconv.ParseInt(annotations[deploymentRevisionAnnotation], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// sortRevisionsDesc orders history newest first.
func sortRevisionsDesc(revs []WorkloadRevision) {
	sort.Slice(revs, func(i, j int) bool { return revs[i].Revision > revs[j].Revision })
}

func revisionNotFoundErr(r int64) error {
	return fmt.Errorf("unable to find specified revision %d in history", r)
}
