import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  frameChannelHello,
  readChannelHello,
} from "@openbot/shared/channel-hello";
import {
  DEFAULT_CHANNEL_ICON,
  defaultChannelColour,
} from "@openbot/shared/channel-look";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createChannelRoutes,
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
  users,
  workItems,
} from "../src/db/schema";
import {
  type ChannelHelloStarter,
  type ChannelRecord,
  createChannelHello,
  createDuetChannelRoutes,
  createDuetChannelStore,
} from "../src/openduet/channels";
import { createTaskStore } from "../src/openduet/task-store";
import { createTaskThreads } from "../src/openduet/task-threads";
import { ADD_TASKS_TOOL, START_TASK_TOOL } from "../src/openduet/tasks";
import { createOpenDuetTools } from "../src/openduet/wiring";
import {
  createProactiveEngine,
  type ProactiveScope,
} from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import type { WorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The drawer's channels: a conversation with the Bot that is neither Everything nor a task's, with
 * a look of its own. These run against PostgreSQL, because which conversation is Everything, which
 * is a task's and which is a channel is decided by queries across OpenBot's tables and OpenDuet's.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const taskStore = createTaskStore(database);
const proactiveStore = createProactiveStore(database);
const prefix = `duet-channels-${randomUUID()}`;
const owner: AgentActor = { id: `${prefix}-owner`, role: "user" };
const other: AgentActor = { id: `${prefix}-other`, role: "user" };
let bot = "";

const hellos: Parameters<ChannelHelloStarter>[0][] = [];
const store = createDuetChannelStore({
  database,
  channels: channelStore,
  hello: async (input) => {
    hellos.push(input);
  },
});

const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
): Promise<ProactiveScope | null> => {
  const channel = await channelStore.get(
    await actorFor(ownerUserId),
    channelId,
  );
  return channel?.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};

/** A queue that only this file claims from, as the task-threads suite keeps one. */
function memoryQueue(): WorkQueue {
  const items = new Map<string, { kind: string; key: string; done: boolean }>();
  return {
    offer: async (item: { kind: string; key: string }) => {
      items.set(`${item.kind}:${item.key}`, { ...item, done: false });
      return "queued";
    },
    claim: async () => [],
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
    purge: async () => 0,
  } as unknown as WorkQueue;
}

const engine = createProactiveEngine({
  store: proactiveStore,
  memory: {
    formMemory: async () => ({ id: "m", duplicate: false, forgotten: false }),
  },
  queue: memoryQueue(),
  owner: "worker",
  runTurn: async () => {
    throw new Error("No research runs here.");
  },
  resolveScope: scopeFor,
  notify: async () => undefined,
  tasks: createTaskThreads({
    database,
    store: taskStore,
    channels: channelStore,
    actorFor,
    scopeFor,
  }),
  startTask: async () => undefined,
  catalogue: { listServers: async () => [] },
  mintThreadId: () => `${prefix}-research-thread`,
});

/** The person signed in, as `requireUser` would leave them. */
function routesAs(actor: AgentActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/openduet/channels",
    createDuetChannelRoutes(store, async (context, next) => {
      context.set("actor", {
        id: actor.id,
        email: `${actor.id}@example.test`,
        role: actor.role,
      } satisfies AuthenticatedActor);
      await next();
    }),
  );
  return app;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const kiln = {
  name: "Kiln move",
  purpose: "Moving the studio's kiln to the new space by March.",
  icon: "home",
  colour: "green",
} as const;

/** One more conversation with the Bot, said in `minutesFromNow` from now. */
async function conversation(minutesFromNow: number) {
  const channel = await channelStore.create(owner, [bot]);
  await channelStore.recordActivity(owner, channel.id, {
    text: "Hello",
    agentId: null,
    at: new Date(Date.now() + minutesFromNow * 60_000),
  });
  return channel;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner.id, email: `${owner.id}@example.test` },
    { id: other.id, email: `${other.id}@example.test` },
  ]);
  bot = (
    await profileStore.create(owner, {
      name: "OpenDuet",
      title: "Your proactive assistant",
      roleDescription: "Works for one person.",
      visibility: "private",
    })
  ).id;
});

afterAll(async () => {
  const mine = await database
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(
      intelligenceChannelMappings,
      eq(intelligenceChannelMappings.channelId, channels.id),
    )
    .where(inArray(intelligenceChannelMappings.userId, [owner.id, other.id]));
  if (mine.length > 0)
    await database.delete(channels).where(
      inArray(
        channels.id,
        mine.map((row) => row.id),
      ),
    );
  await database
    .delete(workItems)
    .where(sql`${workItems.payload}->>'ownerUserId' = ${owner.id}`);
  await database.delete(users).where(inArray(users.id, [owner.id, other.id]));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.$client.close();
});

describe("New channel", () => {
  test("makes a conversation with the Bot, named, with its purpose and look, and starts its hello", async () => {
    hellos.length = 0;
    const response = await routesAs(owner).request(
      "/api/openduet/channels",
      json({ botId: bot, ...kiln }),
    );
    expect(response.status).toBe(201);
    const { channel } = (await response.json()) as { channel: ChannelRecord };
    expect(channel).toMatchObject({
      name: "Kiln move",
      purpose: kiln.purpose,
      icon: "home",
      colour: "green",
      dressed: true,
      archivedAt: null,
      agentIds: [bot],
    });
    // OpenBot's own columns hold the name and the purpose.
    const [row] = await database
      .select({ name: channels.name, description: channels.description })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row).toEqual({ name: "Kiln move", description: kiln.purpose });

    await store.idle();
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toMatchObject({
      ownerUserId: owner.id,
      agentId: bot,
      hello: { name: "Kiln move", purpose: kiln.purpose },
    });
    expect(hellos[0]?.channel.id).toBe(channel.id);

    const listed = await store.list(owner.id, bot);
    expect(listed.channels.find((row) => row.id === channel.id)).toEqual(
      channel,
    );
  });

  test("refuses a name or purpose that is missing or too long, or a look outside the sheet's", async () => {
    const routes = routesAs(owner);
    for (const [body, said] of [
      [{ ...kiln, name: " " }, /Give the channel a name/],
      [{ ...kiln, name: "x".repeat(41) }, /at most 40 characters/],
      [{ ...kiln, purpose: "x".repeat(501) }, /to 500 characters/],
      [{ ...kiln, icon: "spaceship" }, /Pick an icon and a colour/],
      [{ ...kiln, colour: "#ff0000" }, /Pick an icon and a colour/],
    ] as const) {
      const response = await routes.request(
        "/api/openduet/channels",
        json({ botId: bot, ...body }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(
        said,
      );
    }
  });

  test("a purpose is optional: a channel can be only a name", async () => {
    const response = await routesAs(owner).request(
      "/api/openduet/channels",
      json({ botId: bot, name: "Studio", icon: "home", colour: "peach" }),
    );
    expect(response.status).toBe(201);
    const { channel } = (await response.json()) as { channel: ChannelRecord };
    expect(channel).toMatchObject({ name: "Studio", purpose: null });
    await store.idle();
    expect(hellos.at(-1)?.hello).toEqual({ name: "Studio", purpose: "" });
  });

  test("the database keeps a look to its sets, whatever writes it", async () => {
    const channel = await channelStore.create(owner, [bot]);
    const saved = database
      .insert(openduetChannels)
      .values({
        channelId: channel.id,
        icon: "spaceship" as never,
        colour: "green",
      })
      .then(() => "saved");
    await expect(saved).rejects.toThrow();
  });
});

describe("Everything and the channels", () => {
  test("Everything is the newest conversation with the Bot nobody dressed; the rest are channels", async () => {
    const older = await conversation(1);
    const chat = await conversation(2);
    const { everythingId, channels: listed } = await store.list(owner.id, bot);
    expect(everythingId).toBe(chat.id);
    expect(listed.some((row) => row.id === chat.id)).toBe(false);
    expect(listed.find((row) => row.id === older.id)).toMatchObject({
      dressed: false,
      purpose: null,
    });
    // The channel store's own "conversation with this Bot alone" agrees.
    expect((await channelStore.direct(owner, bot)).id).toBe(chat.id);
  });

  test("a channel the person talked in last never becomes Everything", async () => {
    const chat = await conversation(3);
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    await channelStore.recordActivity(owner, created.id, {
      text: "Book the movers",
      agentId: null,
      at: new Date(Date.now() + 10 * 60_000),
    });
    expect((await store.list(owner.id, bot)).everythingId).toBe(chat.id);
    expect((await channelStore.direct(owner, bot)).id).toBe(chat.id);
    // The roster marks it, on the wire too, so Chat in the app leaves it out.
    const roster = new Hono<{ Variables: AppVariables }>();
    roster.route(
      "/api/channels",
      createChannelRoutes(channelStore, async (context, next) => {
        context.set("actor", {
          id: owner.id,
          email: `${owner.id}@example.test`,
          role: owner.role,
        });
        await next();
      }),
    );
    const wire = (await (
      await roster.request("/api/channels?limit=200")
    ).json()) as { channels: { id: string; openduetChannel: boolean }[] };
    expect(
      wire.channels.find((row) => row.id === created.id)?.openduetChannel,
    ).toBe(true);
    expect(
      wire.channels.find((row) => row.id === chat.id)?.openduetChannel,
    ).toBe(false);
    const page = await channelStore.list(owner, { limit: 200 });
    expect(
      page.channels.find((row) => row.id === created.id)?.openduetChannel,
    ).toBe(true);
    expect(
      page.channels.find((row) => row.id === chat.id)?.openduetChannel,
    ).toBe(false);
  });

  test("an undressed conversation is drawn the same way every time: the generic icon and a colour from its id", async () => {
    const plain = await conversation(-30);
    const first = (await store.list(owner.id, bot)).channels.find(
      (row) => row.id === plain.id,
    );
    const second = (await store.list(owner.id, bot)).channels.find(
      (row) => row.id === plain.id,
    );
    expect(first).toMatchObject({
      icon: DEFAULT_CHANNEL_ICON,
      colour: defaultChannelColour(plain.id),
      dressed: false,
    });
    expect(second).toEqual(first);
  });

  test("a task's own conversation is never a channel, however recent", async () => {
    const task = await engine.startAsked(owner.id, bot, {
      title: "Draft a reply to Rosa",
      instruction: "Draft a reply to Rosa.",
    });
    await engine.idle();
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Here's the draft.",
      agentId: bot,
      at: new Date(Date.now() + 60 * 60_000),
    });
    const { everythingId, channels: listed } = await store.list(owner.id, bot);
    expect(listed.some((row) => row.id === task.channelId)).toBe(false);
    expect(everythingId).not.toBe(task.channelId);
    expect(await store.ofThread(owner.id, task.channelId)).toBeNull();
  });

  test("another person's channels are not listed, and cannot be changed", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    expect(
      (await store.list(other.id, bot)).channels.some(
        (row) => row.id === created.id,
      ),
    ).toBe(false);
    const response = await routesAs(other).request(
      `/api/openduet/channels/${created.id}/archive`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

describe("Archive, Unarchive and edit", () => {
  test("archive and unarchive round trip, keeping the look", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    const routes = routesAs(owner);
    const archived = (await (
      await routes.request(`/api/openduet/channels/${created.id}/archive`, {
        method: "POST",
      })
    ).json()) as { channel: ChannelRecord };
    expect(archived.channel.archivedAt).not.toBeNull();
    expect(archived.channel).toMatchObject({ icon: "home", colour: "green" });
    expect(
      (await store.list(owner.id, bot)).channels.find(
        (row) => row.id === created.id,
      )?.archivedAt,
    ).toBe(archived.channel.archivedAt);

    const back = (await (
      await routes.request(`/api/openduet/channels/${created.id}/unarchive`, {
        method: "POST",
      })
    ).json()) as { channel: ChannelRecord };
    expect(back.channel).toEqual({ ...created, archivedAt: null });
  });

  test("archiving a conversation nobody dressed keeps the colour it was drawn in", async () => {
    const plain = await conversation(-40);
    const archived = await store.setArchived(owner.id, plain.id, true);
    expect(archived).toMatchObject({
      icon: DEFAULT_CHANNEL_ICON,
      colour: defaultChannelColour(plain.id),
      dressed: true,
    });
    expect(archived.archivedAt).not.toBeNull();
  });

  test("edit changes the name, purpose and look in place", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    const response = await routesAs(owner).request(
      `/api/openduet/channels/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Studio move",
          purpose: "Everything about moving the studio.",
          icon: "plane",
          colour: "berry",
        }),
      },
    );
    expect(response.status).toBe(200);
    const { channel } = (await response.json()) as { channel: ChannelRecord };
    expect(channel).toMatchObject({
      id: created.id,
      name: "Studio move",
      purpose: "Everything about moving the studio.",
      icon: "plane",
      colour: "berry",
    });
  });

  test("Everything is not a channel to archive, edit or keep", async () => {
    const chat = await conversation(20);
    expect((await store.list(owner.id, bot)).everythingId).toBe(chat.id);
    const routes = routesAs(owner);
    for (const path of ["archive", "keep"]) {
      const response = await routes.request(
        `/api/openduet/channels/${chat.id}/${path}`,
        { method: "POST" },
      );
      expect(response.status).toBe(400);
    }
  });

  test("keep writes the default look on an undressed channel, so it stays a channel", async () => {
    const older = await conversation(-50);
    const kept = await store.keep(owner.id, older.id);
    expect(kept).toMatchObject({
      dressed: true,
      icon: DEFAULT_CHANNEL_ICON,
      colour: defaultChannelColour(older.id),
    });
    expect(await store.isChannel(owner.id, older.id)).toBe(true);
    expect(await store.isChannel(other.id, older.id)).toBe(false);
  });
});

describe("the run's channel", () => {
  test("a dressed channel's thread names it and its purpose; Everything's names nothing", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    const threadId = hellos.at(-1)?.channel.threadId ?? "";
    expect(await store.ofThread(owner.id, threadId)).toEqual({
      channelId: created.id,
      name: "Kiln move",
      purpose: kiln.purpose,
    });
    // Nobody else's run reads it.
    expect(await store.ofThread(other.id, threadId)).toBeNull();
    const chat = await channelStore.direct(owner, bot);
    expect(await store.ofThread(owner.id, chat.threadId)).toBeNull();
  });

  test("start_task in a channel tags the task with it; in Everything it stays untagged", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    let inChannel: string | null = created.id;
    const tools = createOpenDuetTools({
      database,
      callTool: async () => ({ text: "{}", isError: false }),
      complete: async () => "{}",
      model: "test-model",
      directChannel: async (ownerUserId, agentId) =>
        channelStore.direct(await actorFor(ownerUserId), agentId),
      startTask: ({ ownerUserId, agentId, task }) =>
        engine.startAsked(ownerUserId, agentId, task),
      runChannel: () => inChannel,
    })(owner.id, bot, { kind: "person" });
    const start = tools.find((tool) => tool.name === START_TASK_TOOL);
    if (!start) throw new Error(`${START_TASK_TOOL} is not held`);

    const tagged = JSON.parse(
      await start.execute({
        title: "Book the movers",
        instruction: "Book movers for the kiln.",
      }),
    ) as { taskId: string };
    inChannel = null;
    const untagged = JSON.parse(
      await start.execute({
        title: "Reply to Sam",
        instruction: "Reply to Sam.",
      }),
    ) as { taskId: string };
    await engine.idle();

    expect((await taskStore.get(owner.id, tagged.taskId)).fromChannelId).toBe(
      created.id,
    );
    expect(
      (await taskStore.get(owner.id, untagged.taskId)).fromChannelId,
    ).toBeNull();
  });

  test("add_tasks in a channel tags its cards, and Start makes a task of that channel's", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    const add = createOpenDuetTools({
      database,
      callTool: async () => ({ text: "{}", isError: false }),
      complete: async () => "{}",
      model: "test-model",
      directChannel: async (ownerUserId, agentId) =>
        channelStore.direct(await actorFor(ownerUserId), agentId),
      runChannel: () => created.id,
    })(owner.id, bot, { kind: "person" }).find(
      (tool) => tool.name === ADD_TASKS_TOOL,
    );
    if (!add) throw new Error(`${ADD_TASKS_TOOL} is not held`);
    const { added } = JSON.parse(
      await add.execute({
        tasks: [
          {
            title: "Measure the new kiln bay",
            why: "The movers need the door width.",
            next: "Measure the bay door.",
          },
        ],
      }),
    ) as { added: { id: string }[] };
    const [card] = added;
    if (!card) throw new Error("No card was added.");
    expect(
      (await proactiveStore.suggestion(owner.id, card.id)).fromChannelId,
    ).toBe(created.id);

    const { task } = await engine.start(owner.id, card.id);
    expect((await taskStore.get(owner.id, task.id)).fromChannelId).toBe(
      created.id,
    );
  });

  test("a deleted channel leaves its tasks, untagged", async () => {
    const created = await store.create(owner, { botId: bot, ...kiln });
    await store.idle();
    const task = await engine.startAsked(owner.id, bot, {
      title: "Pack the shelves",
      instruction: "Pack the shelves.",
      fromChannelId: created.id,
    });
    await engine.idle();
    await database.delete(channels).where(eq(channels.id, created.id));
    expect((await taskStore.get(owner.id, task.id)).fromChannelId).toBeNull();
  });
});

describe("the hello turn", () => {
  test("runs the framed hello as the person's turn and records only the Bot's reply", async () => {
    const channel = await channelStore.create(owner, [bot]);
    const busy: boolean[] = [];
    const recorded: { text: string; agentId: string | null }[] = [];
    const turns: { instruction: string; threadId: string }[] = [];
    const hello = createChannelHello({
      channels: {
        signalBusy: async (_threadId, on) => {
          busy.push(on);
        },
        recordActivity: async (_actor, _channelId, activity) => {
          recorded.push({ text: activity.text, agentId: activity.agentId });
        },
      },
      actorFor,
      runTurn: async (input) => {
        turns.push({
          instruction: input.instruction,
          threadId: input.threadId,
        });
        return {
          replyText:
            "Hi! Ready to help get the kiln moved by March. Want me to suggest tasks I can do here?",
        };
      },
    });
    await hello({
      ownerUserId: owner.id,
      agentId: bot,
      channel,
      hello: { name: "Kiln move", purpose: kiln.purpose },
    });
    expect(turns).toEqual([
      {
        instruction: frameChannelHello({
          name: "Kiln move",
          purpose: kiln.purpose,
        }),
        threadId: channel.threadId,
      },
    ]);
    expect(readChannelHello(turns[0]?.instruction ?? "")).toEqual({
      name: "Kiln move",
      purpose: kiln.purpose,
    });
    expect(recorded).toEqual([
      {
        text: "Hi! Ready to help get the kiln moved by March. Want me to suggest tasks I can do here?",
        agentId: bot,
      },
    ]);
    expect(busy).toEqual([true, false]);
  });
});
