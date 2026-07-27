import type { EnginePhase } from "./types.js";

export interface ProgressEvent {
  phase: EnginePhase;
  action: string;
  cluster?: { index: number; total: number };
  file?: string;
  level?: "info" | "error";
}

export function formatProgressLine(event: ProgressEvent): string {
  const parts: string[] = [event.phase];
  if (event.cluster) {
    parts.push(`cluster ${event.cluster.index}/${event.cluster.total}`);
  }
  if (event.file) {
    parts.push(event.file);
  }
  parts.push(event.action);
  return parts.join(" · ");
}

export interface ProgressSink {
  emit(event: ProgressEvent): void;
  heartbeat(phase: EnginePhase, action: string): void;
}

export interface ProgressSinkOptions {
  json: boolean;
  isTTY: boolean;
  write: (line: string) => void;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export function createProgressSink(options: ProgressSinkOptions): ProgressSink {
  const interval = options.heartbeatIntervalMs ?? 15_000;
  const now = options.now ?? (() => Date.now());
  let lastLineAt = 0;
  let lastLine = "";

  const writeLine = (line: string) => {
    lastLineAt = now();
    lastLine = line;
    options.write(line);
  };

  return {
    emit(event: ProgressEvent): void {
      if (options.json) {
        writeLine(JSON.stringify({ kind: "progress", ...event }));
        return;
      }
      const line = formatProgressLine(event);
      if (!options.isTTY && line === lastLine) {
        return;
      }
      writeLine(line);
    },
    heartbeat(phase: EnginePhase, action: string): void {
      if (now() - lastLineAt < interval) {
        return;
      }
      if (options.json) {
        writeLine(JSON.stringify({ kind: "heartbeat", phase, action }));
        return;
      }
      writeLine(`${phase} · still working · ${action}`);
    },
  };
}
