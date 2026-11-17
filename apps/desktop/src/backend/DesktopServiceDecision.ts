import type { DesktopServiceQuitBehavior } from "@t3tools/contracts";

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
