import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  startsWithProviderCommand,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isDelegatedTaskMessage } from "@t3tools/provider-core/server/IdAllocator";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

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
    message.followsThreadSelection === undefined &&
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
  let runsWithUserItem: ReadonlySet<OrchestrationV2Run["id"]> | undefined;
  const batch: Array<QueuedAgentMessage> = [];
  for (const run of ordered.slice(start)) {
    if (!runJoinsBatch(run, head)) break;
    messages ??= new Map(projection.messages.map((message) => [message.id, message]));
    const message = messages.get(run.userMessageId);
    if (message === undefined || !messageJoinsBatch(message, projection.thread.id)) break;
    // A steer that fell back to the queue keeps its own user item.
    runsWithUserItem ??= new Set(
      projection.turnItems.flatMap((item) =>
        item.type === "user_message" && item.runId !== null ? [item.runId] : [],
      ),
    );
    if (runsWithUserItem.has(run.id)) break;
    if (
      batch.length > 0 &&
      expandAssistantCitationsForProvider(
        batchedAgentMessagesText([...batch.map((entry) => entry.message), message]),
      ).length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ) {
      break;
    }
    batch.push({ run, message });
  }
  return batch.length > 1 ? batch : [];
}

function agentSender(message: OrchestrationV2ConversationMessage): string {
  return message.linkedSender === undefined
    ? `the agent in T3 thread ${JSON.stringify(message.senderThreadId)}`
    : `the agent in T3 thread ${JSON.stringify(message.linkedSender.threadId)} on linked environment ${JSON.stringify(message.linkedSender.environmentId)}`;
}

/** A body line cannot pass for one of the batch's own headers. */
function framedBody(text: string): string {
  return text.replace(/^([ \t]*)\[T3 Code:/gm, "$1\\[T3 Code:");
}

function batchedAgentMessagesText(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): string {
  return [
    `[T3 Code: ${messages.length} queued messages from other threads' agents, not the user, sent together by T3 Code, oldest first.]`,
    ...messages.map(
      (message, index) =>
        `[T3 Code: message ${index + 1} of ${messages.length}, sent ${DateTime.formatIso(message.createdAt)} by ${agentSender(message)}.]\n${framedBody(message.text)}`,
    ),
  ].join("\n\n");
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
