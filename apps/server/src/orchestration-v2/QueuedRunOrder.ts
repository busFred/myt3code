import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  startsWithProviderCommand,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isDelegatedTaskMessage } from "@t3tools/provider-core/server/IdAllocator";
import { makeExpandedCitationLengthMeter } from "@t3tools/shared/assistantCitations";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

/**
 * The thread's newest run. A run merged into a batch keeps its higher ordinal but never ran; the
 * run it names carries its work, so it never counts as newest.
 */
export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  let latest: OrchestrationV2Run | undefined;
  for (const run of projection.runs) {
    if (run.batchedIntoRunId !== undefined) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  const completions = queued.filter((run) => automaticCompletionMessageIds.has(run.userMessageId));
  const messages = queued.filter((run) => !automaticCompletionMessageIds.has(run.userMessageId));
  // Completions and messages each keep their queue order and interleave by request time,
  // so neither kind can hold the other back while more of it keeps arriving.
  const ordered: Array<OrchestrationV2Run> = [];
  let completionIndex = 0;
  let messageIndex = 0;
  for (;;) {
    const completion = completions[completionIndex];
    const message = messages[messageIndex];
    if (completion === undefined || message === undefined) {
      return [...ordered, ...completions.slice(completionIndex), ...messages.slice(messageIndex)];
    }
    if (
      DateTime.toEpochMillis(completion.requestedAt) <= DateTime.toEpochMillis(message.requestedAt)
    ) {
      ordered.push(completion);
      completionIndex += 1;
    } else {
      ordered.push(message);
      messageIndex += 1;
    }
  }
}

export interface QueuedAgentMessage {
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}

function runJoinsBatch(run: OrchestrationV2Run, head: OrchestrationV2Run): boolean {
  return (
    run.status === "queued" &&
    run.queueHeld !== true &&
    run.queueStandalone !== true &&
    run.steerWhenReadyRunId === undefined &&
    run.freshContext !== true &&
    run.restartContinuationOfRunId === undefined &&
    run.manualContinuationOfRunId === undefined &&
    run.usageLimitContinuationOfRunId === undefined &&
    run.delegatedTaskId === undefined &&
    run.sourcePlanRef === undefined &&
    run.delegatedCompletion === undefined &&
    modelSelectionsEqual(run.modelSelection, head.modelSelection)
  );
}

function messageJoinsBatch(
  message: OrchestrationV2ConversationMessage,
  threadId: OrchestrationV2Run["threadId"],
  followsThreadSelection: boolean,
): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "agent" &&
    (message.linkedSender !== undefined ||
      (message.senderThreadId !== undefined && message.senderThreadId !== threadId)) &&
    message.batchedMessageCount === undefined &&
    message.attachments.length === 0 &&
    message.context === undefined &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.scheduledTaskId === undefined &&
    message.idleCompaction === undefined &&
    message.workflowScript === undefined &&
    // One that names no model runs on the thread's pick at start; it never joins a pinned one.
    (message.followsThreadSelection === true) === followsThreadSelection &&
    !isDelegatedTaskMessage(message.id) &&
    !startsWithProviderCommand(message.text)
  );
}

/**
 * The queued messages from other threads that start with `head` as one run: `head` and the ones
 * right behind it, stopping at the first that is not one (such as a person's message), at a run
 * put ahead of its queue, or before the text would pass the provider's prompt limit.
 * Empty when there is nothing to merge. `ordered` is the queue in delivery order.
 */
export function queuedAgentMessageBatch(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages" | "turnItems">,
  head: OrchestrationV2Run,
  ordered: ReadonlyArray<OrchestrationV2Run> = queuedRunsInDeliveryOrder(projection),
): ReadonlyArray<QueuedAgentMessage> {
  if (!runJoinsBatch(head, head)) return [];
  const start = ordered.findIndex((run) => run.id === head.id);
  const next = start === -1 ? undefined : ordered[start + 1];
  if (next === undefined || !runJoinsBatch(next, head)) return [];
  let messages: ReadonlyMap<MessageId, OrchestrationV2ConversationMessage> | undefined;
  let followsThreadSelection: boolean | undefined;
  let runsWithUserItem: ReadonlySet<OrchestrationV2Run["id"]> | undefined;
  // The provider-start check's length of the batch text, kept as each message joins.
  const meter = makeExpandedCitationLengthMeter("agent");
  let entryPrefixesLength = 0;
  const batch: Array<QueuedAgentMessage> = [];
  for (const run of ordered.slice(start)) {
    if (!runJoinsBatch(run, head)) break;
    messages ??= new Map(projection.messages.map((message) => [message.id, message]));
    const message = messages.get(run.userMessageId);
    followsThreadSelection ??= message?.followsThreadSelection === true;
    if (
      message === undefined ||
      !messageJoinsBatch(message, projection.thread.id, followsThreadSelection)
    ) {
      break;
    }
    // A steer that fell back to the queue keeps its own user item.
    runsWithUserItem ??= new Set(
      projection.turnItems.flatMap((item) =>
        item.type === "user_message" && item.runId !== null ? [item.runId] : [],
      ),
    );
    if (runsWithUserItem.has(run.id)) break;
    const count = batch.length + 1;
    const prefixLength = batchEntryPrefix(count, "", message).length;
    const measured = meter.measure(`${BATCH_SEPARATOR}${batchEntryRest(message)}`);
    // Every header names the count, so each grows with its digits.
    const length =
      batchHeadline("").length +
      entryPrefixesLength +
      prefixLength +
      (count + 1) * String(count).length +
      measured.length;
    if (batch.length > 0 && length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) break;
    measured.keep();
    entryPrefixesLength += prefixLength;
    batch.push({ run, message });
  }
  return batch.length > 1 ? batch : [];
}

function agentSender(message: OrchestrationV2ConversationMessage): string {
  return message.linkedSender === undefined
    ? `the agent in T3 thread ${JSON.stringify(message.senderThreadId)}`
    : `the agent in T3 thread ${JSON.stringify(message.linkedSender.threadId)} on linked environment ${JSON.stringify(message.linkedSender.environmentId)}`;
}

// Spaces, including invisible ones, that a line can hide a header behind.
const BLANK = String.raw`[\p{Zs}\t\u180E\u200B-\u200D\u2060\uFEFF]`;
const HEADER_LOOKALIKE = new RegExp(
  String.raw`^((?:${BLANK}|>)*)(\[${BLANK}*T3${BLANK}*Code${BLANK}*:)`,
  "gimu",
);

/** A body line cannot pass for one of the batch's own headers. */
function framedBody(text: string): string {
  return text.replace(HEADER_LOOKALIKE, "$1\\$2");
}

const BATCH_SEPARATOR = "\n\n";

const batchHeadline = (count: number | string) =>
  `[T3 Code: ${count} queued messages from other threads' agents, not the user, sent together by T3 Code, oldest first.]`;

// No citation can reach into a header's count, which spaces surround.
const batchEntryPrefix = (
  index: number,
  count: number | string,
  message: OrchestrationV2ConversationMessage,
) => `[T3 Code: message ${index} of ${count}, sent ${DateTime.formatIso(message.createdAt)} by `;

const batchEntryRest = (message: OrchestrationV2ConversationMessage) =>
  `${agentSender(message)}.]\n${framedBody(message.text)}`;

function batchedAgentMessagesText(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): string {
  return [
    batchHeadline(messages.length),
    ...messages.map(
      (message, index) =>
        `${batchEntryPrefix(index + 1, messages.length, message)}${batchEntryRest(message)}`,
    ),
  ].join(BATCH_SEPARATOR);
}

/** The head message carrying the whole batch; a sender stays only when every message has it. */
export function batchedAgentMessage(
  batch: ReadonlyArray<QueuedAgentMessage>,
  updatedAt: DateTime.Utc,
): OrchestrationV2ConversationMessage {
  const messages = batch.map((entry) => entry.message);
  const head = messages[0]!;
  const sameSender = messages.every(
    (message) =>
      message.senderThreadId === head.senderThreadId &&
      message.linkedSender?.threadId === head.linkedSender?.threadId &&
      message.linkedSender?.environmentId === head.linkedSender?.environmentId,
  );
  const { senderThreadId, linkedSender, ...rest } = head;
  return {
    ...rest,
    ...(sameSender && senderThreadId !== undefined ? { senderThreadId } : {}),
    ...(sameSender && linkedSender !== undefined ? { linkedSender } : {}),
    text: batchedAgentMessagesText(messages),
    batchedMessageCount: messages.length,
    updatedAt,
  };
}
