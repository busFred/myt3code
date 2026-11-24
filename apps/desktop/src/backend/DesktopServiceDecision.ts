import type { DesktopCloseWindowBehavior } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

export const launchDecision = (input: {
  readonly enabled: boolean;
  readonly wslOnly: boolean;
  readonly installed: boolean;
  readonly running: boolean;
  readonly otherBaseDir?: string | undefined;
  readonly owner: "none" | "service" | "other" | "unknown";
  readonly remembered: boolean;
  readonly closeWindowBehavior: DesktopCloseWindowBehavior;
}) => {
  if (!input.enabled || input.wslOnly) return "own";
  if (input.owner === "unknown") return "unavailable";
  if (input.owner === "other") return "ask-connect";
  if (input.owner === "service" && input.otherBaseDir === undefined)
    return input.remembered ? "attach" : "ask-connect";
  if (!input.installed || input.otherBaseDir !== undefined) return "own";
  return input.closeWindowBehavior === "app-and-service" ? "start-attach" : "ask-start";
};

/** Only a service stop chosen while closing the window stops it; every other quit leaves it running. */
export const quitDecision = (
  attachedToService: boolean,
  choice: "app-only" | "app-and-service" | undefined,
  reason: "user" | "update" | "shutdown",
) =>
  attachedToService && reason === "user" && choice === "app-and-service" ? "stop-quit" : "quit";

/** What closing the main window does; "ask" means show the close dialog. */
export const closeDecision = (input: {
  readonly behavior: DesktopCloseWindowBehavior;
  readonly attachedToService: boolean;
  readonly trayActive: boolean;
}) => {
  if (input.behavior === "app-only") return "quit";
  if (input.behavior === "app-and-service") return input.attachedToService ? "stop-quit" : "quit";
  // A tray that failed to start cannot bring the window back, so "tray" falls back to asking.
  if (input.behavior === "tray" && input.trayActive) return "hide";
  return input.attachedToService || input.trayActive ? "ask" : "quit";
};

export type CloseDialogChoice = "hide" | "app-only" | "app-and-service" | "quit";

/** Dialog options in button order; without a service the two quit choices collapse into one. */
export const closeDialogChoices = (input: {
  readonly attachedToService: boolean;
  readonly trayActive: boolean;
}): ReadonlyArray<CloseDialogChoice> => [
  ...(input.trayActive ? (["hide"] as const) : []),
  ...(input.attachedToService ? (["app-only", "app-and-service"] as const) : (["quit"] as const)),
];

/** The setting a remembered dialog choice saves. */
export const closeChoiceBehavior = (choice: CloseDialogChoice): DesktopCloseWindowBehavior =>
  choice === "hide" ? "tray" : choice === "quit" ? "app-only" : choice;

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
