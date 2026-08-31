import type {
  EngineProvider,
  EngineRole,
  EngineTask,
  RoleInvocation,
  RoleModelConfig,
  RoleOutcome,
} from "../types.js";

type RouteKey = EngineTask | EngineRole;

export interface ProviderRoute {
  provider: EngineProvider;
}

/**
 * Routes each task to one fixed provider. There is deliberately no fallback,
 * circuit breaker, or provider reassignment: the model that owns a task keeps
 * it for the lifetime of the run.
 */
export function createRoutedProvider(
  routes: Partial<Record<RouteKey, EngineProvider | ProviderRoute>>,
  defaultProvider: EngineProvider,
): EngineProvider {
  const normalized = new Map<RouteKey, EngineProvider>();
  for (const [key, value] of Object.entries(routes) as Array<[RouteKey, EngineProvider | ProviderRoute]>) {
    normalized.set(key, "provider" in value ? value.provider : value);
  }
  const providers = new Set([defaultProvider, ...normalized.values()]);
  const routeFor = (invocation: RoleInvocation) =>
    normalized.get(invocation.task ?? invocation.role) ??
    normalized.get(invocation.role) ??
    defaultProvider;

  return {
    name: "fixed-routes",
    onRunReady(runId: string, resumeSessionId?: string): void {
      for (const provider of providers) {
        provider.onRunReady?.(runId, resumeSessionId);
      }
    },
    invoke(
      invocation: RoleInvocation,
      config: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      return routeFor(invocation).invoke(invocation, config, onProgress);
    },
  };
}
