package kube

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func int32Ptr(n int32) *int32 { return &n }

func TestWorkloadsReplicas(t *testing.T) {
	web := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"},
		Spec:       appsv1.DeploymentSpec{Replicas: int32Ptr(5)},
		Status:     appsv1.DeploymentStatus{Replicas: 1, ReadyReplicas: 1},
	}
	db := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "default"},
		Spec:       appsv1.StatefulSetSpec{Replicas: int32Ptr(3)},
		Status:     appsv1.StatefulSetStatus{Replicas: 3, ReadyReplicas: 2},
	}
	agent := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{Name: "agent", Namespace: "default"},
		Status:     appsv1.DaemonSetStatus{DesiredNumberScheduled: 4, NumberReady: 3},
	}

	implicit := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "one", Namespace: "default"},
	}

	c := newTestClient(web, db, agent, implicit)
	view, err := c.Workloads(context.Background(), "default")
	if err != nil {
		t.Fatalf("Workloads: %v", err)
	}

	got := map[string]WorkloadInfo{}
	for _, w := range view.Workloads {
		got[w.Name] = w
	}

	want := map[string]int32{"web": 5, "db": 3, "agent": 4, "one": 1}
	for name, n := range want {
		if got[name].Replicas != n {
			t.Errorf("%s replicas = %d, want %d", name, got[name].Replicas, n)
		}
	}

	if got["web"].Ready != "1/1" {
		t.Errorf("web ready = %q, want 1/1 (stale status fixture)", got["web"].Ready)
	}
}

func TestScaleWorkloadReplicasReflected(t *testing.T) {
	d := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"},
		Spec:       appsv1.DeploymentSpec{Replicas: int32Ptr(1)},
	}
	c := newTestClient(d)
	ctx := context.Background()

	if err := c.ScaleWorkload(ctx, "default", "Deployment", "web", 5); err != nil {
		t.Fatalf("ScaleWorkload: %v", err)
	}

	view, err := c.Workloads(ctx, "default")
	if err != nil {
		t.Fatalf("Workloads: %v", err)
	}
	if len(view.Workloads) != 1 || view.Workloads[0].Replicas != 5 {
		t.Fatalf("workloads after scale = %+v, want replicas 5", view.Workloads)
	}
}
