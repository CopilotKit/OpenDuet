import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { from, lastValueFrom, mergeMap, type Observable, toArray } from "rxjs";
import type { ActorAgentResolver } from "../src/agents/agent-resolver";
import type { RunChannel } from "../src/openduet/channels";
import {
  currentRunChannelId,
  RUN_CHANNEL_CONTEXT,
  RUN_CHANNEL_MESSAGE_ID,
  RunChannelMiddleware,
  withRunChannels,
} from "../src/openduet/run-channel";

/**
 * The run's own thread is what tells OpenDuet which channel it is in: the Bot is told the channel's
 * purpose on every turn there, and a tool executing in the run reads the channel to tag a task.
 */

/** A Bot whose run waits a moment, as a model does, then "executes a tool" and reports what it read. */
class ToolCallingAgent extends AbstractAgent {
  readonly requests: RunAgentInput[] = [];
  readonly seen: (string | null)[] = [];
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.requests.push(input);
    return from(
      (async (): Promise<BaseEvent[]> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Promise.resolve();
        this.seen.push(currentRunChannelId());
        return [
          {
            type: EventType.RUN_STARTED,
            runId: input.runId,
            threadId: input.threadId,
          },
          {
            type: EventType.RUN_FINISHED,
            runId: input.runId,
            threadId: input.threadId,
          },
        ];
      })(),
    ).pipe(mergeMap((events) => from(events)));
  }
}

const input = (threadId: string): RunAgentInput => ({
  runId: `run-${threadId}`,
  threadId,
  messages: [{ id: "user", role: "user", content: "Yes" }],
  context: [],
  tools: [],
  state: {},
  forwardedProps: {},
});

const kiln: RunChannel = {
  channelId: "channel-kiln",
  name: "Kiln move",
  purpose: "Moving the studio's kiln to the new space by March.",
};

const lookup = async (threadId: string) =>
  threadId === "thread-kiln"
    ? kiln
    : threadId === "thread-legacy"
      ? { ...kiln, channelId: "channel-legacy", purpose: null }
      : null;

async function run(threadId: string, agent = new ToolCallingAgent()) {
  await lastValueFrom(
    new RunChannelMiddleware(lookup)
      .run(input(threadId), agent)
      .pipe(toArray()),
  );
  return agent;
}

test("a run in a channel is told its name and purpose, once, ahead of the conversation", async () => {
  const agent = await run("thread-kiln");
  const messages = agent.requests[0]?.messages ?? [];
  expect(messages[0]).toMatchObject({
    id: RUN_CHANNEL_MESSAGE_ID,
    role: "system",
  });
  expect(String(messages[0]?.content)).toContain('channel "Kiln move"');
  expect(String(messages[0]?.content)).toContain(kiln.purpose ?? "");
  expect(String(messages[0]?.content)).toContain(
    "Keep the work here about that purpose.",
  );
  expect(messages.slice(1)).toEqual(input("thread-kiln").messages);
  // A built-in Bot drops system rows and reads the run's context into its prompt: it is there too.
  const context = agent.requests[0]?.context ?? [];
  expect(context).toHaveLength(1);
  expect(context[0]?.description).toBe(RUN_CHANNEL_CONTEXT);
  expect(context[0]?.value).toBe(String(messages[0]?.content));
});

test("a run carrying an earlier copy of the message gets one, not two", async () => {
  const agent = new ToolCallingAgent();
  const request = input("thread-kiln");
  request.messages = [
    { id: RUN_CHANNEL_MESSAGE_ID, role: "system", content: "stale" },
    ...request.messages,
  ];
  request.context = [{ description: RUN_CHANNEL_CONTEXT, value: "stale" }];
  await lastValueFrom(
    new RunChannelMiddleware(lookup).run(request, agent).pipe(toArray()),
  );
  const ids = (agent.requests[0]?.messages ?? []).map((message) => message.id);
  expect(ids.filter((id) => id === RUN_CHANNEL_MESSAGE_ID)).toHaveLength(1);
  expect(String(agent.requests[0]?.messages[0]?.content)).not.toBe("stale");
  expect(agent.requests[0]?.context.map((entry) => entry.value)).not.toContain(
    "stale",
  );
  expect(agent.requests[0]?.context).toHaveLength(1);
});

test("Everything and a task's conversation are told nothing, and their tools read no channel", async () => {
  const agent = await run("thread-everything");
  expect(agent.requests[0]?.messages).toEqual(
    input("thread-everything").messages,
  );
  expect(agent.requests[0]?.context).toEqual([]);
  expect(agent.seen).toEqual([null]);
});

test("a channel with no purpose is told nothing, and is still the channel its tools read", async () => {
  const agent = await run("thread-legacy");
  expect(agent.requests[0]?.messages).toEqual(input("thread-legacy").messages);
  expect(agent.seen).toEqual(["channel-legacy"]);
});

test("a tool executing after the run has waited still reads its channel, and two runs never trade", async () => {
  const [inChannel, inEverything] = await Promise.all([
    run("thread-kiln"),
    run("thread-everything"),
  ]);
  expect(inChannel.seen).toEqual(["channel-kiln"]);
  expect(inEverything.seen).toEqual([null]);
  // Outside any run there is no channel.
  expect(currentRunChannelId()).toBeNull();
});

test("a failed lookup costs the run its purpose line, never the run", async () => {
  const agent = new ToolCallingAgent();
  const events = await lastValueFrom(
    new RunChannelMiddleware(async () => {
      throw new Error("database is down");
    })
      .run(input("thread-kiln"), agent)
      .pipe(toArray()),
  );
  expect(events.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.RUN_FINISHED,
  ]);
  expect(agent.seen).toEqual([null]);
});

test("every Bot the resolver hands out carries the middleware, looked up as its person", async () => {
  const asked: [string, string][] = [];
  const agents = { openduet: new ToolCallingAgent({ agentId: "openduet" }) };
  const resolver: ActorAgentResolver = {
    resolveAgentsForActor: async () => agents,
    resolveAgentForActor: async () => new ToolCallingAgent(),
  };
  const wrapped = withRunChannels(resolver, async (owner, thread) => {
    asked.push([owner, thread]);
    return thread === "thread-kiln" ? kiln : null;
  });
  const resolved = await wrapped.resolveAgentsForActor({
    id: "maya",
    role: "user",
  });
  const agent = resolved.openduet as ToolCallingAgent;
  agent.threadId = "thread-kiln";
  agent.setMessages([{ id: "user", role: "user", content: "Yes" }]);
  await agent.runAgent({ runId: "run-1" });
  expect(asked).toEqual([["maya", "thread-kiln"]]);
  expect(agent.requests[0]?.messages[0]?.id).toBe(RUN_CHANNEL_MESSAGE_ID);
  expect(agent.seen).toEqual(["channel-kiln"]);

  const one = (await wrapped.resolveAgentForActor(
    { id: "sam", role: "user" },
    "openduet",
  )) as ToolCallingAgent;
  one.threadId = "thread-other";
  await one.runAgent({ runId: "run-2" });
  expect(asked.at(-1)).toEqual(["sam", "thread-other"]);
  expect(one.seen).toEqual([null]);
});
