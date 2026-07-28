import type { EngineProvider, EngineRole, RoleInvocation, RoleModelConfig, RoleOutcome } from "../types.js";

export function createRoutedProvider(
  routes: Partial<Record<EngineRole, EngineProvider>>,
  fallback: EngineProvider,
): EngineProvider {
  const providers = new Set<EngineProvider>([fallback, ...Object.values(routes)]);
  return {
    name: "routed",
    onRunReady(runId: string): void {
      for (const provider of providers) {
        provider.onRunReady?.(runId);
      }
    },
    invoke(
      invocation: RoleInvocation,
      config: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      const provider = routes[invocation.role] ?? fallback;
      return provider.invoke(invocation, config, onProgress);
    },
  };
}
