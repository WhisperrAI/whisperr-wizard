import { createHash } from "node:crypto";
import type { Cluster, ClusterStatus, EventPlacement } from "./types.js";

export const MAX_CLUSTER_EVENTS = 4;
export const MAX_CONCURRENT_CLUSTERS = 4;

export function clusterIdFor(
  files: string[],
  eventIds: string[] = [],
  slicePosition = 0,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      files: [...files].sort(),
      events: [...eventIds].sort(),
      slicePosition,
    }))
    .digest("hex");
  return `cluster_${digest.slice(0, 12)}`;
}

export function deriveClusters(placements: EventPlacement[]): Cluster[] {
  const byFile = new Map<string, EventPlacement[]>();
  for (const placement of placements) {
    const existing = byFile.get(placement.file) ?? [];
    existing.push(placement);
    byFile.set(placement.file, existing);
  }

  // Split each file independently first. This is the invariant that lets the
  // scheduler prevent two agents from ever editing the same file at once.
  const fileSlices: Array<{ file: string; position: number; events: EventPlacement[] }> = [];
  for (const file of [...byFile.keys()].sort()) {
    const events = [...byFile.get(file)!].sort((a, b) =>
      a.eventCode.localeCompare(b.eventCode) || a.eventId.localeCompare(b.eventId)
    );
    for (let start = 0; start < events.length; start += MAX_CLUSTER_EVENTS) {
      fileSlices.push({
        file,
        position: start / MAX_CLUSTER_EVENTS,
        events: events.slice(start, start + MAX_CLUSTER_EVENTS),
      });
    }
  }

  // Small slices from different files can share a cluster. Never combine two
  // slices of the same file, and never exceed four events.
  const clusters: Cluster[] = [];
  const positions = new Map<string, number[]>();
  for (const slice of fileSlices) {
    let target = clusters.find((cluster) =>
      !cluster.files.includes(slice.file) &&
      cluster.events.length + slice.events.length <= MAX_CLUSTER_EVENTS
    );
    if (!target) {
      target = { id: "", files: [], events: [], status: "pending", attempts: 0 };
      clusters.push(target);
    }
    target.files.push(slice.file);
    target.events.push(...slice.events);
    const existing = positions.get(String(clusters.indexOf(target))) ?? [];
    existing.push(slice.position);
    positions.set(String(clusters.indexOf(target)), existing);
  }
  for (const [index, cluster] of clusters.entries()) {
    cluster.files.sort();
    cluster.events.sort((a, b) => a.eventCode.localeCompare(b.eventCode));
    cluster.id = clusterIdFor(
      cluster.files,
      cluster.events.map((event) => event.eventId || event.eventCode),
      Number((positions.get(String(index)) ?? [0]).join("")),
    );
  }
  return clusters;
}

export function nextConcurrentClusters(
  clusters: Cluster[],
  limit = MAX_CONCURRENT_CLUSTERS,
): Cluster[] {
  const selected: Cluster[] = [];
  const lockedFiles = new Set<string>();
  for (const cluster of clusters) {
    if (cluster.status !== "pending" && cluster.status !== "editing") continue;
    if (cluster.files.some((file) => lockedFiles.has(file))) continue;
    selected.push(cluster);
    for (const file of cluster.files) lockedFiles.add(file);
    if (selected.length === limit) break;
  }
  return selected;
}

const TERMINAL_STATUSES: ClusterStatus[] = ["reviewed", "failed_resumable", "blocked"];

export function nextPendingCluster(clusters: Cluster[]): Cluster | undefined {
  return clusters.find((cluster) => cluster.status === "pending" || cluster.status === "editing");
}

export function clustersComplete(clusters: Cluster[]): boolean {
  return clusters.every((cluster) => TERMINAL_STATUSES.includes(cluster.status));
}

export function transitionCluster(
  clusters: Cluster[],
  clusterId: string,
  status: ClusterStatus,
  note?: string,
): Cluster[] {
  return clusters.map((cluster) => {
    if (cluster.id !== clusterId) {
      return cluster;
    }
    const attempts = status === "editing" ? cluster.attempts + 1 : cluster.attempts;
    return { ...cluster, status, attempts, note: note ?? cluster.note };
  });
}
