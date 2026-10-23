import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AbstractAgent,
  type BaseEvent,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { defer, from, Observable, switchMap } from "rxjs";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import type { RunChannel } from "./channels";

/*
 * Which channel a run is in, read from the run itself.
 *
 * A channel's purpose has to reach the Bot on every turn there, and `start_task` and `add_tasks` have
 * to know which channel asked, so the task wears its colour. Neither is something a tool is handed:
 * OpenDuet's tools are made once per request (`createOpenDuetTools`), before any run, and a tool's
 * `execute` takes only its arguments. What does know is the AG-UI run input, whose `threadId` is the
 * conversation's.
 *
 * So this is a middleware on every Bot a person runs, in the browser or headless, attached where the
 * server resolves them. Per run it looks the thread up (`DuetChannelStore.ofThread`) and, for a
 * dressed channel:
 *
 * 1. puts the channel's name and purpose in the run's context, the way personal memory is put there
 *    (memory/tools.ts): an AG-UI context entry, which a built-in Bot reads into its prompt, and a
 *    system row for a remote one. The per-run context is the seam, not the system prompt, because
 *    the prompt is built per request before the thread is known, and not the person's message,
 *    because a prefix there would land in the transcript;
 * 2. runs the rest of the run inside an AsyncLocalStorage holding the channel, as the native approval
 *    runner holds its run (toolkit/native-approval.ts), so a tool executing in this run reads which
 *    channel it is in with `currentRunChannelId`.
 *
 * Everything, a task's conversation and any other thread look up to nothing: no message, and tools
 * read null, which is what Everything means on a task.
 */

const store = new AsyncLocalStorage<RunChannel | null>();

/** The dressed channel the current run is in, or null for Everything and anywhere else. */
export function currentRunChannelId(): string | null {
  return store.getStore()?.channelId ?? null;
}

/** The id of the system message, so a run that already carries one is not told twice. */
export const RUN_CHANNEL_MESSAGE_ID = "openduet:channel";

/** What the Bot is told about the channel it is working in. */
export function runChannelGuidance(channel: RunChannel): string | null {
  if (!channel.purpose) return null;
  return [
    `This conversation is the person's channel "${channel.name}". What they want you to know about it, in their words: ${channel.purpose}`,
    "That is the channel's purpose as they set it now: if anything earlier in this conversation says otherwise, it was changed since. Keep the work here about that purpose. Tasks you start or add here belong to this channel.",
  ].join("\n");
}

/** The description of the context entry, so a run that already carries one is not told twice. */
export const RUN_CHANNEL_CONTEXT = "OpenDuet channel";

/**
 * The run's input with the channel's guidance on it, and any earlier copy gone.
 *
 * TWICE, AS PERSONAL MEMORY IS (memory/tools.ts), because the two kinds of Bot read different
 * halves. A built-in Bot drops every `system` row from its messages (`forwardSystemMessages` is
 * never set, see toolkit/src/history-sanitize.ts) and puts the run's context entries in its prompt,
 * so the context entry is what reaches it. A remote Bot reads the messages it is sent, so the
 * system row is what reaches that one.
 */
export function withRunChannel(
  input: RunAgentInput,
  channel: RunChannel | null,
): RunAgentInput {
  const guidance = channel ? runChannelGuidance(channel) : null;
  const messages = input.messages.filter(
    (message) => message.id !== RUN_CHANNEL_MESSAGE_ID,
  );
  const context = input.context.filter(
    (entry) => entry.description !== RUN_CHANNEL_CONTEXT,
  );
  if (
    !guidance &&
    messages.length === input.messages.length &&
    context.length === input.context.length
  )
    return input;
  return {
    ...input,
    messages: [
      ...(guidance
        ? [
            {
              id: RUN_CHANNEL_MESSAGE_ID,
              role: "system" as const,
              content: guidance,
            },
          ]
        : []),
      ...messages,
    ],
    context: [
      ...context,
      ...(guidance
        ? [{ description: RUN_CHANNEL_CONTEXT, value: guidance }]
        : []),
    ],
  };
}

export class RunChannelMiddleware extends Middleware {
  constructor(
    private readonly lookup: (threadId: string) => Promise<RunChannel | null>,
  ) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return defer(() =>
      from(
        // A failed read costs the run its purpose line, never the run.
        this.lookup(input.threadId).catch(() => null),
      ),
    ).pipe(
      switchMap(
        (channel) =>
          new Observable<BaseEvent>((subscriber) => {
            // Null is set too, so a run inside another never inherits the outer one's channel.
            const subscription = store.run(channel, () =>
              this.runNext(withRunChannel(input, channel), next).subscribe(
                subscriber,
              ),
            );
            return () => subscription.unsubscribe();
          }),
      ),
    );
  }
}

/**
 * The resolver every surface builds Bots through, with the middleware on each Bot it hands out. One
 * line where the server assembles the resolver (index.ts), so OpenBot's own wiring stays as it is.
 */
export function withRunChannels(
  resolver: ActorAgentResolver,
  lookup: (ownerUserId: string, threadId: string) => Promise<RunChannel | null>,
): ActorAgentResolver {
  const attach = <A extends AbstractAgent>(ownerUserId: string, agent: A) => {
    agent.use(
      new RunChannelMiddleware((threadId) => lookup(ownerUserId, threadId)),
    );
    return agent;
  };
  return {
    async resolveAgentsForActor(actor) {
      const agents = await resolver.resolveAgentsForActor(actor);
      for (const agent of Object.values(agents)) attach(actor.id, agent);
      return agents;
    },
    async resolveAgentForActor(actor, agentId, context) {
      return attach(
        actor.id,
        await resolver.resolveAgentForActor(actor, agentId, context),
      );
    },
  };
}
