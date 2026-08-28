package kube

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// ── fixtures ────────────────────────────────────────────────────────────────

// podTemplate builds a minimal one-container pod template. The app label
// doubles as the selector label, like the Deployment create form produces.
func podTemplate(image string) corev1.PodTemplateSpec {
	return corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "web"}},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "web", Image: image}},
		},
	}
}

// revisionRS builds a ReplicaSet of a given revision owned by Deployment
// "web". Real ReplicaSets always carry the pod-template-hash label; the
// fixture does too so the rollback no-op detection is exercised for real.
func revisionRS(name, image, changeCause string, rev int64, ready, desired int32) *appsv1.ReplicaSet {
	rs := &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "default",
			Annotations:       map[string]string{deploymentRevisionAnnotation: strconv.FormatInt(rev, 10)},
			OwnerReferences:   []metav1.OwnerReference{{Kind: "Deployment", Name: "web", Controller: boolPtr(true)}},
			CreationTimestamp: metav1.NewTime(time.Now().Add(-time.Duration(rev) * time.Hour)),
		},
		Spec: appsv1.ReplicaSetSpec{Template: podTemplate(image)},
		Status: appsv1.ReplicaSetStatus{
			Replicas:      desired,
			ReadyReplicas: ready,
		},
	}
	rs.Spec.Template.Labels["pod-template-hash"] = "hash-" + name
	if changeCause != "" {
		rs.Annotations[changeCauseAnnotation] = changeCause
	}
	return rs
}

// deploymentFixture is a Deployment at revision 3 (image nginx:1.27) with a
// full annotation set: user notes, controller bookkeeping, and a custom
// deployment-metadata-only annotation (which kubectl's annotation merge does
// NOT carry over a rollback — only bookkeeping and the revision's own
// annotations survive).
func deploymentFixture(paused bool) *appsv1.Deployment {
	d := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "web",
			Namespace: "default",
			Annotations: map[string]string{
				deploymentRevisionAnnotation:                "3",
				changeCauseAnnotation:                       "go live 1.27",
				"deployment.kubernetes.io/desired-replicas": "3",
				"custom.example/keep":                       "yes",
			},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: int32Ptr(3),
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
			Template: podTemplate("nginx:1.27"),
			Paused:   paused,
		},
	}
	return d
}

// revisionPatch encodes a pod template the way the StatefulSet and DaemonSet
// controllers do when they record a ControllerRevision: a strategic-merge
// patch with a "$patch":"replace" directive inside the template map.
func revisionPatch(tpl corev1.PodTemplateSpec) []byte {
	raw, _ := json.Marshal(tpl)
	var m map[string]interface{}
	_ = json.Unmarshal(raw, &m)
	m["$patch"] = "replace"
	patch, _ := json.Marshal(map[string]interface{}{"spec": map[string]interface{}{"template": m}})
	return patch
}

// controllerRevision builds a revision of a StatefulSet or DaemonSet owned by
// the named workload. The change-cause note is recorded on the revision
// object itself (that is where kubectl reads it from for these kinds).
func controllerRevision(name, kind, owner, image string, rev int64, changeCause string) *appsv1.ControllerRevision {
	tpl := podTemplate(image)
	tpl.ObjectMeta.Labels = map[string]string{"app": owner}
	cr := &appsv1.ControllerRevision{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "default",
			OwnerReferences:   []metav1.OwnerReference{{Kind: kind, Name: owner, Controller: boolPtr(true)}},
			CreationTimestamp: metav1.NewTime(time.Now().Add(-time.Duration(rev) * time.Hour)),
		},
		Data:     runtime.RawExtension{Raw: revisionPatch(tpl)},
		Revision: rev,
	}
	if changeCause != "" {
		cr.Annotations = map[string]string{changeCauseAnnotation: changeCause}
	}
	return cr
}

// deploymentOnly seeds the fake client with just the Deployment, so tests can
// cover the no-history edge.
func deploymentOnly(paused bool) *Client {
	return newTestClient(deploymentFixture(paused))
}

// ── revision listing ────────────────────────────────────────────────────────

func TestWorkloadRevisionsDeployment(t *testing.T) {
	c := newTestClient(
		deploymentFixture(false),
		revisionRS("web-7d8f6", "nginx:1.21", "", 1, 0, 1),
		revisionRS("web-9c4b2", "nginx:1.24", "bump to 1.24", 2, 3, 3),
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
		// A ReplicaSet of a different Deployment must not leak into the trail.
		forOwner(revisionRS("other-x1", "nginx:1.0", "", 1, 0, 0), "other"),
	)

	revs, err := c.WorkloadRevisions(context.Background(), "default", "Deployment", "web")
	if err != nil {
		t.Fatalf("WorkloadRevisions: %v", err)
	}
	if len(revs) != 3 {
		t.Fatalf("got %d revisions, want 3: %+v", len(revs), revs)
	}
	// Newest first.
	if revs[0].Revision != 3 || revs[1].Revision != 2 || revs[2].Revision != 1 {
		t.Fatalf("revision order = %d,%d,%d, want 3,2,1", revs[0].Revision, revs[1].Revision, revs[2].Revision)
	}
	if !revs[0].Current || revs[1].Current || revs[2].Current {
		t.Errorf("current flags = %v,%v,%v, want true,false,false", revs[0].Current, revs[1].Current, revs[2].Current)
	}
	if len(revs[1].Images) != 1 || revs[1].Images[0] != "nginx:1.24" {
		t.Errorf("revision 2 images = %v, want [nginx:1.24]", revs[1].Images)
	}
	if revs[1].ChangeCause != "bump to 1.24" {
		t.Errorf("revision 2 change cause = %q, want %q", revs[1].ChangeCause, "bump to 1.24")
	}
	if revs[2].Replicas != "0/1" {
		t.Errorf("revision 1 replicas = %q, want 0/1", revs[2].Replicas)
	}
	if revs[0].Age == "" {
		t.Error("revision 3 age is empty, want a human-readable age")
	}
}

// forOwner rewrites an RS fixture to belong to another Deployment.
func forOwner(rs *appsv1.ReplicaSet, name string) *appsv1.ReplicaSet {
	rs.OwnerReferences = []metav1.OwnerReference{{Kind: "Deployment", Name: name, Controller: boolPtr(true)}}
	return rs
}

func TestWorkloadRevisionsStatefulSet(t *testing.T) {
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "default"},
		Spec: appsv1.StatefulSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}},
			Template: func() corev1.PodTemplateSpec {
				tpl := podTemplate("mysql:8.0")
				tpl.ObjectMeta.Labels = map[string]string{"app": "db"}
				return tpl
			}(),
		},
	}
	c := newTestClient(
		sts,
		controllerRevision("db-5c1f", "StatefulSet", "db", "mysql:5.7", 1, "migrate to 5.7"),
		controllerRevision("db-9e2a", "StatefulSet", "db", "mysql:8.0", 2, ""),
		// A revision of another StatefulSet must not leak into the trail.
		controllerRevision("other-c1", "StatefulSet", "other", "mysql:5.0", 1, ""),
	)

	revs, err := c.WorkloadRevisions(context.Background(), "default", "StatefulSet", "db")
	if err != nil {
		t.Fatalf("WorkloadRevisions: %v", err)
	}
	if len(revs) != 2 {
		t.Fatalf("got %d revisions, want 2: %+v", len(revs), revs)
	}
	if revs[0].Revision != 2 || !revs[0].Current {
		t.Errorf("newest = revision %d current=%v, want revision 2 current=true", revs[0].Revision, revs[0].Current)
	}
	if revs[1].Revision != 1 || revs[1].Current {
		t.Errorf("oldest = revision %d current=%v, want revision 1 current=false", revs[1].Revision, revs[1].Current)
	}
	if len(revs[1].Images) != 1 || revs[1].Images[0] != "mysql:5.7" {
		t.Errorf("revision 1 images = %v, want [mysql:5.7]", revs[1].Images)
	}
	if revs[1].ChangeCause != "migrate to 5.7" {
		t.Errorf("revision 1 change cause = %q, want %q", revs[1].ChangeCause, "migrate to 5.7")
	}
}

func TestWorkloadRevisionsDaemonSet(t *testing.T) {
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
		Spec: appsv1.DaemonSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "agent"}},
			Template: func() corev1.PodTemplateSpec {
				tpl := podTemplate("agent:2.0")
				tpl.ObjectMeta.Labels = map[string]string{"app": "agent"}
				return tpl
			}(),
		},
	}
	c := newTestClient(
		ds,
		controllerRevision("agent-1a", "DaemonSet", "agent", "agent:1.0", 1, ""),
		controllerRevision("agent-2b", "DaemonSet", "agent", "agent:2.0", 2, "ship 2.0"),
	)

	revs, err := c.WorkloadRevisions(context.Background(), "default", "DaemonSet", "agent")
	if err != nil {
		t.Fatalf("WorkloadRevisions: %v", err)
	}
	if len(revs) != 2 || revs[0].Revision != 2 || !revs[0].Current {
		t.Fatalf("revisions = %+v, want revision 2 current first", revs)
	}
	if revs[0].ChangeCause != "ship 2.0" {
		t.Errorf("revision 2 change cause = %q, want %q", revs[0].ChangeCause, "ship 2.0")
	}
}

func TestWorkloadRevisionsUnsupportedKind(t *testing.T) {
	c := newTestClient()
	if _, err := c.WorkloadRevisions(context.Background(), "default", "CronJob", "x"); err == nil ||
		!strings.Contains(err.Error(), "unsupported workload kind") {
		t.Fatalf("WorkloadRevisions(CronJob) error = %v, want unsupported-kind error", err)
	}
}

// Some clusters record the change-cause inside the stored template instead of
// on the ControllerRevision itself; the fallback must surface it.
func TestWorkloadRevisionsChangeCauseFromTemplate(t *testing.T) {
	tpl := podTemplate("agent:1.0")
	tpl.ObjectMeta.Labels = map[string]string{"app": "agent"}
	tpl.Annotations = map[string]string{changeCauseAnnotation: "ship 1.0"}
	cr := &appsv1.ControllerRevision{
		ObjectMeta: metav1.ObjectMeta{
			Name:            "agent-1a",
			Namespace:       "default",
			OwnerReferences: []metav1.OwnerReference{{Kind: "DaemonSet", Name: "agent", Controller: boolPtr(true)}},
		},
		Data:     runtime.RawExtension{Raw: revisionPatch(tpl)},
		Revision: 1,
	}
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
		Spec: appsv1.DaemonSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "agent"}},
			Template: tpl,
		},
	}
	c := newTestClient(ds, cr)
	revs, err := c.WorkloadRevisions(context.Background(), "default", "DaemonSet", "agent")
	if err != nil {
		t.Fatalf("WorkloadRevisions: %v", err)
	}
	if len(revs) != 1 || revs[0].ChangeCause != "ship 1.0" {
		t.Fatalf("revisions = %+v, want change cause %q surfaced from the template", revs, "ship 1.0")
	}
	if !revs[0].Current {
		t.Error("revision whose template matches the live one must be marked current")
	}
}

// ── Deployment rollback ─────────────────────────────────────────────────────

func TestRollbackDeploymentRestoresRevision(t *testing.T) {
	// A user annotation on the restored ReplicaSet (template lineage) flows
	// onto the Deployment; deployment-metadata-only annotations do not —
	// that is kubectl's exact annotation merge.
	rs2 := revisionRS("web-9c4b2", "nginx:1.24", "bump to 1.24", 2, 3, 3)
	rs2.Annotations["custom.example/keep"] = "yes"
	c := newTestClient(
		deploymentFixture(false),
		revisionRS("web-7d8f6", "nginx:1.21", "", 1, 0, 1),
		rs2,
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
	)
	ctx := context.Background()

	applied, err := c.RollbackWorkload(ctx, "default", "Deployment", "web", 2)
	if err != nil {
		t.Fatalf("RollbackWorkload: %v", err)
	}
	if !applied.Applied {
		t.Fatal("rollback to a different template reported applied=false")
	}
	if applied.Skipped {
		t.Fatal("rollback to a different template reported skipped=true")
	}

	d, err := c.clientset.AppsV1().Deployments("default").Get(ctx, "web", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get deployment: %v", err)
	}
	if got := d.Spec.Template.Spec.Containers[0].Image; got != "nginx:1.24" {
		t.Errorf("template image = %q, want nginx:1.24", got)
	}
	if _, has := d.Spec.Template.Labels["pod-template-hash"]; has {
		t.Error("pod-template-hash leaked onto the Deployment template")
	}
	// The merged annotations mirror kubectl exactly: the Deployment's own
	// bookkeeping annotations are preserved (dropping them would blank the
	// UI's "current revision" marker for a sync cycle), user annotations come
	// from the restored revision, and the deployment's stale change-cause
	// ("go live 1.27") is replaced by the revision's.
	want := map[string]string{
		deploymentRevisionAnnotation:               "3",
		"deployment.kubernetes.io/desired-replicas": "3",
		changeCauseAnnotation:                       "bump to 1.24",
		"custom.example/keep":                       "yes",
	}
	for k, v := range want {
		if got := d.Annotations[k]; got != v {
			t.Errorf("annotation %q = %q, want %q", k, got, v)
		}
	}
	if len(d.Annotations) != len(want) {
		t.Errorf("annotations = %v, want exactly %v", d.Annotations, want)
	}
}

func TestRollbackDeploymentSkippedWhenTemplateMatches(t *testing.T) {
	c := newTestClient(
		deploymentFixture(false),
		revisionRS("web-9c4b2", "nginx:1.24", "bump to 1.24", 2, 3, 3),
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
	)
	ctx := context.Background()

	// Rolling back to the current revision is a no-op, not an error
	// (kubectl reports it as a skipped rollback).
	result, err := c.RollbackWorkload(ctx, "default", "Deployment", "web", 3)
	if err != nil {
		t.Fatalf("RollbackWorkload(current): %v", err)
	}
	if result.Applied {
		t.Fatal("rollback to the current template reported applied=true")
	}
	if !result.Skipped {
		t.Fatal("rollback to the current template reported skipped=false")
	}
	d, err := c.clientset.AppsV1().Deployments("default").Get(ctx, "web", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get deployment: %v", err)
	}
	if got := d.Spec.Template.Spec.Containers[0].Image; got != "nginx:1.27" {
		t.Errorf("template image changed to %q, want nginx:1.27 untouched", got)
	}
}

func TestRollbackDeploymentPaused(t *testing.T) {
	c := newTestClient(
		deploymentFixture(true),
		revisionRS("web-9c4b2", "nginx:1.24", "bump to 1.24", 2, 3, 3),
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
	)
	_, err := c.RollbackWorkload(context.Background(), "default", "Deployment", "web", 2)
	if err == nil || !strings.Contains(err.Error(), "paused") {
		t.Fatalf("rollback of a paused deployment error = %v, want paused hint", err)
	}
}

func TestRollbackDeploymentRevisionNotFound(t *testing.T) {
	c := newTestClient(
		deploymentFixture(false),
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
	)
	ctx := context.Background()
	for _, rev := range []int64{99, -1} {
		if _, err := c.RollbackWorkload(ctx, "default", "Deployment", "web", rev); err == nil ||
			!strings.Contains(err.Error(), "unable to find specified revision") {
			t.Errorf("rollback to revision %d error = %v, want not-found error", rev, err)
		}
	}
}

func TestRollbackDeploymentNoHistory(t *testing.T) {
	c := deploymentOnly(false)
	_, err := c.RollbackWorkload(context.Background(), "default", "Deployment", "web", 0)
	if err == nil || !strings.Contains(err.Error(), "no rollout history found") {
		t.Fatalf("rollback with no history error = %v, want no-history error", err)
	}
	// Listing an unrolled-out deployment is fine: empty trail, no error.
	revs, err := c.WorkloadRevisions(context.Background(), "default", "Deployment", "web")
	if err != nil {
		t.Fatalf("WorkloadRevisions on unrolled deployment: %v", err)
	}
	if len(revs) != 0 {
		t.Fatalf("revisions = %+v, want none", revs)
	}
}

func TestRollbackDeploymentPreviousRevision(t *testing.T) {
	c := newTestClient(
		deploymentFixture(false),
		revisionRS("web-7d8f6", "nginx:1.21", "", 1, 0, 1),
		revisionRS("web-9c4b2", "nginx:1.24", "bump to 1.24", 2, 3, 3),
		revisionRS("web-a1b2c", "nginx:1.27", "go live 1.27", 3, 3, 3),
	)
	ctx := context.Background()

	applied, err := c.RollbackWorkload(ctx, "default", "Deployment", "web", 0)
	if err != nil {
		t.Fatalf("RollbackWorkload(0): %v", err)
	}
	if !applied.Applied {
		t.Fatal("rollback to previous revision reported applied=false")
	}
	d, err := c.clientset.AppsV1().Deployments("default").Get(ctx, "web", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get deployment: %v", err)
	}
	if got := d.Spec.Template.Spec.Containers[0].Image; got != "nginx:1.24" {
		t.Errorf("template image = %q, want nginx:1.24 (previous revision)", got)
	}
}

// ── StatefulSet / DaemonSet rollback ────────────────────────────────────────

func TestRollbackStatefulSet(t *testing.T) {
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "default"},
		Spec: appsv1.StatefulSetSpec{
			Replicas: int32Ptr(3),
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}},
			Template: func() corev1.PodTemplateSpec {
				tpl := podTemplate("mysql:8.0")
				tpl.ObjectMeta.Labels = map[string]string{"app": "db"}
				return tpl
			}(),
		},
	}
	c := newTestClient(
		sts,
		controllerRevision("db-5c1f", "StatefulSet", "db", "mysql:5.7", 1, "migrate to 5.7"),
		controllerRevision("db-9e2a", "StatefulSet", "db", "mysql:8.0", 2, ""),
	)
	ctx := context.Background()

	// Rolling back to the current revision is a no-op.
	result, err := c.RollbackWorkload(ctx, "default", "StatefulSet", "db", 2)
	if err != nil || result.Applied {
		t.Fatalf("rollback to current revision = applied:%v err:%v, want applied=false err=nil", result.Applied, err)
	}
	if !result.Skipped {
		t.Fatal("rollback to current revision reported skipped=false")
	}
	// Unknown revision errors.
	if _, err := c.RollbackWorkload(ctx, "default", "StatefulSet", "db", 42); err == nil ||
		!strings.Contains(err.Error(), "unable to find specified revision") {
		t.Fatalf("rollback to unknown revision error = %v, want not-found error", err)
	}

	applied, err := c.RollbackWorkload(ctx, "default", "StatefulSet", "db", 1)
	if err != nil {
		t.Fatalf("RollbackWorkload: %v", err)
	}
	if !applied.Applied {
		t.Fatal("rollback to a different template reported applied=false")
	}
	got, err := c.clientset.AppsV1().StatefulSets("default").Get(ctx, "db", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get statefulset: %v", err)
	}
	if image := got.Spec.Template.Spec.Containers[0].Image; image != "mysql:5.7" {
		t.Errorf("template image = %q, want mysql:5.7", image)
	}
}

func TestRollbackDaemonSet(t *testing.T) {
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
		Spec: appsv1.DaemonSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "agent"}},
			Template: func() corev1.PodTemplateSpec {
				tpl := podTemplate("agent:2.0")
				tpl.ObjectMeta.Labels = map[string]string{"app": "agent"}
				return tpl
			}(),
		},
	}
	c := newTestClient(
		ds,
		controllerRevision("agent-1a", "DaemonSet", "agent", "agent:1.0", 1, ""),
		controllerRevision("agent-2b", "DaemonSet", "agent", "agent:2.0", 2, "ship 2.0"),
	)
	ctx := context.Background()

	applied, err := c.RollbackWorkload(ctx, "default", "DaemonSet", "agent", 1)
	if err != nil {
		t.Fatalf("RollbackWorkload: %v", err)
	}
	if !applied.Applied {
		t.Fatal("rollback to a different template reported applied=false")
	}
	got, err := c.clientset.AppsV1().DaemonSets("default").Get(ctx, "agent", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get daemonset: %v", err)
	}
	if image := got.Spec.Template.Spec.Containers[0].Image; image != "agent:1.0" {
		t.Errorf("template image = %q, want agent:1.0", image)
	}

	// The previous-revision path (revision 0) mirrors kubectl: "previous"
	// means the second-newest revision, which right after a rollback is the
	// template already running — so it is a skip, not a change.
	result, err := c.RollbackWorkload(ctx, "default", "DaemonSet", "agent", 0)
	if err != nil {
		t.Fatalf("RollbackWorkload(0): %v", err)
	}
	if result.Applied {
		t.Fatal("rollback to the already-running template reported applied=true")
	}
	if !result.Skipped {
		t.Fatal("rollback to the already-running template reported skipped=false")
	}
	got, err = c.clientset.AppsV1().DaemonSets("default").Get(ctx, "agent", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("re-get daemonset: %v", err)
	}
	if image := got.Spec.Template.Spec.Containers[0].Image; image != "agent:1.0" {
		t.Errorf("template image after skipped rollback = %q, want agent:1.0", image)
	}
}

func TestRollbackControllerRevisionNoHistory(t *testing.T) {
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "default"},
		Spec: appsv1.StatefulSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}},
			Template: podTemplate("mysql:8.0"),
		},
	}
	c := newTestClient(sts)
	_, err := c.RollbackWorkload(context.Background(), "default", "StatefulSet", "db", 0)
	if err == nil || !strings.Contains(err.Error(), "no last revision") {
		t.Fatalf("rollback with no history error = %v, want no-last-revision error", err)
	}
}

func TestRollbackWorkloadUnsupportedKind(t *testing.T) {
	c := newTestClient()
	if _, err := c.RollbackWorkload(context.Background(), "default", "CronJob", "x", 1); err == nil ||
		!strings.Contains(err.Error(), "unsupported workload kind") {
		t.Fatalf("RollbackWorkload(CronJob) error = %v, want unsupported-kind error", err)
	}
}
