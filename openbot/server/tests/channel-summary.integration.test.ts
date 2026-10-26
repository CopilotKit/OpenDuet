import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CHECK_IN_FRAME, frameCheckIn } from "@openbot/shared/check-in";
import { frameTaskBrief, TASK_FRAME } from "@openbot/shared/task-brief";
import { FIRST_DAY_FRAME, frameFirstDay } from "@openbot/shared/first-day";
import {
  frameMorningBrief,
  MORNING_BRIEF_FRAME,
} from "@openbot/shared/morning-brief";
import { FIRING_FRAME, frameFiring } from "@openbot/shared/routine-firing";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import {
  CHANNEL_SUMMARY_KIND,
  type ChannelTitler,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
  type ThreadTranscript,
} from "../src/channels/summary";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const queue = createWorkQueue(database);

const testPrefix = `channel-summary-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(workItems).where(eq(workItems.key, channelId));
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Channel Summary Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

/** A channel somebody has actually said something in, which is the only kind worth naming. */
async function createUsedChannel(owner: AgentActor) {
  const agentId = await createAgent(owner);
  const channel = await store.create(owner, [agentId]);
  createdChannelIds.push(channel.id);
  await store.recordActivity(owner, channel.id, {
    text: "Which of these receipts count as travel?",
    agentId: null,
    at: new Date(),
  });
  return channel;
}

/** A transcript with one question and one answer in it, which is what a title is made from. */
function transcriptOf(question: string, answer?: string): ThreadTranscript {
  return {
    getThreadMessages: async () => ({
      messages: [
        { role: "user", content: question },
        ...(answer ? [{ role: "assistant", content: answer }] : []),
      ],
    }),
  };
}

function titler(answer: string | null): ChannelTitler {
  return async () => answer;
}

async function summaryOf(channelId: string) {
  const [row] = await database
    .select({ summary: channels.summary, summaryAt: channels.summaryAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row;
}

/**
 * Queue one conversation, by name.
 *
 * Deliberately not `offerChannelsAwaitingSummary`, which offers every unnamed conversation in the
 * database. A claim takes whatever is queued, so a test that offers the whole table and then claims
 * will happily write a fabricated title onto somebody's real conversation when the suite is pointed
 * at a database that has any — a development one, for instance. Tests that exercise the offer query
 * itself assert on what it returns and never claim.
 */
async function offer(channelId: string) {
  await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channelId });
}

const options = (overrides: {
  transcript?: ThreadTranscript;
  title?: ChannelTitler;
  owner?: string;
}) => ({
  database,
  queue,
  transcript: overrides.transcript ?? transcriptOf("Which receipts?"),
  title: overrides.title ?? titler("Travel receipt rules"),
  owner: overrides.owner ?? `test-${randomUUID()}`,
});

describe("offering conversations to be named", () => {
  test("offers one that has been used and has no name yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    expect(offered).toContain(channel.id);
  });

  test("does not offer a channel nobody has said anything in", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await store.create(owner, [agentId]);
    createdChannelIds.push(channel.id);

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    // There is nothing for a model to read, and asking it to name an empty thread spends money to
    // produce a guess.
    expect(offered).not.toContain(channel.id);
  });

  test("offering the same conversation twice leaves one piece of work", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);

    await offerChannelsAwaitingSummary({ database, queue, limit: 200 });
    await offerChannelsAwaitingSummary({ database, queue, limit: 200 });

    const rows = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(rows).toHaveLength(1);
  });

  /*
   * A pass offers at most `limit` conversations, twenty by default, and a conversation it could not
   * name keeps no summary, so it stays in the set the pass reads. Offering it again while its settled
   * work row stands does nothing, but it still used one of those places. Twenty such conversations
   * ahead of a new one left nothing for it, pass after pass.
   */
  test("does not spend a place on a conversation whose settled work still stands", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    // Settled without a name, the way a model that answers with nothing leaves it.
    await summariseClaimedChannels(options({ title: titler(null) }));
    expect((await summaryOf(channel.id))?.summary).toBeNull();

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    expect(offered).not.toContain(channel.id);
  });

  test("offers it again once its settled work has been forgotten", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    await summariseClaimedChannels(options({ title: titler(null) }));
    // What `forgetSettledSummaries` does once the finished row is an hour old.
    await database.delete(workItems).where(eq(workItems.key, channel.id));

    const { offered } = await offerChannelsAwaitingSummary({
      database,
      queue,
      limit: 200,
    });

    expect(offered).toContain(channel.id);
  });
});

/**
 * What the first pass on a deployment with a history looks like.
 *
 * Every conversation ever used and never named is eligible at once, so the only thing standing
 * between a deploy and a model request per historical conversation is the claim limit. These pin
 * that limit as behaviour rather than leaving it a constant somebody can raise without noticing what
 * it is holding back.
 */
describe("a backlog of unnamed conversations", () => {
  test("names at most one batch per pass, not one per conversation", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const made: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const channel = await store.create(owner, [agentId]);
      createdChannelIds.push(channel.id);
      await store.recordActivity(owner, channel.id, {
        text: `Question ${index}`,
        agentId: null,
        at: new Date(),
      });
      made.push(channel.id);
    }
    for (const id of made) await offer(id);

    let calls = 0;
    const counting = options({
      title: async () => {
        calls += 1;
        return "A title";
      },
    });

    const first = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(first.written).toHaveLength(2);
    expect(calls).toBe(2);

    const second = await summariseClaimedChannels({ ...counting, limit: 2 });
    expect(second.written).toHaveLength(2);
    // The next batch, not the first one again.
    expect(second.written.some((id) => first.written.includes(id))).toBe(false);
    expect(calls).toBe(4);
  });
});

describe("naming a claimed conversation", () => {
  test("writes the title and stamps when it was written", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({
        transcript: transcriptOf(
          "Which of these receipts count as travel?",
          "The three flights and the hotel do.",
        ),
        title: titler("Travel receipt rules"),
      }),
    );

    expect(report.written).toContain(channel.id);
    const row = await summaryOf(channel.id);
    expect(row?.summary).toBe("Travel receipt rules");
    expect(row?.summaryAt).toBeInstanceOf(Date);
  });

  test("titles a routine-opened channel from the instruction, not the firing frame", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        // A channel a routine opened has its first message framed, not typed by a person: see
        // `shared/routine-firing.ts`. The title has to come from the instruction inside the frame.
        transcript: transcriptOf(frameFiring("Post the standup summary.")),
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Standup summary";
        },
      }),
    );

    expect(excerptSeen).toContain("Post the standup summary.");
    expect(excerptSeen).not.toContain(FIRING_FRAME[0]);
    expect((await summaryOf(channel.id))?.summary).toBe("Standup summary");
  });

  test("titles Chat's first-day conversation from the request, not the first-day frame", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        // Chat sends the first day's request for the person, framed: see `shared/first-day.ts`.
        transcript: transcriptOf(
          frameFirstDay("Get to know me. Look through my recent mail."),
          "You run partnerships at Acme.",
        ),
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Getting to know you";
        },
      }),
    );

    expect(excerptSeen).toContain(
      "Asked: Get to know me. Look through my recent mail.",
    );
    for (const line of FIRST_DAY_FRAME) expect(excerptSeen).not.toContain(line);
    expect((await summaryOf(channel.id))?.summary).toBe("Getting to know you");
  });

  test("never titles a conversation from a morning brief: it waits for what the person says", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    const brief = frameMorningBrief("Give me my morning brief.");

    // Chat asks for the brief for the person on a later day, so it is no opening of theirs.
    let excerptSeen = "";
    const report = await summariseClaimedChannels(
      options({
        transcript: {
          getThreadMessages: async () => ({
            messages: [
              { role: "user", content: brief },
              { role: "assistant", content: "Ana's Friday date needs you." },
            ],
          }),
        },
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Morning brief";
        },
      }),
    );
    expect(excerptSeen).toBe("");
    expect(report.skipped).toContainEqual({
      channelId: channel.id,
      reason: "not readable yet",
    });
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("titles a conversation that opened on a morning brief from the person's first words after it", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        transcript: {
          getThreadMessages: async () => ({
            messages: [
              {
                role: "user",
                content: frameMorningBrief("Give me my morning brief."),
              },
              { role: "assistant", content: "Ana's Friday date needs you." },
              { role: "user", content: "Draft the reply to Ana." },
              { role: "assistant", content: "Here is a draft for Ana." },
            ],
          }),
        },
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Reply to Ana";
        },
      }),
    );
    expect(excerptSeen).toBe(
      "Asked: Draft the reply to Ana. Answered: Here is a draft for Ana.",
    );
    for (const line of MORNING_BRIEF_FRAME)
      expect(excerptSeen).not.toContain(line);
    expect((await summaryOf(channel.id))?.summary).toBe("Reply to Ana");
  });

  test("titles a conversation a check-in opened from what it found, not the check-in frame", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        // Research writes first when it found something: see `shared/check-in.ts`.
        transcript: transcriptOf(
          frameCheckIn({
            checkedAt: "2026-10-22T17:32:00.000Z",
            offers: [
              {
                id: "s-1",
                title: "Replace Priya's broken order today",
                why: "Her order arrived broken.",
              },
            ],
          }),
          "Priya's order arrived broken and she wants a replacement today.",
        ),
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Priya's broken order";
        },
      }),
    );

    expect(excerptSeen).toContain("Replace Priya's broken order today");
    for (const line of CHECK_IN_FRAME) expect(excerptSeen).not.toContain(line);
    expect(excerptSeen).not.toContain("suggestionId");
    expect((await summaryOf(channel.id))?.summary).toBe("Priya's broken order");
  });

  test("titles a task's conversation from the person's ask, not the task frame", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    let excerptSeen = "";
    await summariseClaimedChannels(
      options({
        // A task starts with the ask under its frame: see `shared/task-brief.ts`.
        transcript: transcriptOf(
          frameTaskBrief("Prepare notes for the Hearth & Co visit."),
          "Here are your notes for Thursday.",
        ),
        title: async (excerpt) => {
          excerptSeen = excerpt;
          return "Hearth & Co visit notes";
        },
      }),
    );

    expect(excerptSeen).toContain(
      "Asked: Prepare notes for the Hearth & Co visit.",
    );
    for (const line of TASK_FRAME) expect(excerptSeen).not.toContain(line);
  });

  test("two replicas racing for the same conversation name it once", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    /*
     * Overlapping, not sequential. Two sweeps run one after the other pass just as happily with the
     * row-level locking removed, so they prove the conditional update and nothing about the claim.
     * These two are in flight together on separate pooled connections, which is what `for update
     * skip locked` is there for: the second finds nothing to take rather than waiting behind the
     * first and then doing the work twice.
     */
    const [left, right] = await Promise.all([
      summariseClaimedChannels(options({ title: titler("Left title") })),
      summariseClaimedChannels(options({ title: titler("Right title") })),
    ]);

    expect([...left.written, ...right.written]).toEqual([channel.id]);
    expect(left.considered + right.considered).toBe(1);
    const written = (await summaryOf(channel.id))?.summary;
    expect(["Left title", "Right title"]).toContain(written);
  });

  test("never overwrites a name the conversation already has", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await database
      .update(channels)
      .set({ summary: "Named already", summaryAt: new Date() })
      .where(eq(channels.id, channel.id));
    // Offered before it was named, which is exactly the race two replicas produce.
    await queue.offer({ kind: CHANNEL_SUMMARY_KIND, key: channel.id });

    await summariseClaimedChannels(
      options({ title: titler("A second opinion") }),
    );

    expect((await summaryOf(channel.id))?.summary).toBe("Named already");
  });

  test("leaves the conversation unnamed when the model has no answer", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    const report = await summariseClaimedChannels(
      options({ title: titler(null) }),
    );

    // A deployment with no model key reaches this on every pass. Nothing is written, nothing is
    // broken, and the roster keeps drawing the Bot's name.
    expect(report.written).not.toContain(channel.id);
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("comes back later when the conversation is not readable yet", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    // What a conversation looks like in the seconds between somebody sending a message and
    // Intelligence holding it. Finishing the work here is how an ordinary conversation ends up
    // never named at all.
    const report = await summariseClaimedChannels(
      options({
        transcript: { getThreadMessages: async () => ({ messages: [] }) },
      }),
    );

    expect(report.skipped).toContainEqual({
      channelId: channel.id,
      reason: "not readable yet",
    });
    const [item] = await database
      .select({ finishedAt: workItems.finishedAt, runAt: workItems.runAt })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.finishedAt).toBeNull();
    expect(item?.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("a conversation that no longer exists is dropped, not retried", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    // The channel goes while its naming is still queued. A queue key is not a foreign key, so the
    // work outlives the thing it was about — which happens for real on a delete, and happens on
    // every integration test that seeds a channel and tears it down.
    await database.delete(channels).where(eq(channels.id, channel.id));

    await summariseClaimedChannels(options({}));

    const [item] = await database
      .select({
        finishedAt: workItems.finishedAt,
        attempts: workItems.attempts,
      })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    // Finished rather than released: nothing about a deleted conversation is different in fifteen
    // seconds, and retrying it to the attempt cap burns a model call's worth of work each time.
    expect(item?.finishedAt).not.toBeNull();
    expect(item?.attempts).toBe(1);
  });

  test("a soft-deleted conversation is dropped the same way", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    await database
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channel.id));

    await summariseClaimedChannels(options({}));

    const [item] = await database
      .select({ finishedAt: workItems.finishedAt })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.finishedAt).not.toBeNull();
    expect((await summaryOf(channel.id))?.summary).toBeNull();
  });

  test("stays inside the NOTIFY payload limit on a crowded channel", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    // The title is short and fixed; the term that grows is the member list the payload carries, so
    // that is the term the test grows. `pg_notify` refuses a payload over 8000 bytes outright, and
    // it refuses it inside the transaction that writes the title.
    const crowd = [];
    for (let index = 0; index < 100; index += 1) {
      const member = await createUser();
      crowd.push(member.id);
      await database
        .insert(channelMemberships)
        .values({ channelId: channel.id, userId: member.id });
    }

    // A single notification cannot hold this event: delivery must split the recipients.
    const members = [owner.id, ...crowd];
    const expectedEvent = {
      channelId: channel.id,
      memberIds: members,
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      summary: "Travel receipt rules",
    } satisfies ChannelActivityEvent;
    expect(
      Buffer.byteLength(JSON.stringify(expectedEvent), "utf8"),
    ).toBeGreaterThan(8000);

    const hub = createChannelEventHub();
    const heard = new Map<string, string[]>();
    for (const member of members) {
      const payloads: string[] = [];
      heard.set(member, payloads);
      hub.register(member, (payload) => payloads.push(payload));
    }
    // Subscribe after fixture activity, so only the summary producer can satisfy this observation.
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      await offer(channel.id);
      const report = await summariseClaimedChannels(
        options({ title: titler("Travel receipt rules") }),
      );

      expect(report.written).toContain(channel.id);
      expect((await summaryOf(channel.id))?.summary).toBe(
        "Travel receipt rules",
      );
      const deadline = Date.now() + 2_000;
      while (
        [...heard.values()].some((payloads) => payloads.length === 0) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(25);
      }
      for (const [member, payloads] of heard) {
        expect(payloads).toHaveLength(1);
        const payload = payloads[0]!;
        expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(8_000);
        expect(JSON.parse(payload)).toEqual({
          ...expectedEvent,
          memberIds: expect.arrayContaining([member]),
        });
      }
      const batches = [...new Set([...heard.values()].flat())];
      const deliveredMembers = batches.flatMap((payload) => {
        const event: ChannelActivityEvent = JSON.parse(payload);
        return event.memberIds;
      });
      expect(deliveredMembers.sort()).toEqual([...members].sort());
    } finally {
      await listener.stop();
    }
  });

  test("bounds a summary containing one oversized grapheme before announcing it", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);
    const report = await summariseClaimedChannels(
      options({ title: titler(`x${"\u0301".repeat(4_100)}`) }),
    );

    expect(report.written).toContain(channel.id);
    expect((await summaryOf(channel.id))?.summary).toBe("…");
  });

  test("a model that fails leaves the work to be tried again", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({
        title: async () => {
          throw new Error("the model is unreachable");
        },
      }),
    );

    expect((await summaryOf(channel.id))?.summary).toBeNull();
    const [item] = await database
      .select({ attempts: workItems.attempts, error: workItems.lastError })
      .from(workItems)
      .where(eq(workItems.key, channel.id));
    expect(item?.attempts).toBe(1);
    expect(item?.error).toContain("the model is unreachable");
  });

  test("flattens and shortens whatever the model answers with", async () => {
    const owner = await createUser();
    const channel = await createUsedChannel(owner);
    await offer(channel.id);

    await summariseClaimedChannels(
      options({ title: titler('  "Travel\nreceipt   rules"  ') }),
    );

    // The quotes a model wraps a title in, the newline, and the run of spaces all go: a roster row
    // is one line of plain text.
    expect((await summaryOf(channel.id))?.summary).toBe("Travel receipt rules");
  });
});
