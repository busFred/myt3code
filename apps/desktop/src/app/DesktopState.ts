import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Attachment } from "../backend/DesktopServiceConnection.ts";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { DatabaseMigrationProgress } from "@t3tools/contracts";

import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";

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
    readonly quitReason: Ref.Ref<"user" | "update">;
    // Set by DesktopUpdates.configure, which runs before the first backend start.
    readonly canInstallUpdates: Ref.Ref<boolean>;
    readonly primaryBackendStartup: SubscriptionRef.SubscriptionRef<PrimaryBackendStartup>;
    readonly databaseMigrationProgress: Ref.Ref<DatabaseMigrationProgress | null>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  localBackendAttachment: Ref.make(Option.none<Attachment>()),
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  quitReason: Ref.make<"user" | "update">("user"),
  canInstallUpdates: Ref.make(false),
  primaryBackendStartup: SubscriptionRef.make<PrimaryBackendStartup>({ _tag: "Starting" }),
  databaseMigrationProgress: Ref.make<DatabaseMigrationProgress | null>(null),
});

export const layer = Layer.effect(DesktopState, make);
