import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { frameFirstDay } from "@openbot/shared/first-day";
import { FIRST_DAY_KIND } from "../src/channels/first-day";
import { MORNING_BRIEF_KIND } from "../src/channels/morning-brief";
import { frameMorningBrief } from "@openbot/shared/morning-brief";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  openduetChannels,
  openduetTasks,
  users,
  workItems,
} from "../src/db/schema";
import { createDuetChannelStore } from "../src/openduet/channels";
import { createTaskStore } from "../src/openduet/task-store";
import { createTaskThreads } from "../src/openduet/task-threads";
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

const testPrefix = `channel-activity-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(workItems).where(eq(workItems.key, channelId));
    // A morning brief's key is its conversation and its date.
    await database
      .delete(workItems)
      .where(like(workItems.key, `${channelId}:%`));
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
    name: "Channel Activity Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/**
 * The sidebar asked for every channel this person has, on every render.
 *
 * One row per channel-agent pair, and nothing removes a channel: somebody who talks to their Bot
 * daily accumulates thousands, so a query that is instant in a demo returns thousands of rows on
 * every page load, for every employee, and grows for as long as they use the product.
 *
 * The page has to be chosen over channels rather than over rows, which is the whole subtlety here: a
 * limit on rows would cut a two-Bot channel in half and its second Bot would arrive on the next page
 * as a separate entry with the same id.
 */
describe("reading a person's channels", () => {
  test("answers a page rather than everything", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    for (let index = 0; index < 5; index += 1) {
      await createChannel(owner, [agentId]);
    }

    const page = await store.list(owner, { limit: 2 });

    expect(page.channels).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  test("walking the cursor reaches every channel exactly once", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      expected.push((await createChannel(owner, [agentId])).id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list(owner, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.channels.map((channel) => channel.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(expected.sort());
  });

  test("channels made in the same millisecond are each on a page", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      expected.push((await createChannel(owner, [agentId])).id);
    }
    // One transaction's worth of channels, as a package sync or an import makes them: the same
    // instant, kept by PostgreSQL to the microsecond and by a JavaScript `Date` to the millisecond.
    await database
      .update(channels)
      .set({ createdAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz` })
      .where(inArray(channels.id, expected));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list(owner, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.channels.map((channel) => channel.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen.sort()).toEqual(expected.sort());
  });

  test("a channel with two Bots is never split across pages", async () => {
    /*
     * The reason the page is chosen over channels and the agents joined afterwards. Limiting the row
     * set would put the channel's first Bot on one page and its second on the next, as two entries
     * sharing an id, and the sidebar would render the same conversation twice with half its Bots.
     */
    const owner = await createUser();
    const first = await createAgent(owner, "First");
    const second = await createAgent(owner, "Second");
    const shared = await createChannel(owner, [first, second]);
    await createChannel(owner, [first]);

    const seen: { id: string; agentIds: string[] }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await store.list(owner, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      // One channel per page, whatever it holds. A row limit would put two here.
      expect(result.channels.length).toBeLessThanOrEqual(1);
      seen.push(...result.channels);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    // Which of the two sorts first is incidental; that the shared one arrives once and whole is not.
    const found = seen.filter((channel) => channel.id === shared.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.agentIds.sort()).toEqual([first, second].sort());
  });

  test("a caller cannot ask for every channel in one page", async () => {
    // The limit arrives over HTTP, so the ceiling is what makes paging a property of the endpoint.
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await createChannel(owner, [agentId]);

    const page = await store.list(owner, { limit: 100_000 });

    expect(page.channels.length).toBeLessThanOrEqual(200);
  });

  test("a nonsense cursor reads as the first page", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await createChannel(owner, [agentId]);

    const page = await store.list(owner, { cursor: "not-a-cursor" });

    expect(page.channels).toHaveLength(1);
  });

  test("somebody with no channels gets an empty page and no cursor", async () => {
    const owner = await createUser();

    const page = await store.list(owner);

    expect(page.channels).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

/**
 * The roster reads the last thing said from our own row rather than from the Intelligence platform,
 * so it stays one indexed query however long the conversations get. What is stored is whatever the
 * client that ran the agent reported, which is why each of these guards exists.
 */
describe("channel activity", () => {
  test("records the last message and returns it on the roster", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const at = new Date();

    await store.recordActivity(owner, channel.id, {
      agentId,
      at,
      text: "Categorized three expenses.",
    });

    expect((await store.list(owner)).channels).toEqual([
      {
        ...channel,
        busy: false,
        // Nothing has named this conversation: the sweep that does runs outside this store.
        summary: null,
        lastMessage: "Categorized three expenses.",
        lastMessageAgentId: agentId,
        lastMessageAt: at,
        createdAt: expect.any(Date),
        pinned: false,
        lastReadAt: null,
        // An ordinary conversation, not an OpenDuet task's own.
        taskId: null,
        // Nor one of the person's OpenDuet channels.
        openduetChannel: false,
      },
    ]);
  });

  test("keeps a person's roster to the channels they belong to", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    expect((await store.list(otherUser)).channels).toEqual([]);
    await expect(
      store.recordActivity(otherUser, channel.id, {
        agentId: null,
        at: new Date(),
        text: "Not mine.",
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("ignores a report older than what is already stored", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const newest = new Date();
    const older = new Date(newest.getTime() - 60_000);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: newest,
      text: "The reply.",
    });
    // A person's message and the agent's reply are two separate reports. A slow one must not
    // overwrite a newer one that already landed.
    await store.recordActivity(owner, channel.id, {
      agentId: null,
      at: older,
      text: "The question.",
    });

    expect((await store.list(owner)).channels[0]?.lastMessage).toBe(
      "The reply.",
    );
  });

  test("stores at most 200 code points, without control characters", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(),
      // A terminal escape and a newline: a preview is rendered as text, not replayed as control.
      text: `line one\nline two \u001b[31m ${"x".repeat(400)}`,
    });

    const stored = (await store.list(owner)).channels[0]?.lastMessage ?? "";
    expect(Array.from(stored).length).toBeLessThanOrEqual(200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they were removed.
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(stored.startsWith("line one line two")).toBe(true);
  });

  test("refuses an agent that is not in the channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const strangerId = await createAgent(owner, "Stranger");
    const channel = await createChannel(owner, [agentId]);

    await expect(
      store.recordActivity(owner, channel.id, {
        agentId: strangerId,
        at: new Date(),
        text: "Not from this channel.",
      }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("puts a channel just created above one that has already been used", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const used = await createChannel(owner, [agentId]);
    await store.recordActivity(owner, used.id, {
      agentId,
      // A minute back, not `now`. The activity time comes from this process and `created_at` comes
      // from Postgres, so two events written in the same instant are ordered by whichever clock is
      // marginally ahead. The property under test is the ordering rule, not the tie-break.
      at: new Date(Date.now() - 60_000),
      text: "Said something a minute ago.",
    });

    // Starting a conversation is the most recent thing this person did, and it is the one they are
    // about to type in. Sorting it under every channel that has a message would bury it.
    const fresh = await createChannel(owner, [agentId]);

    expect(
      (await store.list(owner)).channels.map((channel) => channel.id),
    ).toEqual([fresh.id, used.id]);
  });

  test("sorts by recency and leaves silent channels below, not absent", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const quiet = await createChannel(owner, [agentId]);
    const busy = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, busy.id, {
      agentId,
      at: new Date(),
      text: "Said something.",
    });

    expect(
      (await store.list(owner)).channels.map((channel) => channel.id),
    ).toEqual([busy.id, quiet.id]);
  });

  test("a title rides along on the roster without touching its order", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const quiet = await createChannel(owner, [agentId]);
    const busy = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, busy.id, {
      agentId,
      at: new Date(),
      text: "Said something.",
    });
    // Named the older, quieter conversation, which is the case that would expose a summary leaking
    // into the ordering: it sorts second before and must still sort second after.
    await database
      .update(channels)
      .set({ summary: "An older subject", summaryAt: new Date() })
      .where(eq(channels.id, quiet.id));

    const roster = (await store.list(owner)).channels;

    expect(roster.map((channel) => channel.id)).toEqual([busy.id, quiet.id]);
    expect(roster.map((channel) => channel.summary)).toEqual([
      null,
      "An older subject",
    ]);
  });
});

/**
 * A pin holds a channel at the top of the roster, which is a claim about the roster and not about
 * whichever page happens to be loaded.
 *
 * Ordering pinned-first only in the browser sorts the rows already fetched, so a channel somebody
 * pinned and then did not talk to for a month sits on page three and never appears at the top at
 * all — the roster the person sees contradicts the pin they made. The order therefore belongs in the
 * query, and the cursor has to carry the pin flag as its leading element or paging walks the same
 * channel twice.
 */
describe("a pinned channel in a paged roster", () => {
  /** Channels with explicit, minute-apart activity, newest last, so recency order is not a clock race. */
  async function channelsWithActivity(owner: AgentActor, count: number) {
    const agentId = await createAgent(owner);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await createChannel(owner, [agentId])).id);
    }
    const base = Date.now() - count * 60_000;
    for (const [index, id] of ids.entries()) {
      await store.recordActivity(owner, id, {
        agentId,
        at: new Date(base + index * 60_000),
        text: `Message ${index}`,
      });
    }
    return ids;
  }

  /** Every channel the cursor reaches, in the order the pages hand them over. */
  async function walk(owner: AgentActor, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await store.list(owner, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.channels.map((channel) => channel.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return seen;
  }

  test("lifts a pinned channel onto the first page, however old it is", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 6);
    const oldest = ids[0] as string;

    await store.setPinned(owner, oldest, true);

    // Two per page, six channels: on recency alone this one is the last row of the last page.
    const page = await store.list(owner, { limit: 2 });
    expect(page.channels.map((channel) => channel.id)[0]).toBe(oldest);
  });

  test("walks every channel exactly once across pinned and unpinned", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 6);
    // Two pins, chosen so the group boundary does not line up with a page boundary.
    await store.setPinned(owner, ids[0] as string, true);
    await store.setPinned(owner, ids[3] as string, true);

    const seen = await walk(owner, 2);

    // Pinned first, and recency within each group: the cursor has to order pages the same way the
    // first page is ordered, or a channel is served twice and another never at all.
    expect(seen).toEqual([
      ids[3] as string,
      ids[0] as string,
      ids[5] as string,
      ids[4] as string,
      ids[2] as string,
      ids[1] as string,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("unpinning puts the channel back where recency alone would have it", async () => {
    const owner = await createUser();
    const ids = await channelsWithActivity(owner, 4);
    const oldest = ids[0] as string;

    await store.setPinned(owner, oldest, true);
    await store.setPinned(owner, oldest, false);

    expect(await walk(owner, 2)).toEqual([
      ids[3] as string,
      ids[2] as string,
      ids[1] as string,
      oldest,
    ]);
  });
});

/**
 * The one conversation a person has with one Bot.
 *
 * A hop delivers into it, and a Bot asked for several things in one turn produces several hops at
 * once. Looking and then making is not find-or-create: each of two concurrent deliveries found
 * nothing and made a conversation, so that person had two Knowledge channels holding two threads,
 * with the answers split between them.
 */
describe("finding or making a person's channel with one Bot", () => {
  test("two at once get the same conversation, not one each", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");

    const [first, second] = await Promise.all([
      store.direct(owner, agentId),
      store.direct(owner, agentId),
    ]);
    createdChannelIds.push(first.id, second.id);

    expect(second.id).toBe(first.id);
    expect(second.threadId).toBe(first.threadId);
  });

  test("an existing conversation is reused rather than added to", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");
    const made = await createChannel(owner, [agentId]);

    const found = await store.direct(owner, agentId);

    expect(found.id).toBe(made.id);
  });

  /*
   * A channel holding this Bot and another one matches an agent test on its own. Delivering into it
   * would put a hop's answer in front of a Bot nobody had asked.
   */
  test("a channel with a second Bot in it is not that person's direct one", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Knowledge");
    const other = await createAgent(owner, "Research");
    const shared = await createChannel(owner, [agentId, other]);

    const found = await store.direct(owner, agentId);
    createdChannelIds.push(found.id);

    expect(found.id).not.toBe(shared.id);
    expect(found.agentIds).toEqual([agentId]);
  });
});

test("simultaneous first-day starts share one conversation and only one greeting claim", async () => {
  const owner = await createUser();
  const bot = await createAgent(owner);
  const starts = await Promise.all([
    store.firstDay(owner, bot, frameFirstDay("Get to know me.")),
    store.firstDay(owner, bot, frameFirstDay("Get to know me.")),
  ]);
  createdChannelIds.push(starts[0]!.channel.id);
  expect(new Set(starts.map((start) => start.channel.id)).size).toBe(1);
  expect(starts.filter((start) => start.claimed)).toHaveLength(1);
  expect((await store.firstDay(owner, bot)).claimed).toBe(false);
  const greetings = await database
    .select()
    .from(workItems)
    .where(eq(workItems.key, starts[0]!.channel.id));
  expect(greetings).toHaveLength(1);
  expect(greetings[0]?.kind).toBe(FIRST_DAY_KIND);
});

/*
 * The day's morning brief: once per person, per Bot, per local date, never on the first day, and
 * durable, because the claim is a column on the conversation rather than a work item's key, which
 * is free again once the queue purges the finished item.
 */
describe("the morning brief's claim", () => {
  const BRIEF = frameMorningBrief("Give me my morning brief.");

  /** The person's conversation with the Bot, with something said in it: a day after the first. */
  async function usedChat(owner: AgentActor, bot: string) {
    const chat = await store.direct(owner, bot);
    createdChannelIds.push(chat.id);
    await store.recordActivity(owner, chat.id, {
      text: "What's on today?",
      agentId: null,
      at: new Date(),
    });
    return chat;
  }

  async function briefsIn(channelId: string) {
    return database
      .select({ key: workItems.key, payload: workItems.payload })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, MORNING_BRIEF_KIND),
          like(workItems.key, `${channelId}:%`),
        ),
      )
      .orderBy(workItems.key);
  }

  async function claimedOn(channelId: string) {
    const [row] = await database
      .select({ on: channels.morningBriefOn })
      .from(channels)
      .where(eq(channels.id, channelId));
    return row?.on ?? null;
  }

  test("is taken once per local date, with the brief queued in the same transaction", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);

    const first = await store.morningBrief(owner, bot, "2026-10-26", BRIEF);
    expect(first).toMatchObject({ claimed: true, channel: { id: chat.id } });
    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(false);
    expect(await claimedOn(chat.id)).toBe("2026-10-26");
    const [queued, ...more] = await briefsIn(chat.id);
    expect(more).toEqual([]);
    const token = (queued?.payload as { claim?: string } | undefined)?.claim;
    expect(token).toMatch(/^[0-9a-f]{8}$/);
    expect(queued).toEqual({
      key: `${chat.id}:2026-10-26:${token}`,
      payload: {
        ownerUserId: owner.id,
        agentId: bot,
        channelId: chat.id,
        date: "2026-10-26",
        claim: token,
        text: BRIEF,
      },
    });

    // The next day is a day of its own.
    expect(
      (await store.morningBrief(owner, bot, "2026-10-27", BRIEF)).claimed,
    ).toBe(true);
    expect(
      (await briefsIn(chat.id))
        .map((brief) => (brief.payload as { date: string }).date)
        .sort(),
    ).toEqual(["2026-10-26", "2026-10-27"]);
  });

  test("queues a brief of its own when the same date is claimed again after the claim was cleared", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);
    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(true);
    // The first brief ran and finished; the queue keeps its item.
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(like(workItems.key, `${chat.id}:%`));
    await database
      .update(channels)
      .set({ morningBriefOn: null })
      .where(eq(channels.id, chat.id));

    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(true);
    const briefs = await briefsIn(chat.id);
    expect(briefs).toHaveLength(2);
    expect(new Set(briefs.map((brief) => brief.key)).size).toBe(2);
  });

  test("holds after the queue has forgotten the brief's work item", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);
    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(true);
    // What `purge` (work/queue.ts) does to a finished item once its window has passed.
    await database.delete(workItems).where(like(workItems.key, `${chat.id}:%`));

    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(false);
    expect(await briefsIn(chat.id)).toEqual([]);
  });

  test("is refused while nothing has been said: the first day still owns the conversation", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const start = await store.morningBrief(owner, bot, "2026-10-26", BRIEF);
    createdChannelIds.push(start.channel.id);

    expect(start.claimed).toBe(false);
    expect(await claimedOn(start.channel.id)).toBeNull();
    expect(await briefsIn(start.channel.id)).toEqual([]);
  });

  test("is refused on the day the first day took, and taken on the next", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const greeting = await store.firstDay(
      owner,
      bot,
      frameFirstDay("Get to know me."),
      "2026-10-26",
    );
    createdChannelIds.push(greeting.channel.id);
    expect(greeting.claimed).toBe(true);
    // The greeting's turn has run and said something; Chat is opened again later that day.
    await store.recordActivity(owner, greeting.channel.id, {
      text: "Get to know me.",
      agentId: null,
      at: new Date(),
    });

    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(false);
    expect(await briefsIn(greeting.channel.id)).toEqual([]);
    expect(
      (await store.morningBrief(owner, bot, "2026-10-27", BRIEF)).claimed,
    ).toBe(true);
  });

  test("is refused for a date before the one already claimed, so two clocks cannot take turns", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);
    expect(
      (await store.morningBrief(owner, bot, "2026-10-27", BRIEF)).claimed,
    ).toBe(true);
    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(false);
    expect(await claimedOn(chat.id)).toBe("2026-10-27");
  });

  test("is given to a conversation with messages and no first-day stamp, which had its first day before the stamp", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);
    const [row] = await database
      .select({ startedAt: channels.firstDayStartedAt })
      .from(channels)
      .where(eq(channels.id, chat.id));
    expect(row?.startedAt).toBeNull();

    expect(
      (await store.morningBrief(owner, bot, "2026-10-26", BRIEF)).claimed,
    ).toBe(true);
  });

  test("simultaneous asks from two tabs and two devices on two replicas queue one brief", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const chat = await usedChat(owner, bot);
    const databases = [0, 1].map(() => createDatabase(databaseUrl, TEST_POOL));
    try {
      const replicas = databases.map((connection) =>
        createChannelStore(
          connection,
          profileStore,
          createThreadIdentity("test-deployment"),
        ),
      );
      const asks = await Promise.all(
        [0, 1, 2, 3].map((index) =>
          replicas[index % 2]!.morningBrief(owner, bot, "2026-10-26", BRIEF),
        ),
      );

      expect(new Set(asks.map((ask) => ask.channel.id))).toEqual(
        new Set([chat.id]),
      );
      expect(asks.filter((ask) => ask.claimed)).toHaveLength(1);
      expect(await briefsIn(chat.id)).toHaveLength(1);
    } finally {
      for (const connection of databases) await connection.$client.close();
    }
  });
});

for (const deletionAt of ["before hydration", "before claim"] as const) {
  test(`first-day starts share one replacement when their selected conversation is deleted ${deletionAt}`, async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    const previous = await createChannel(owner, [bot]);
    const selected = Promise.withResolvers<void>();
    const releaseReads = Promise.withResolvers<void>();
    let waiting = 0;
    const replicas = Array.from({ length: 2 }, () => {
      const replica = createChannelStore(
        database,
        profileStore,
        createThreadIdentity("test-deployment"),
      );
      const waitForDeletion = async () => {
        waiting += 1;
        if (waiting === 2) selected.resolve();
        await releaseReads.promise;
      };
      // Only scheduling is controlled: lookup, claim, and deletion use PostgreSQL.
      if (deletionAt === "before hydration") {
        const get = replica.get;
        replica.get = async (actor, channelId) => {
          if (channelId === previous.id) await waitForDeletion();
          return get(actor, channelId);
        };
      } else {
        const direct = replica.direct;
        let held = false;
        replica.direct = async (actor, agentId) => {
          const channel = await direct(actor, agentId);
          if (channel.id === previous.id && !held) {
            held = true;
            await waitForDeletion();
          }
          return channel;
        };
      }
      return replica;
    });
    const starts = Promise.all(
      replicas.map(async (replica) => {
        const start = await replica.firstDay(
          owner,
          bot,
          frameFirstDay("Get to know me."),
        );
        createdChannelIds.push(start.channel.id);
        return start;
      }),
    );
    void starts.catch(selected.reject);
    const timeout = setTimeout(
      () =>
        selected.reject(new Error("Both callers did not select the channel.")),
      3_000,
    );
    try {
      await selected.promise;
      expect(await store.softDelete(owner, previous.id)).toBe(true);
      releaseReads.resolve();
      const [first, second] = await starts;
      if (!first || !second)
        throw new Error("Both first-day starts must finish.");

      expect(first.channel.id).not.toBe(previous.id);
      expect(second.channel.id).toBe(first.channel.id);
      expect(second.channel.threadId).toBe(first.channel.threadId);
      expect([first, second].filter((start) => start.claimed)).toHaveLength(1);
      expect(
        (await store.list(owner)).channels.map((channel) => channel.id),
      ).toEqual([first.channel.id]);
      const greetings = await database
        .select({ key: workItems.key, kind: workItems.kind })
        .from(workItems)
        .where(
          inArray(workItems.key, [
            previous.id,
            first.channel.id,
            second.channel.id,
          ]),
        );
      expect(greetings).toEqual([
        { key: first.channel.id, kind: FIRST_DAY_KIND },
      ]);
      if (deletionAt === "before claim") {
        const [deleted] = await database
          .select({ startedAt: channels.firstDayStartedAt })
          .from(channels)
          .where(eq(channels.id, previous.id));
        expect(deleted?.startedAt).toBeNull();
        expect(await replicas[0]!.get(owner, first.channel.id)).toMatchObject({
          id: first.channel.id,
        });
        expect(await replicas[1]!.get(owner, second.channel.id)).toMatchObject({
          id: second.channel.id,
        });
      }
    } finally {
      clearTimeout(timeout);
      releaseReads.resolve();
      await starts;
    }
  });
}

describe("creating a task or workstream conversation", () => {
  function threadsFor(connection = database) {
    return createTaskThreads({
      database: connection,
      store: createTaskStore(connection),
      channels: createChannelStore(
        connection,
        createAgentProfileStore(
          connection,
          new URL("https://managed.example.test/ag-ui"),
        ),
        createThreadIdentity("test-deployment"),
      ),
      actorFor: async (id) => ({ id, role: "user" }),
      scopeFor: async () => null,
    });
  }

  function taskInput(owner: AgentActor, bot: string) {
    return {
      ownerUserId: owner.id,
      agentId: bot,
      title: "Prepare visit notes",
      why: null,
      origin: "asked" as const,
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    };
  }

  for (const kind of ["task", "workstream"] as const) {
    for (const outcome of ["commits", "rolls back"] as const) {
      test(`${kind} creation ${outcome} without exposing an unclassified conversation`, async () => {
        const owner = await createUser();
        const bot = await createAgent(owner);
        const applicationName = `conversation-creation-${randomUUID()}`;
        const namedUrl = new URL(databaseUrl);
        namedUrl.searchParams.set("application_name", applicationName);
        // One connection catches a transaction that accidentally writes outside its own connection.
        const creationDatabase = createDatabase(namedUrl.toString(), {
          max: 1,
        });
        const hellos: string[] = [];
        const workstreams = createDuetChannelStore({
          database: creationDatabase,
          channels: createChannelStore(
            creationDatabase,
            createAgentProfileStore(
              creationDatabase,
              new URL("https://managed.example.test/ag-ui"),
            ),
            createThreadIdentity("test-deployment"),
          ),
          hello: async ({ channel }) => {
            hellos.push(channel.id);
          },
        });
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const table = kind === "task" ? openduetTasks : openduetChannels;
        const tableName =
          kind === "task" ? "openduet_tasks" : "openduet_channels";
        const blocker = database.transaction(async (transaction) => {
          // Readers still run: only the classification insert waits, after the channel is written.
          await transaction.execute(sql`lock table ${table} in share mode`);
          locked.resolve();
          await release.promise;
        });
        void blocker.catch(locked.reject);
        let opening:
          | Promise<
              PromiseSettledResult<{ channelId: string; taskId: string | null }>
            >
          | undefined;
        try {
          await locked.promise;
          const creation =
            kind === "task"
              ? threadsFor(creationDatabase)
                  .open(taskInput(owner, bot))
                  .then((task) => ({
                    channelId: task.channelId,
                    taskId: task.id,
                  }))
              : workstreams
                  .create(owner, {
                    botId: bot,
                    name: "Kiln move",
                    purpose: "Moving the kiln to the new studio.",
                    icon: "home",
                    colour: "green",
                  })
                  .then((channel) => ({ channelId: channel.id, taskId: null }));
          // Capture the result immediately; each outcome below explicitly checks success or failure.
          opening = creation.then(
            (value) => {
              createdChannelIds.push(value.channelId);
              return { status: "fulfilled" as const, value };
            },
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          const deadline = Date.now() + 3_000;
          let blockedPid: number | undefined;
          while (Date.now() < deadline) {
            const waiting = await database.execute<{ pid: number }>(sql`
              select pid from pg_stat_activity
              where application_name = ${applicationName}
                and wait_event_type = 'Lock'
                and query ilike ${`insert into "${tableName}"%`}
            `);
            if (waiting[0]) {
              blockedPid = waiting[0].pid;
              break;
            }
            await Bun.sleep(10);
          }
          expect(blockedPid).toBeDefined();
          expect(hellos).toEqual([]);
          if (outcome === "rolls back") {
            // A real PostgreSQL failure at the classification insert, without mutating table schema.
            await database.execute(
              sql`select pg_cancel_backend(${blockedPid})`,
            );
            expect(await opening).toMatchObject({
              status: "rejected",
              reason: { cause: { errno: "57014" } },
            });
            const rows = await database
              .select({ id: channels.id })
              .from(channels)
              .innerJoin(
                intelligenceChannelMappings,
                eq(intelligenceChannelMappings.channelId, channels.id),
              )
              .where(eq(intelligenceChannelMappings.userId, owner.id));
            createdChannelIds.push(...rows.map((row) => row.id));
            // Read raw rows, including soft-deleted ones: compensating deletion is not rollback.
            expect(rows).toHaveLength(0);
            expect(hellos).toEqual([]);
            return;
          }

          // Reader completion must be observed while classification is still held.
          // A deadline fails the test; cleanup must never turn a late read into success.
          const readers = [
            store.firstDay(owner, bot, frameFirstDay("Get to know me.")),
            store.firstDay(owner, bot, frameFirstDay("Get to know me.")),
            store.direct(owner, bot).then((channel) => {
              createdChannelIds.push(channel.id);
              return channel;
            }),
          ] as const;
          const timedOut = Promise.withResolvers<never>();
          const readTimeout = setTimeout(
            () =>
              timedOut.reject(
                new Error(
                  "Readers did not finish while classification was held.",
                ),
              ),
            3_000,
          );
          const [first, second, direct] = await Promise.race([
            Promise.all(readers),
            timedOut.promise,
          ]).finally(async () => {
            clearTimeout(readTimeout);
            release.resolve();
            await Promise.allSettled(readers);
          });
          expect(first.channel.id).toBe(direct.id);
          expect(second.channel.id).toBe(direct.id);
          expect([first, second].filter((start) => start.claimed)).toHaveLength(
            1,
          );

          await blocker;
          const result = await opening;
          if (result.status === "rejected") throw result.reason;
          const conversation = result.value;
          expect(conversation.channelId).not.toBe(direct.id);
          expect((await store.direct(owner, bot)).id).toBe(direct.id);
          expect(
            (await store.get(owner, conversation.channelId))?.agentIds,
          ).toEqual([bot]);
          if (kind === "task") {
            const page = await store.list(owner);
            expect(
              page.channels.find((row) => row.id === conversation.channelId)
                ?.taskId,
            ).toBe(conversation.taskId);
          } else {
            expect(
              await workstreams.get(owner.id, conversation.channelId),
            ).toMatchObject({ dressed: true, name: "Kiln move" });
            expect((await workstreams.list(owner.id, bot)).everythingId).toBe(
              direct.id,
            );
            await workstreams.idle();
            expect(hellos).toEqual([conversation.channelId]);
          }
          const greetings = await database
            .select()
            .from(workItems)
            .where(eq(workItems.key, direct.id));
          expect(greetings).toHaveLength(1);
          expect(greetings[0]?.kind).toBe(FIRST_DAY_KIND);
          expect(
            await database
              .select()
              .from(workItems)
              .where(eq(workItems.key, conversation.channelId)),
          ).toHaveLength(0);
        } finally {
          release.resolve();
          try {
            await blocker;
            await opening;
          } finally {
            await creationDatabase.$client.close();
          }
        }
      });
    }
  }

  test("a rejected task insert leaves no conversation for Chat to adopt", async () => {
    const owner = await createUser();
    const bot = await createAgent(owner);
    await expect(
      threadsFor().open({
        ...taskInput(owner, bot),
        // A real foreign-key rejection after the channel has been inserted.
        suggestionId: `missing-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ cause: { errno: "23503" } });
    const page = await store.list(owner);
    createdChannelIds.push(...page.channels.map((channel) => channel.id));
    expect(page.channels).toHaveLength(0);
  });
});

test("a refused second tab clears only its own busy claim", async () => {
  const owner = await createUser();
  const bot = await createAgent(owner);
  const channel = await createChannel(owner, [bot]);
  await store.signalChannelBusy(owner, channel.id, true, "tab-a");
  await store.signalChannelBusy(owner, channel.id, true, "tab-b");
  await store.signalChannelBusy(owner, channel.id, false, "tab-b");
  const [row] = await database
    .select({ claims: channels.busyClaims })
    .from(channels)
    .where(eq(channels.id, channel.id));
  expect(Object.keys(row!.claims)).toEqual(["tab-a"]);
});

test("a __proto__ run owns a busy claim until it releases it", async () => {
  const owner = await createUser();
  const bot = await createAgent(owner);
  const channel = await createChannel(owner, [bot]);
  const runId = "__proto__";

  await store.signalChannelBusy(owner, channel.id, true, runId);
  const [started] = await database
    .select({ claims: channels.busyClaims })
    .from(channels)
    .where(eq(channels.id, channel.id));
  expect(Object.keys(started!.claims)).toEqual([runId]);
  expect(started!.claims[runId]).toEqual(expect.any(Number));
  expect((await store.list(owner)).channels[0]?.busy).toBe(true);

  await store.signalChannelBusy(owner, channel.id, false, runId);
  const [finished] = await database
    .select({ claims: channels.busyClaims })
    .from(channels)
    .where(eq(channels.id, channel.id));
  expect(finished!.claims).toEqual({});
  expect((await store.list(owner)).channels[0]?.busy).toBe(false);
});

test("an explicit non-question result keeps a stripped draft tail from asking the person", async () => {
  const owner = await createUser();
  const bot = await createAgent(owner);
  const channel = await createChannel(owner, [bot]);
  await store.recordActivity(owner, channel.id, {
    text: "Should we ship Friday?",
    agentId: bot,
    at: new Date(),
    needsInput: false,
  });
  const [row] = await database
    .select({ needsInput: channels.lastMessageNeedsInput })
    .from(channels)
    .where(eq(channels.id, channel.id));
  expect(row?.needsInput).toBe(false);
});
