import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  batchedAgentMessage,
  queuedAgentMessageBatch,
  queuedRunsInDeliveryOrder,
} from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });
});

describe("queued agent message batch", () => {
  const thread = { id: "thread:coordinator" };
  const modelSelection = { instanceId: "codex", model: "gpt" };
  const agent = (id: string, fields: Record<string, unknown> = {}) => ({
    id: `message:${id}`,
    role: "user",
    text: id,
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: "thread:lead",
    createdAt: at("10:00:00"),
    ...fields,
  });
  const queued = (id: string, minute: number, fields: Record<string, unknown> = {}) => ({
    id: `run:${id}`,
    ordinal: minute,
    queuePosition: minute,
    requestedAt: at(`10:0${minute}:00`),
    status: "queued",
    userMessageId: `message:${id}`,
    modelSelection,
    ...fields,
  });
  const batchOf = (
    entries: ReadonlyArray<{
      readonly message?: Record<string, unknown>;
      readonly run?: Record<string, unknown>;
    }>,
    turnItems: ReadonlyArray<unknown> = [],
  ) => {
    const projection = {
      thread,
      turnItems,
      messages: entries.map((entry, index) => agent(String(index), entry.message)),
      runs: entries.map((entry, index) => queued(String(index), index + 1, entry.run)),
    } as never as Parameters<typeof queuedAgentMessageBatch>[0];
    return queuedAgentMessageBatch(projection, projection.runs[0]!).map(({ run }) => run.id);
  };

  it.each([
    ["the user's message", { message: { createdBy: "user", senderThreadId: undefined } }],
    ["a message from this thread", { message: { senderThreadId: thread.id } }],
    ["a tool message with no sending thread", { message: { senderThreadId: undefined } }],
    ["attachments", { message: { attachments: [{ type: "image" }] } }],
    ["a scheduled task", { message: { scheduledTaskId: "scheduled:1" } }],
    ["a monitor wake", { message: { notification: { source: { kind: "monitor" } } } }],
    ["a slash command", { message: { text: "/compact" } }],
    ["a skill mention", { message: { text: "$deploy now" } }],
    [
      "a delegated task brief",
      {
        message: { id: "message:delegated-task:command%3A1" },
        run: { userMessageId: "message:delegated-task:command%3A1" },
      },
    ],
    ["a steer waiting for its turn", { run: { steerWhenReadyRunId: "run:active" } }],
    ["a fresh session", { run: { freshContext: true } }],
    ["a held queue", { run: { queueHeld: true } }],
    ["another model", { run: { modelSelection: { instanceId: "codex", model: "other" } } }],
    ["a restart moved ahead of older messages", { run: { requestedAt: at("09:00:00") } }],
  ])("ends the batch at %s", (_name, entry) => {
    expect(batchOf([{}, {}, entry, {}])).toEqual(["run:0", "run:1"]);
  });

  it("leaves a steer that fell back to the queue on its own", () => {
    expect(
      batchOf([{}, {}, {}], [{ type: "user_message", runId: "run:1", messageId: "message:1" }]),
    ).toEqual([]);
  });

  it("starts nothing together when the head has no agent message behind it", () => {
    expect(batchOf([{}, { message: { createdBy: "user" } }, {}])).toEqual([]);
  });

  it("names each sender with its time and keeps a sender only every message shares", () => {
    const run = queued("0", 1) as never;
    const linked = {
      environmentId: "environment:laptop",
      threadId: "thread:remote",
      title: "Remote",
    };
    const batch = [
      agent("first", { createdAt: at("10:00:00") }),
      agent("second", { createdAt: at("10:01:00"), linkedSender: linked }),
    ].map((message) => ({ run, message })) as never as Parameters<typeof batchedAgentMessage>[0];
    const merged = batchedAgentMessage(batch, at("10:02:00"));
    expect(merged.text).toBe(
      [
        "[T3 Code: 2 messages from other threads, batched by T3, oldest first.]",
        '[T3 Code: message 1 of 2, sent 2026-01-01T10:00:00.000Z by the agent in T3 thread "thread:lead".]\nfirst',
        '[T3 Code: message 2 of 2, sent 2026-01-01T10:01:00.000Z by the agent in T3 thread "thread:remote" on linked environment "environment:laptop".]\nsecond',
      ].join("\n\n"),
    );
    expect(merged).not.toHaveProperty("senderThreadId");
    expect(merged).not.toHaveProperty("linkedSender");
    expect(batchedAgentMessage(batch.slice(0, 1), at("10:02:00")).senderThreadId).toBe(
      "thread:lead",
    );
  });
});
