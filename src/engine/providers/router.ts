import { classifyFailure } from "../budgets.js";
import type {
  EngineProvider,
  EngineRole,
  EngineTask,
  RoleInvocation,
  RoleModelConfig,
  RoleOutcome,
} from "../types.js";

type RouteKey = EngineTask | EngineRole;

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export interface ProviderRoute {
  provider: EngineProvider;
  concurrency?: number;
  fallbackConfig?: RoleModelConfig;
}

function shouldFallback(outcome: RoleOutcome): boolean {
  return outcome.kind !== "completed";
}

function shouldDisableProvider(outcome: RoleOutcome): boolean {
  return outcome.kind === "failed" && classifyFailure(outcome.error) === "transient";
}

export function createRoutedProvider(
  routes: Partial<Record<RouteKey, EngineProvider | ProviderRoute>>,
  fallback: EngineProvider,
  fallbackConcurrency = 2,
): EngineProvider {
  const normalized = new Map<RouteKey, ProviderRoute>();
  for (const [key, value] of Object.entries(routes) as Array<[RouteKey, EngineProvider | ProviderRoute]>) {
    normalized.set(
      key,
      "provider" in value ? value : { provider: value },
    );
  }
  const providers = new Set<EngineProvider>([
    fallback,
    ...[...normalized.values()].map((route) => route.provider),
  ]);
  const semaphores = new Map<string, Semaphore>();
  const disabledRoutes = new Set<string>();
  const semaphoreFor = (key: string, concurrency?: number) => {
    let semaphore = semaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(concurrency ?? fallbackConcurrency);
      semaphores.set(key, semaphore);
    }
    return semaphore;
  };
  const invocationRouteKey = (invocation: RoleInvocation, config: RoleModelConfig) =>
    `${invocation.task ?? invocation.role}:${config.model}`;
  const routeFor = (invocation: RoleInvocation): ProviderRoute | undefined =>
    normalized.get(invocation.task ?? invocation.role) ?? normalized.get(invocation.role);
  const call = (
    provider: EngineProvider,
    concurrency: number | undefined,
    invocation: RoleInvocation,
    config: RoleModelConfig,
    onProgress: (action: string) => void,
    key = invocationRouteKey(invocation, config),
  ) => semaphoreFor(key, concurrency).run(() => provider.invoke(invocation, config, onProgress));
  const fallbackInvocation = (invocation: RoleInvocation): RoleInvocation => ({
    ...invocation,
    fallback: true,
    sessionKey: `fallback:${invocation.sessionKey ?? invocation.task ?? invocation.role}`,
  });

  return {
    name: "routed",
    onRunReady(runId: string, resumeSessionId?: string): void {
      disabledRoutes.clear();
      for (const provider of providers) {
        provider.onRunReady?.(runId, resumeSessionId);
      }
    },
    invoke(
      invocation: RoleInvocation,
      config: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      const route = routeFor(invocation);
      if (!route) {
        return call(fallback, fallbackConcurrency, invocation, config, onProgress);
      }
      const routeKey = invocationRouteKey(invocation, config);
      if (disabledRoutes.has(routeKey)) {
        return call(
          fallback,
          fallbackConcurrency,
          fallbackInvocation(invocation),
          route.fallbackConfig ?? config,
          onProgress,
          `fallback:${routeKey}`,
        );
      }
      return call(route.provider, route.concurrency, invocation, config, onProgress).then(
        async (outcome) => {
          // Read-only tasks are safe to retry immediately. Editing tasks must
          // first be rolled back by the cluster orchestrator.
          if (shouldDisableProvider(outcome)) {
            disabledRoutes.add(routeKey);
          }
          if (!invocation.allowRepoWrite && shouldFallback(outcome)) {
            onProgress(`${route.provider.name} unavailable; continuing with ${fallback.name}`);
            return call(
              fallback,
              fallbackConcurrency,
              fallbackInvocation(invocation),
              route.fallbackConfig ?? config,
              onProgress,
              `fallback:${routeKey}`,
            );
          }
          return outcome;
        },
      );
    },
    invokeFallback(
      invocation: RoleInvocation,
      config: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      return call(
        fallback,
        fallbackConcurrency,
        fallbackInvocation(invocation),
        config,
        onProgress,
        `fallback:${invocationRouteKey(invocation, config)}`,
      );
    },
  };
}
