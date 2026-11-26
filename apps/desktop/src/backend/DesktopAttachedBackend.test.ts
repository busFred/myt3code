import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAttachedBackend from "./DesktopAttachedBackend.ts";
import type { HomeOwner } from "./DesktopHomeOwner.ts";

const owner: HomeOwner = { pid: 42, port: 3773, serviceManaged: true };

describe("DesktopAttachedBackend", () => {
  it.effect("asks the service every 5 s but reads the home owner only every 30 s", () =>
    Effect.gen(function* () {
      const ownerReads = yield* Ref.make(0);
      const answering = yield* Ref.make(true);
      const requests = yield* Queue.unbounded<void>();
      const events = yield* Queue.unbounded<"ready" | "shutdown">();
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(
        state.localBackendAttachment,
        Option.some({
          owner,
          readOwner: Ref.update(ownerReads, (count) => count + 1).pipe(
            Effect.as(Option.some(owner)),
          ),
          getBearerToken: Effect.succeed("token"),
          confirmQuit: () => Effect.succeed(false),
        }),
      );
      const backend = yield* DesktopAttachedBackend.make({
        onReady: () => Queue.offer(events, "ready"),
        onShutdown: Queue.offer(events, "shutdown"),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              backendCwd: "/server",
              baseDir: "/tmp/t3",
            } as never),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Queue.offer(requests, undefined).pipe(
                  Effect.andThen(Ref.get(answering)),
                  Effect.map((up) =>
                    HttpClientResponse.fromWeb(
                      request,
                      new Response(up ? JSON.stringify({ serverVersion: "1.0.0" }) : null, {
                        status: up ? 200 : 503,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

      yield* backend.start;
      assert.equal(yield* Queue.take(events), "ready");
      yield* Queue.take(requests);
      assert.equal(yield* Ref.get(ownerReads), 1);

      for (let tick = 1; tick <= 5; tick++) {
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(requests);
      }
      assert.equal(yield* Ref.get(ownerReads), 1);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(requests);
      assert.equal(yield* Ref.get(ownerReads), 2);

      // A service that stops answering is noticed on the next 5 s tick, not the next 30 s one.
      yield* Ref.set(answering, false);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.take(events), "shutdown");
    }).pipe(Effect.provide(DesktopState.layer)),
  );
});
