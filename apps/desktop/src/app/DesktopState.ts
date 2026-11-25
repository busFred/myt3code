import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Attachment } from "../backend/DesktopServiceConnection.ts";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";

/** What the attached background service reports it runs, published on each new service process. */
export interface AttachedServiceBuild {
  readonly serverVersion: string;
  readonly serverBuild: string | undefined;
}

/** Startup health of the primary local backend, read by the startup recovery window. */
export type PrimaryBackendStartup =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | ({ readonly _tag: "Failing" } & BackendStartupFailure);

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly localBackendAttachment: Ref.Ref<Option.Option<Attachment>>;
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    // True while the tray icon exists, so closing the main window can hide it instead.
    readonly trayActive: Ref.Ref<boolean>;
    // A choice made in the close dialog, consumed by the quit that follows so it does not ask again.
    readonly pendingQuitChoice: Ref.Ref<Option.Option<"app-only" | "app-and-service">>;
    readonly quitReason: Ref.Ref<"user" | "update">;
    // Set by DesktopUpdates.configure, which runs before the first backend start.
    readonly canInstallUpdates: Ref.Ref<boolean>;
    readonly primaryBackendStartup: SubscriptionRef.SubscriptionRef<PrimaryBackendStartup>;
    readonly attachedService: SubscriptionRef.SubscriptionRef<Option.Option<AttachedServiceBuild>>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  localBackendAttachment: Ref.make(Option.none<Attachment>()),
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  trayActive: Ref.make(false),
  pendingQuitChoice: Ref.make(Option.none<"app-only" | "app-and-service">()),
  quitReason: Ref.make<"user" | "update">("user"),
  canInstallUpdates: Ref.make(false),
  primaryBackendStartup: SubscriptionRef.make<PrimaryBackendStartup>({ _tag: "Starting" }),
  attachedService: SubscriptionRef.make(Option.none<AttachedServiceBuild>()),
});

export const layer = Layer.effect(DesktopState, make);
