import { createHash } from "node:crypto";
import type { Cluster, ClusterStatus, EventPlacement } from "./types.js";

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

  const fileSlices: Array<{ file: string; position: number; events: EventPlacement[] }> = [];
  for (const file of [...byFile.keys()].sort()) {
    const events = [...byFile.get(file)!].sort((a, b) =>
      a.eventCode.localeCompare(b.eventCode) || a.eventId.localeCompare(b.eventId)
    );
    fileSlices.push({ file, position: 0, events });
  }

  return fileSlices.map((slice) => {
    const events = [...slice.events].sort((a, b) => a.eventCode.localeCompare(b.eventCode));
    return {
      id: clusterIdFor(
        [slice.file],
        events.map((event) => event.eventId || event.eventCode),
        slice.position,
      ),
      files: [slice.file],
      events,
      status: "pending",
      attempts: 0,
    };
  });
}

export function nextConcurrentClusters(
  clusters: Cluster[],
  limit = 1,
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

const TERMINAL_STATUSES: ClusterStatus[] = ["verified", "reviewed", "failed_resumable", "blocked"];

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
