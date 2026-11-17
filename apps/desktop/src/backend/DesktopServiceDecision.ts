import type { DesktopServiceQuitBehavior } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

export const launchDecision = (input: {
  readonly enabled: boolean;
  readonly wslOnly: boolean;
  readonly installed: boolean;
  readonly running: boolean;
  readonly otherBaseDir?: string | undefined;
  readonly owner: "none" | "service" | "other" | "unknown";
  readonly remembered: boolean;
  readonly quitBehavior: DesktopServiceQuitBehavior;
}) => {
  if (!input.enabled || input.wslOnly) return "own";
  if (input.owner === "unknown") return "unavailable";
  if (input.owner === "other") return "ask-connect";
  if (input.owner === "service" && input.otherBaseDir === undefined)
    return input.remembered ? "attach" : "ask-connect";
  if (!input.installed || input.otherBaseDir !== undefined) return "own";
  return input.quitBehavior === "app-and-service" ? "start-attach" : "ask-start";
};

export const quitDecision = (
  attachedToService: boolean,
  behavior: DesktopServiceQuitBehavior,
  reason: "user" | "update" | "shutdown",
) => {
  if (!attachedToService || reason !== "user" || behavior === "app-only") return "quit";
  return behavior === "ask" ? "ask" : "stop-quit";
};

export type ServiceUpdateTrigger = "install" | "attach" | "required";

export const serviceUpdateDecision = (input: {
  readonly trigger: ServiceUpdateTrigger;
  readonly serviceManaged: boolean;
  readonly serviceVersion: string | undefined;
  readonly targetVersion: string;
}) => {
  if (!input.serviceManaged || input.serviceVersion === input.targetVersion) return "skip";
  if (input.trigger === "install") return "ask";
  return input.serviceVersion !== undefined &&
    parseSemver(input.serviceVersion) !== null &&
    parseSemver(input.targetVersion) !== null &&
    compareSemverVersions(input.serviceVersion, input.targetVersion) < 0
    ? "ask"
    : "skip";
};

export const serviceUpdateResponse = (
  trigger: ServiceUpdateTrigger,
  phase: "confirm" | "failure",
  response: number,
) => {
  if (response === 0) return "update";
  if (trigger === "required") return "cancel";
  if (trigger === "attach" || (phase === "failure" && response === 1)) return "continue";
  return "cancel";
};
