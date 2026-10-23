import { tryClient } from "@/lib/client";
import { joinWithin } from "@/lib/copilot/join-thread";
import { newId } from "@/lib/new-id";

/**
 * Following a turn this tab did not start: one already going when Chat opened, one another tab or
 * device started, or the continuation the server runs after Allow once.
 *
 * THE REALTIME CONNECT IS HOW. Joining a thread replays what this tab has not seen and then streams
 * whatever is still running, live, and it ends when that run does. So the transcript fills as the
 * Bot works, Stop reaches the run, and the answer lands in this tab without a reload. While it is
 * open the conversation is busy: anything the person types is Queued and runs when it ends.
 */

/**
 * The run holding this thread right now, as the runtime's own join answers it: its id, or null when
 * the thread is idle.
 *
 * The realtime join answers with the id of the run holding the thread, and with none when it is idle.
 * The SDK keeps that answer to itself, and the events a join replays cannot say it either: a long
 * history replays for seconds, and at any moment of it the last run replayed may be one that ended
 * long ago or the one still going. So the question is put directly, as Chat opens.
 *
 * Undefined when the runtime cannot say: a transport that answers a join with a replay rather than
 * an answer, or a join that failed. The caller then falls back on what the replay shows.
 *
 * `forwardedProps.openbotAsk` names the request for whoever reads the traffic; the runtime reads
 * only the thread from a join.
 */
export async function liveRun({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId: string;
}): Promise<string | null | undefined> {
  try {
    const response = await tryClient(
      `/api/copilotkit/agent/${encodeURIComponent(agentId)}/connect`,
      {
        method: "POST",
        body: {
          threadId,
          runId: newId(),
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { openbotAsk: "live-run" },
        },
      },
    );
    if (response.status === 204) return null;
    if (!response.ok) return undefined;
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const answer = (await response.json()) as { runId?: unknown };
    return typeof answer.runId === "string" && answer.runId.length > 0
      ? answer.runId
      : null;
  } catch {
    return undefined;
  }
}

/**
 * Join a thread, bounded, unless what is streaming at the deadline is a turn still going.
 *
 * `joinWithin` ends a join that outlives its deadline, and that is right for a stalled one: a
 * connect left in flight is torn down by the next run and erases what was added meanwhile. It is
 * wrong for a reload mid-run. There the join is slow because it is streaming the turn, and ending it
 * took the pill, Stop and the answer with it. So at the deadline, a join holding a run that is
 * still going is kept and handed back for the caller to follow; anything else is ended as before.
 *
 * Resolves to `{ live }`, the join still streaming, when it is being kept, or `{ live: null }` once
 * the join is over. Wrapped, because a promise resolved with a promise waits for it.
 */
export async function joinOrFollow({
  connect,
  deadline,
  detach,
  runOpen,
}: {
  /** The join already in progress. Its rejection is an outcome, not a failure. */
  connect: Promise<unknown>;
  /** How long a join with no run open is worth waiting for. */
  deadline: Promise<void>;
  /** End the join. Asked for only when it is not being kept. */
  detach: () => Promise<unknown>;
  /** Whether a run is still going on the thread. Asked only when the deadline comes first. */
  runOpen: () => boolean | Promise<boolean>;
}): Promise<{ live: Promise<void> | null }> {
  const finished = connect.then(
    () => undefined,
    () => undefined,
  );
  const outcome = await Promise.race([
    finished.then(() => "joined" as const),
    deadline.then(() => "deadline" as const),
  ]);
  if (outcome === "joined") return { live: null };
  if (await runOpen()) return { live: finished };
  await joinWithin({ connect: finished, deadline: Promise.resolve(), detach });
  return { live: null };
}

/**
 * Follow a turn to its end: join, and join again until `done` says it has landed.
 *
 * Again, because the turn may not have started yet. After Allow once the server claims the decision
 * within a couple of seconds and only then runs the continuation, and a join in that gap finds the
 * thread idle and returns at once. Each join streams a run that is going to its end, so the loop is
 * a handful of quick joins and then one long one.
 *
 * Bounded by `maxMs`, and by `stopped` (Stop pressed, or the screen gone), so a turn that never comes
 * cannot hold the conversation busy for ever.
 */
export async function followTurn({
  first,
  connect,
  done,
  stopped,
  wait,
  retryMs,
  maxMs,
  now = Date.now,
}: {
  /** A join already streaming, to finish before any new one. */
  first?: Promise<unknown>;
  /** Start a join; resolves when it is over. */
  connect: () => Promise<unknown>;
  /** The turn being followed has landed. Without one, the first join that ends is enough. */
  done?: () => boolean;
  stopped: () => boolean;
  wait: (ms: number) => Promise<void>;
  retryMs: number;
  maxMs: number;
  now?: () => number;
}): Promise<void> {
  const start = now();
  let joining: Promise<unknown> | undefined = first;
  for (;;) {
    try {
      await (joining ?? connect());
    } catch {
      // A join that failed is a join that is over; the bound below decides whether to try again.
    }
    joining = undefined;
    if (stopped() || !done || done()) return;
    if (now() - start >= maxMs) return;
    await wait(retryMs);
    if (stopped()) return;
  }
}

/**
 * After Stop, let the agent build a fresh realtime connection for its next run.
 *
 * WHY. Stop asks the realtime channel to stop the run and leaves it in the same breath, so the
 * channel's reply to the stop is never read, and the SDK's handler for that reply fires instead on
 * the push's 10-second timeout. That handler cleans up whatever channel and socket the agent holds
 * AT THAT MOMENT: a message sent within those 10 seconds had its run's socket closed under it two
 * seconds in, so its answer never streamed into the tab (the server did answer), and a reload was
 * the only way to see it.
 *
 * Forgetting the agent's realtime delegate means the next run builds its own, and the stale handler
 * cleans up the old one, which is already closed. The cost is the old delegate's replay cursor, so
 * the next join replays the thread from the start, which `follow` counts runs against already.
 * `delegate` is not public API: on an agent without one this does nothing, and Stop behaves as before.
 */
export function freshConnectionAfterStop(agent: object): void {
  const holder = agent as { delegate?: unknown };
  if (holder.delegate !== undefined) holder.delegate = undefined;
}
