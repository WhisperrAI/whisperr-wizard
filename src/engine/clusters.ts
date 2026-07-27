import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { Cluster, ClusterStatus, EventPlacement } from "./types.js";

export const MIN_CLUSTER_EVENTS = 3;
export const MAX_CLUSTER_EVENTS = 8;

export function clusterIdFor(files: string[]): string {
  const digest = createHash("sha256")
    .update([...files].sort().join("\n"))
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

  const byDirectory = new Map<string, { files: Set<string>; events: EventPlacement[] }>();
  for (const [file, events] of byFile) {
    const directory = dirname(file);
    const bucket = byDirectory.get(directory) ?? { files: new Set<string>(), events: [] };
    bucket.files.add(file);
    bucket.events.push(...events);
    byDirectory.set(directory, bucket);
  }

  const clusters: Cluster[] = [];
  const pending: { files: Set<string>; events: EventPlacement[] }[] = [];
  for (const directory of [...byDirectory.keys()].sort()) {
    const bucket = byDirectory.get(directory)!;
    if (bucket.events.length >= MIN_CLUSTER_EVENTS) {
      pending.push(bucket);
      continue;
    }
    const last = pending[pending.length - 1];
    if (last && last.events.length + bucket.events.length <= MAX_CLUSTER_EVENTS) {
      for (const file of bucket.files) last.files.add(file);
      last.events.push(...bucket.events);
    } else {
      pending.push(bucket);
    }
  }

  for (const bucket of pending) {
    const events = [...bucket.events].sort((a, b) => a.eventCode.localeCompare(b.eventCode));
    for (let start = 0; start < events.length; start += MAX_CLUSTER_EVENTS) {
      const slice = events.slice(start, start + MAX_CLUSTER_EVENTS);
      const files = [...new Set(slice.map((event) => event.file))].sort();
      clusters.push({
        id: clusterIdFor(files.length > 0 ? files : [`slice_${start}`]),
        files,
        events: slice,
        status: "pending",
        attempts: 0,
      });
    }
  }
  return clusters;
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
