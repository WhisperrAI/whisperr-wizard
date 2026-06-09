import type { Playbook } from "../../types.js";
import { flutterPlaybook } from "./flutter.js";
import { nextjsPlaybook } from "./nextjs.js";
import { webPlaybook } from "./web.js";
import { reactNativePlaybook } from "./react-native.js";
import { swiftPlaybook } from "./swift.js";

/**
 * The playbook registry. This is the ONLY place that knows about specific SDKs.
 * To add support for a new language/framework, add one playbook file and append
 * it here — detection, the SDK-specific system prompt, and verification all
 * travel with the playbook.
 *
 * Order matters only for display; detection confidence decides what's chosen.
 * More-specific playbooks (nextjs, react-native) return null when a more
 * specific match should win, so the generic web playbook doesn't shadow them.
 */
export const ALL_PLAYBOOKS: Playbook[] = [
  flutterPlaybook,
  nextjsPlaybook,
  reactNativePlaybook,
  webPlaybook,
  swiftPlaybook,
];

export function playbookByTargetId(id: string): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.target.id === id);
}
