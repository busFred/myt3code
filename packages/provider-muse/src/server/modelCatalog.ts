import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import type { SendUserTurnOptions } from "@muse-code/sdk";
import { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  createMuseSdkHost,
  createMuseSdkHostEffect,
  MuseSdkError,
  type MuseSdkHost,
} from "./sdk.ts";
import { MuseSubscriptionUsage } from "./protocol.ts";

export const resolveMuseStartupTimeoutMs = (environment?: NodeJS.ProcessEnv) =>
  resolveProviderProbeTimeoutMs("muse", 8_000, environment);

type MuseReasoningEffort = NonNullable<SendUserTurnOptions<never>["reasoningEffort"]>;

const REASONING_EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
} satisfies Record<MuseReasoningEffort, string>;

const isMuseReasoningEffort = (tier: string): tier is MuseReasoningEffort =>
  Object.hasOwn(REASONING_EFFORT_LABELS, tier);

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_DEFAULT_EFFORT = "high";

const ModelCatalogEntry = Schema.Struct({
  modelId: Schema.NonEmptyString,
  displayLabel: Schema.String,
  providerId: Schema.String,
  isDefault: Schema.Boolean,
  variants: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")])),
  defaultReasoningEffort: Schema.optional(Schema.String),
  reasoningEffortVariants: Schema.optional(
    Schema.Array(
      Schema.Struct({ tier: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeModelList = Schema.decodeUnknownEffect(
  Schema.Struct({ providerId: Schema.String, models: Schema.Array(ModelCatalogEntry) }),
);
const decodeUsage = Schema.decodeUnknownEffect(
  Schema.Struct({ usage: Schema.optional(MuseSubscriptionUsage) }),
);
const USAGE_READ_TIMEOUT_MS = 2_000;

export function museModelCapabilities(
  model?: Pick<
    typeof ModelCatalogEntry.Type,
    "variants" | "defaultReasoningEffort" | "reasoningEffortVariants"
  >,
): ModelCapabilities {
  const reported = model?.variants !== undefined && model.variants !== "unknown";
  const efforts = (reported ? model.variants : FALLBACK_EFFORTS).filter(isMuseReasoningEffort);
  const preferredDefault = reported ? model?.defaultReasoningEffort : FALLBACK_DEFAULT_EFFORT;
  const defaultValue = efforts.find((tier) => tier === preferredDefault) ?? efforts[0];
  if (!defaultValue) return createModelCapabilities({ optionDescriptors: [] });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: defaultValue,
        options: efforts.map((id) => {
          const description = model?.reasoningEffortVariants?.find(
            (variant) => variant.tier === id,
          )?.description;
          return {
            id,
            label: REASONING_EFFORT_LABELS[id],
            ...(id === defaultValue ? { isDefault: true } : {}),
            ...(description ? { description } : {}),
          };
        }),
      },
    ],
  });
}

export function resolveMuseReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!capabilities) return effort;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((descriptor) => descriptor.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

export const discoverMuseModels = Effect.fn("discoverMuseModels")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv | undefined,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const host = yield* Effect.acquireRelease(
    createMuseSdkHostEffect(
      {
        binaryPath: settings.binaryPath,
        ...(environment ? { environment } : {}),
        ...(cwd ? { cwd } : {}),
        readOnly: true,
        startupTimeoutMs: resolveMuseStartupTimeoutMs(environment),
      },
      createHost,
    ),
    (host: MuseSdkHost) => Effect.promise(() => host.close()),
    { interruptible: true },
  );
  const result = yield* Effect.all(
    {
      catalog: Effect.tryPromise({
        try: () => host.connection.request("model/list", {}),
        catch: (cause) => new MuseSdkError({ operation: "model/list", cause }),
      }).pipe(Effect.flatMap(decodeModelList)),
      usage: Effect.tryPromise({
        try: () => host.connection.request("usage/read", {}),
        catch: (cause) => new MuseSdkError({ operation: "usage/read", cause }),
      }).pipe(
        Effect.flatMap(decodeUsage),
        Effect.map((result) => result.usage),
        Effect.timeoutOption(USAGE_READ_TIMEOUT_MS),
        Effect.option,
        Effect.map(Option.flatten),
        Effect.map(Option.getOrUndefined),
      ),
    },
    { concurrency: "unbounded" },
  );
  const catalog = result.catalog;
  if (catalog.providerId !== "meta") {
    return yield* new MuseCatalogError({ detail: "Muse returned a catalog for another provider." });
  }
  const seen = new Set<string>();
  const models = catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const label = model.displayLabel.trim() || model.modelId;
    const name =
      label === model.modelId && label.startsWith("muse-")
        ? label.replaceAll("-", " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
        : label;
    return [
      {
        slug: model.modelId,
        name,
        isCustom: false,
        isDefault: model.isDefault,
        capabilities: museModelCapabilities(model),
      },
    ];
  });
  return { models, usage: result.usage };
});
