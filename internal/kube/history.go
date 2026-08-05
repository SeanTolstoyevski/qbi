package kube

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
)

// deploymentRevisionAnnotation is stamped on Deployments and their ReplicaSets
// by the deployment controller; it increments on every rollout.
const deploymentRevisionAnnotation = "deployment.kubernetes.io/revision"

// History returns durable activity in a namespace: the rolled-out Deployments
// and their revision trails, newest activity first. Unlike Events — which the
// API server garbage-collects after roughly an hour — Deployments keep every
// ReplicaSet they ever created, so revision history answers "when was a
// deploy triggered" even when the events feed is empty.
//
// What gets returned is the caller's choice via opts (filter, deployment cap,
// revisions-per-deployment cap). The only implicit bound is the project-wide
// list safety valve (maxListItems), never a hidden app decision.
func (c *Client) History(ctx context.Context, namespace string, opts HistoryOptions) (NamespaceHistory, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return NamespaceHistory{}, err
	}

	deployments, err := cs.AppsV1().Deployments(namespace).List(ctx, listOptions())
	if err != nil {
		return NamespaceHistory{}, err
	}
	replicaSets, err := cs.AppsV1().ReplicaSets(namespace).List(ctx, listOptions())
	if err != nil {
		return NamespaceHistory{}, err
	}

	// Index ReplicaSets by the Deployment that owns them so we can rebuild
	// each Deployment's rollout history from a single pass.
	byDeploy := make(map[string][]appsv1.ReplicaSet)
	for i := range replicaSets.Items {
		rs := &replicaSets.Items[i]
		for _, owner := range rs.OwnerReferences {
			if owner.Kind == "Deployment" && owner.Name != "" {
				byDeploy[owner.Name] = append(byDeploy[owner.Name], *rs)
			}
		}
	}

	// A deployment that has never rolled out has no trail to show here, so it
	// is skipped; the user can still see it in the workloads table above.
	type digest struct {
		info   RolloutInfo
		newest time.Time // creation time of the newest ReplicaSet
	}
	digests := make([]digest, 0, len(deployments.Items))
	for i := range deployments.Items {
		d := &deployments.Items[i]
		if opts.Filter != "" && !strings.Contains(d.Name, opts.Filter) {
			continue
		}
		revisions := byDeploy[d.Name]
		sort.SliceStable(revisions, func(i, j int) bool {
			return revisionNum(revisions[i]) > revisionNum(revisions[j])
		})

		trail := make([]RevisionInfo, 0, len(revisions))
		for j := range revisions {
			rev := revisions[j].Annotations[deploymentRevisionAnnotation]
			if rev == "" {
				continue
			}
			trail = append(trail, RevisionInfo{
				Revision: rev,
				Age:      age(revisions[j].CreationTimestamp),
			})
			if opts.RevisionsPerDeploy > 0 && len(trail) >= opts.RevisionsPerDeploy {
				break
			}
		}
		if len(trail) == 0 {
			continue
		}

		digests = append(digests, digest{
			info: RolloutInfo{
				Name:     d.Name,
				Revision: d.Annotations[deploymentRevisionAnnotation],
				Rollouts: trail,
			},
			newest: revisions[0].CreationTimestamp.Time,
		})
	}

	// Newest activity first, then apply the user-chosen deployment cap.
	sort.SliceStable(digests, func(i, j int) bool {
		return digests[i].newest.After(digests[j].newest)
	})
	total := len(digests)
	if opts.MaxDeployments > 0 && len(digests) > opts.MaxDeployments {
		digests = digests[:opts.MaxDeployments]
	}

	out := make([]RolloutInfo, 0, len(digests))
	for _, dg := range digests {
		out = append(out, dg.info)
	}
	return NamespaceHistory{Rollouts: out, Total: total}, nil
}

// revisionNum parses a ReplicaSet's revision annotation for numeric sorting;
// unparseable revisions sort lowest so they never jump ahead of real ones.
func revisionNum(rs appsv1.ReplicaSet) int64 {
	n, _ := strconv.ParseInt(rs.Annotations[deploymentRevisionAnnotation], 10, 64)
	return n
}
