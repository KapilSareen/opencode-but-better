import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite`, `task`, `background`, and `monitor` denies if the
 *    subagent's own ruleset doesn't already permit them. Subagents can neither
 *    spawn nor steer/kill siblings, parents, or monitors.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const canBackground = input.subagent.permission.some((rule) => rule.permission === "background")
  const canMonitor = input.subagent.permission.some((rule) => rule.permission === "monitor")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canBackground
      ? []
      : [{ permission: "background" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canMonitor ? [] : [{ permission: "monitor" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
