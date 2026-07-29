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
  if (outcome.kind === "context_overflow" || outcome.kind === "budget_exhausted") {
    return true;
  }
  return outcome.kind === "failed" && classifyFailure(outcome.error) !== "fatal";
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
  const semaphores = new Map<EngineProvider, Semaphore>();
  const disabledProviders = new Set<EngineProvider>();
  const semaphoreFor = (provider: EngineProvider, concurrency?: number) => {
    let semaphore = semaphores.get(provider);
    if (!semaphore) {
      semaphore = new Semaphore(concurrency ?? (provider === fallback ? fallbackConcurrency : 4));
      semaphores.set(provider, semaphore);
    }
    return semaphore;
  };
  const routeFor = (invocation: RoleInvocation): ProviderRoute | undefined =>
    normalized.get(invocation.task ?? invocation.role) ?? normalized.get(invocation.role);
  const call = (
    provider: EngineProvider,
    concurrency: number | undefined,
    invocation: RoleInvocation,
    config: RoleModelConfig,
    onProgress: (action: string) => void,
  ) => semaphoreFor(provider, concurrency).run(() => provider.invoke(invocation, config, onProgress));

  return {
    name: "routed",
    onRunReady(runId: string, resumeSessionId?: string): void {
      disabledProviders.clear();
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
      if (disabledProviders.has(route.provider)) {
        return call(
          fallback,
          fallbackConcurrency,
          invocation,
          route.fallbackConfig ?? config,
          onProgress,
        );
      }
      return call(route.provider, route.concurrency, invocation, config, onProgress).then(
        async (outcome) => {
          // Read-only tasks are safe to retry immediately. Editing tasks must
          // first be rolled back by the cluster orchestrator.
          if (shouldDisableProvider(outcome)) {
            disabledProviders.add(route.provider);
          }
          if (!invocation.allowRepoWrite && shouldFallback(outcome)) {
            onProgress(`${route.provider.name} unavailable; continuing with ${fallback.name}`);
            return call(
              fallback,
              fallbackConcurrency,
              invocation,
              route.fallbackConfig ?? config,
              onProgress,
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
      return call(fallback, fallbackConcurrency, invocation, config, onProgress);
    },
  };
}
