import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { openduetPages } from "../src/db/schema/openduet";
import {
  createPageRoutes,
  createPageStore,
  PageNotFoundError,
  type PageSummary,
  parsePageInput,
} from "../src/openduet/pages";
import { createOpenDuetTools } from "../src/openduet/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `pages-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;

/** A clock the test moves by hand, so "newest first" is about the order, not the timing. */
let clock = new Date("2026-10-22T09:00:00Z");
const tick = () => {
  clock = new Date(clock.getTime() + 60_000);
  return clock;
};
const store = createPageStore(database, { now: () => clock });

/** Signs the request in as whoever the `x-person` header names, as the real guard would. */
const routes = createPageRoutes(store, async (context, next) => {
  context.set("actor", {
    id: context.req.header("x-person") ?? owner,
  } as AuthenticatedActor);
  await next();
});
const as = (person: string, path: string) =>
  routes.request(path, { headers: { "x-person": person } });

function input(value: unknown) {
  const parsed = parsePageInput(value);
  if (!parsed.ok) throw new Error(parsed.refusal);
  return parsed.value;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database
    .insert(agents)
    .values({ id: bot, name: "OpenDuet", type: "built_in", configuration: {} });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

test("the tool saves for the person running it, and a revision changes the same page in place", async () => {
  const tools = createOpenDuetTools({
    database,
    pages: store,
    directChannel: async () => ({ id: "", threadId: "" }),
    callTool: async () => ({ text: "", isError: true }),
    complete: async () => "",
    model: "test",
  })(owner, bot, { kind: "person" });
  const make = tools.find((granted) => granted.name === "make_page");
  if (!make) throw new Error("make_page is not held");

  tick();
  const made = JSON.parse(
    await make.execute({
      kind: "page",
      title: "Hearth & Co studio visit",
      blocks: [{ type: "text", text: "First draft." }],
    }),
  ) as PageSummary;
  expect(made.kind).toBe("page");
  const first = await store.get(owner, made.id);
  expect(first.botId).toBe(bot);
  expect(first.content).toEqual({
    blocks: [{ type: "text", text: "First draft." }],
  });

  tick();
  const revised = JSON.parse(
    await make.execute({
      id: made.id,
      kind: "page",
      title: "Hearth & Co studio visit",
      summary: "Now with numbers.",
      blocks: [
        { type: "text", text: "Second draft." },
        { type: "metrics", items: [{ label: "Orders", value: "42" }] },
      ],
    }),
  ) as PageSummary;
  expect(revised.id).toBe(made.id);
  expect(revised.summary).toBe("Now with numbers.");
  expect(Date.parse(revised.updatedAt)).toBeGreaterThan(
    Date.parse(made.updatedAt),
  );
  expect(revised.createdAt).toBe(made.createdAt);
  const rows = await database
    .select()
    .from(openduetPages)
    .where(inArray(openduetPages.ownerUserId, [owner]));
  expect(rows).toHaveLength(1);

  // Somebody else's Bot run cannot reach it by id.
  const theirs = createOpenDuetTools({
    database,
    pages: store,
    directChannel: async () => ({ id: "", threadId: "" }),
    callTool: async () => ({ text: "", isError: true }),
    complete: async () => "",
    model: "test",
  })(other, bot, { kind: "person" }).find(
    (granted) => granted.name === "make_page",
  );
  const refused = await theirs?.execute({
    id: made.id,
    kind: "page",
    title: "Taken over",
    blocks: [{ type: "text", text: "Mine now." }],
  });
  expect(refused).toStartWith("Refused. There is no page of yours");
  expect((await store.get(owner, made.id)).title).toBe(
    "Hearth & Co studio visit",
  );
  await database
    .delete(openduetPages)
    .where(inArray(openduetPages.id, [made.id]));
});

test("a deck keeps its slides, and its summary previews the first one", async () => {
  tick();
  const deck = await store.save(
    owner,
    bot,
    input({
      kind: "slides",
      title: "This week's orders",
      slides: [
        {
          title: "Orders by day",
          blocks: [
            {
              type: "bars",
              items: [
                { label: "Mon", value: 12 },
                { label: "Tue", value: 18 },
              ],
            },
          ],
        },
        { title: "Next week" },
      ],
    }),
  );
  expect(deck.slideCount).toBe(2);
  expect(deck.preview.title).toBe("Orders by day");
  // Stored with its chart on a later slide, a deck is listed with that slide as its preview.
  tick();
  const later = await store.save(
    owner,
    bot,
    input({
      kind: "slides",
      title: "Chart later",
      slides: [
        { title: "Cover", blocks: [{ type: "text", text: "This week." }] },
        { title: "Highlights" },
        {
          title: "Orders by day",
          blocks: [{ type: "bars", items: [{ label: "Mon", value: 12 }] }],
        },
      ],
    }),
  );
  const listed = (await (await as(owner, "/")).json()) as {
    pages: PageSummary[];
  };
  expect(listed.pages.find((page) => page.id === later.id)?.preview).toEqual({
    title: "Orders by day",
    blocks: [{ type: "bars", items: [{ label: "Mon", value: 12 }] }],
  });
  await database
    .delete(openduetPages)
    .where(inArray(openduetPages.id, [later.id]));
  expect(deck.content).toEqual({
    slides: [
      {
        title: "Orders by day",
        blocks: [
          {
            type: "bars",
            items: [
              { label: "Mon", value: 12 },
              { label: "Tue", value: 18 },
            ],
          },
        ],
      },
      { title: "Next week", blocks: [] },
    ],
  });
  await database
    .delete(openduetPages)
    .where(inArray(openduetPages.id, [deck.id]));
});

test("the routes list only the person's own pages, newest change first, and 404 anyone else's", async () => {
  tick();
  const older = await store.save(
    owner,
    bot,
    input({
      kind: "page",
      title: "Older",
      blocks: [{ type: "text", text: "a" }],
    }),
  );
  tick();
  const newer = await store.save(
    owner,
    bot,
    input({
      kind: "page",
      title: "Newer",
      blocks: [{ type: "text", text: "b" }],
    }),
  );
  tick();
  const theirs = await store.save(
    other,
    bot,
    input({
      kind: "page",
      title: "Theirs",
      blocks: [{ type: "text", text: "c" }],
    }),
  );

  let listed = (await (await as(owner, "/")).json()) as {
    pages: PageSummary[];
  };
  expect(listed.pages.map((page) => page.title)).toEqual(["Newer", "Older"]);
  // A summary carries no content beyond the preview.
  expect("content" in (listed.pages[0] ?? {})).toBe(false);

  // Revising the older one moves it to the top.
  tick();
  await store.save(
    owner,
    bot,
    input({
      id: older.id,
      kind: "page",
      title: "Older, revised",
      blocks: [{ type: "text", text: "a2" }],
    }),
  );
  listed = (await (await as(owner, "/")).json()) as { pages: PageSummary[] };
  expect(listed.pages.map((page) => page.title)).toEqual([
    "Older, revised",
    "Newer",
  ]);

  const one = await as(owner, `/${newer.id}`);
  expect(one.status).toBe(200);
  expect(
    ((await one.json()) as { page: { content: unknown } }).page.content,
  ).toEqual({
    blocks: [{ type: "text", text: "b" }],
  });

  const notMine = await as(owner, `/${theirs.id}`);
  expect(notMine.status).toBe(404);
  expect(await notMine.json()).toEqual({ error: "Couldn't find that page." });
  expect((await as(owner, "/no-such-page")).status).toBe(404);
  await expect(store.get(owner, theirs.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );

  const theirList = (await (await as(other, "/")).json()) as {
    pages: PageSummary[];
  };
  expect(theirList.pages.map((page) => page.title)).toEqual(["Theirs"]);

  await database
    .delete(openduetPages)
    .where(inArray(openduetPages.id, [older.id, newer.id, theirs.id]));
});

test("the table refuses a kind the app cannot draw, past the parser", async () => {
  const refusal = await database
    .insert(openduetPages)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      botId: bot,
      kind: "doc" as never,
      title: "x",
      content: { blocks: [] },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(refusal).toBeTruthy();
});
