import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { openduetPages } from "../src/db/schema/openduet";
import type { PageBlock } from "../src/openduet/page-content";
import {
  createPageRoutes,
  createPageStore,
  PageNotFoundError,
  type PageRecord,
  type PageSummary,
  pageTools,
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
      expectedUpdatedAt: first.updatedAt,
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
    expectedUpdatedAt: revised.updatedAt,
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
    layoutVersion: 2,
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
      expectedUpdatedAt: older.updatedAt,
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
      kind: "video" as never,
      title: "x",
      content: { blocks: [] },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(refusal).toBeTruthy();
});

test("page kinds, themes and safe thumbnails survive storage; unsafe SVG is dropped", async () => {
  const thumbnail =
    '<svg viewBox="0 0 320 180"><text x="10" y="40" fill="var(--duet-ink)">$528K</text></svg>';
  const saved = await store.save(
    owner,
    bot,
    input({
      kind: "dashboard",
      theme: "ocean",
      title: "Wholesale",
      thumbnail,
      blocks: [{ type: "text", text: "Orders grew" }],
    }),
  );
  const loaded = await store.get(owner, saved.id);
  expect(loaded.kind).toBe("dashboard");
  expect(loaded.theme).toBe("ocean");
  expect(loaded.thumbnail).toBe(thumbnail);
  const unsafe = await store.save(
    owner,
    bot,
    input({
      kind: "design",
      title: "Kiln",
      thumbnail: "<svg><foreignObject/></svg>",
      blocks: [{ type: "text", text: "Repair plan" }],
    }),
  );
  expect(unsafe.thumbnail).toBeNull();
});

test("checklist updates survive reload and concurrent tabs without overwriting other items", async () => {
  const saved = await store.save(
    owner,
    bot,
    input({
      kind: "doc",
      theme: "earth",
      title: "Kiln repair",
      blocks: [
        {
          type: "checklist",
          items: [
            { id: "coils", text: "Check coils" },
            { id: "power", text: "Check power" },
          ],
        },
      ],
    }),
  );
  const check = (item: string) =>
    routes.request(`/${saved.id}/checklist`, {
      method: "PATCH",
      headers: { "x-person": owner, "content-type": "application/json" },
      body: JSON.stringify({
        block: 0,
        item,
        checked: true,
        expectedChecklistRevision: saved.checklistRevision,
      }),
    });
  const results = await Promise.all([check("coils"), check("power")]);
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  const loaded = await createPageStore(database).get(owner, saved.id);
  expect(loaded.checklistRevision).toBe(saved.checklistRevision);
  expect("blocks" in loaded.content && loaded.content.blocks[0]).toEqual({
    type: "checklist",
    items: [
      { id: "coils", text: "Check coils", checked: true },
      { id: "power", text: "Check power", checked: true },
    ],
  });
  const forbidden = await routes.request(`/${saved.id}/checklist`, {
    method: "PATCH",
    headers: { "x-person": other, "content-type": "application/json" },
    body: JSON.stringify({
      block: 0,
      item: "coils",
      checked: false,
      expectedChecklistRevision: saved.checklistRevision,
    }),
  });
  expect(forbidden.status).toBe(404);
  const malformed = await routes.request(`/${saved.id}/checklist`, {
    method: "PATCH",
    headers: { "x-person": owner, "content-type": "application/json" },
    body: JSON.stringify({ block: -1, item: "coils", checked: true }),
  });
  expect(malformed.status).toBe(400);
});

const checklistInput = (checked: boolean) => {
  const parsed = input({
    kind: "doc",
    title: "Repair plan",
    blocks: [
      {
        type: "checklist",
        items: [
          { id: "coils", text: "Check coils", checked },
          { id: "power", text: "Check power", checked: true },
        ],
      },
    ],
  });
  if (!parsed.blocks) throw new Error("Expected checklist blocks.");
  return { ...parsed, blocks: parsed.blocks };
};
const revisionOf = (page: PageRecord) => ({
  id: page.id,
  expectedUpdatedAt: page.updatedAt,
  kind: page.kind,
  title: "Revised repair plan",
  ...page.content,
});

test.each([false, true])(
  "saved checklist revision refuses an intervening change from %s",
  async (initial) => {
    const saved = await store.save(owner, bot, checklistInput(initial));
    const snapshot = await store.get(owner, saved.id);
    // Keep the injected clock fixed: writes in one millisecond still need distinct versions.
    const checked = await store.check(owner, saved.id, {
      expectedChecklistRevision: saved.checklistRevision,
      block: 0,
      item: "coils",
      checked: !initial,
    });
    const refusal = await store.save(owner, bot, revisionOf(snapshot)).then(
      () => null,
      (error: unknown) => error,
    );
    const stored = await store.get(owner, saved.id);
    expect(stored.content).toEqual(checked.content);
    expect(stored.content).toEqual({ blocks: checklistInput(!initial).blocks });
    expect(stored.title).toBe(snapshot.title);
    expect(refusal).toMatchObject({ name: "PageRevisionConflictError" });
    expect(Date.parse(stored.updatedAt)).toBeGreaterThan(
      Date.parse(snapshot.updatedAt),
    );
  },
);

test("saved checklist revision accepts a fresh read and intentional checkbox changes", async () => {
  for (const initial of [false, true]) {
    const saved = await store.save(owner, bot, checklistInput(initial));
    const snapshot = await store.get(owner, saved.id);
    const revised = await store.save(owner, bot, revisionOf(snapshot));
    expect((await store.get(owner, saved.id)).content).toEqual(
      snapshot.content,
    );
    expect(revised.title).toBe("Revised repair plan");
    expect(Date.parse(revised.updatedAt)).toBeGreaterThan(
      Date.parse(snapshot.updatedAt),
    );
    const current = await store.get(owner, saved.id);
    await store.save(owner, bot, {
      ...checklistInput(!initial),
      id: current.id,
      expectedUpdatedAt: current.updatedAt,
    });
    expect((await store.get(owner, saved.id)).content).toEqual({
      blocks: checklistInput(!initial).blocks,
    });
  }
});

test("saved checklist revision requires a version before replacing content", async () => {
  const saved = await store.save(owner, bot, checklistInput(false));
  const refusal = await store
    .save(owner, bot, {
      ...checklistInput(true),
      id: saved.id,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect((await store.get(owner, saved.id)).content).toEqual(saved.content);
  expect(refusal).toMatchObject({ name: "PageRevisionConflictError" });
});

test("saved checklist revision tool explains a conflict and accepts a reread", async () => {
  const saved = await store.save(owner, bot, checklistInput(false));
  const tools = pageTools({
    get: (id) => store.get(owner, id),
    save: (value) => store.save(owner, bot, value),
    initiator: { kind: "person" },
  });
  const read = tools.find((tool) => tool.name === "read_page");
  const make = tools.find((tool) => tool.name === "make_page");
  if (!read || !make) throw new Error("Missing page tools");
  const snapshot = JSON.parse(
    await read.execute({ id: saved.id }),
  ) as PageRecord;
  const checked = await store.check(owner, saved.id, {
    expectedChecklistRevision: saved.checklistRevision,
    block: 0,
    item: "coils",
    checked: true,
  });
  for (const expectedUpdatedAt of [undefined, snapshot.updatedAt]) {
    const refusal = await make.execute({
      ...revisionOf(snapshot),
      expectedUpdatedAt,
    });
    expect(refusal).toStartWith("Refused.");
    expect(refusal).toContain("read_page");
    expect(refusal).toContain("expectedUpdatedAt");
    expect((await store.get(owner, saved.id)).content).toEqual(checked.content);
  }
  const current = JSON.parse(
    await read.execute({ id: saved.id }),
  ) as PageRecord;
  expect(await make.execute(revisionOf(current))).not.toStartWith("Refused.");
  const stored = await store.get(owner, saved.id);
  expect(stored.content).toEqual(checked.content);
  expect(stored.title).toBe("Revised repair plan");
});

test("delete is owner scoped and removes the page from the grid", async () => {
  const page = await store.save(
    owner,
    bot,
    input({
      kind: "design-system",
      title: "Studio",
      blocks: [{ type: "text", text: "The brand" }],
    }),
  );
  expect(
    (
      await routes.request(`/${page.id}`, {
        method: "DELETE",
        headers: { "x-person": other },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await routes.request(`/${page.id}`, {
        method: "DELETE",
        headers: { "x-person": owner },
      })
    ).status,
  ).toBe(204);
  expect((await store.list(owner)).some((row) => row.id === page.id)).toBe(
    false,
  );
  await expect(store.get(owner, page.id)).rejects.toBeInstanceOf(
    PageNotFoundError,
  );
});

for (const arrangement of ["page blocks", "slide blocks", "slides"] as const) {
  test(`checklist address revision refuses reordered ${arrangement} with duplicate item IDs`, async () => {
    const checklist = (text: string) =>
      ({
        type: "checklist",
        items: [{ id: "done", text, checked: false }],
      }) satisfies PageBlock;
    const blocks = [checklist("Inspect coils"), checklist("Order filters")];
    const content =
      arrangement === "page blocks"
        ? { blocks }
        : {
            slides:
              arrangement === "slides"
                ? blocks.map((block, index) => ({
                    title: `Step ${index + 1}`,
                    blocks: [block],
                  }))
                : [{ title: "Repair", blocks }],
          };
    const saved = await store.save(
      owner,
      bot,
      input({
        kind: arrangement === "page blocks" ? "page" : "slides",
        title: "Repair",
        ...content,
      }),
    );
    const captured = {
      block: 0,
      ...(arrangement === "page blocks" ? {} : { slide: 0 }),
      item: "done",
      checked: true,
      expectedChecklistRevision: saved.checklistRevision,
    };
    const reordered = structuredClone(saved.content);
    if ("blocks" in reordered) reordered.blocks.reverse();
    else if (arrangement === "slides") reordered.slides.reverse();
    else reordered.slides[0]?.blocks.reverse();
    const revised = await store.save(
      owner,
      bot,
      input({
        ...revisionOf(saved),
        ...reordered,
      }),
    );
    const patch = (change: typeof captured) =>
      routes.request(`/${saved.id}/checklist`, {
        method: "PATCH",
        headers: { "x-person": owner, "content-type": "application/json" },
        body: JSON.stringify(change),
      });
    const refusal = await patch(captured);
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toEqual({
      error: "This page changed. Refresh it before checking that item again.",
    });
    expect((await store.get(owner, saved.id)).content).toEqual(revised.content);
    expect(revised.checklistRevision).not.toBe(saved.checklistRevision);
    // Read the revised page, then explicitly click the intended item in its new position.
    const refreshed = (await (await as(owner, `/${saved.id}`)).json()) as {
      page: PageRecord;
    };
    for (const checked of [true, false]) {
      const result = await patch({
        ...captured,
        block: arrangement === "slides" ? 0 : 1,
        ...(arrangement === "slides" ? { slide: 1 } : {}),
        checked,
        expectedChecklistRevision: refreshed.page.checklistRevision,
      });
      expect(result.status).toBe(200);
      const updated = (await result.json()) as { page: PageRecord };
      const storedBlocks =
        "blocks" in updated.page.content
          ? updated.page.content.blocks
          : updated.page.content.slides.flatMap((slide) => slide.blocks);
      expect(storedBlocks).toEqual([
        checklist("Order filters"),
        {
          type: "checklist",
          items: [{ id: "done", text: "Inspect coils", checked }],
        },
      ]);
      expect(updated.page.checklistRevision).toBe(
        refreshed.page.checklistRevision,
      );
    }
  });
}

test("checklist address revision requires the rendered token before changing an item", async () => {
  const saved = await store.save(owner, bot, checklistInput(false));
  const refusal = await routes.request(`/${saved.id}/checklist`, {
    method: "PATCH",
    headers: { "x-person": owner, "content-type": "application/json" },
    body: JSON.stringify({ block: 0, item: "coils", checked: true }),
  });
  expect(refusal.status).toBe(409);
  expect((await store.get(owner, saved.id)).content).toEqual(saved.content);
});

for (const kind of ["page", "slides"] as const) {
  test(`checklist address revision includes unsupported persisted ${kind} blocks`, async () => {
    const saved = await store.save(owner, bot, checklistInput(false));
    const checklist = checklistInput(false).blocks[0];
    const content = (note: string) => {
      const blocks = [{ type: "future-block", note }, checklist];
      return kind === "slides"
        ? { slides: [{ title: "Repair", blocks }] }
        : { blocks };
    };
    const persist = (note: string) =>
      database
        .update(openduetPages)
        .set({
          kind,
          content: sql`${JSON.stringify(content(note))}::text::jsonb`,
        })
        .where(eq(openduetPages.id, saved.id));
    // Emulate content saved by a newer server whose block this client cannot draw.
    await persist("Original context");
    const original = await store.get(owner, saved.id);
    const target = {
      block: 1,
      ...(kind === "slides" ? { slide: 0 } : {}),
      item: "coils",
      checked: true,
      expectedChecklistRevision: original.checklistRevision,
    };
    const checked = await store.check(owner, saved.id, target);
    expect(checked.checklistRevision).toBe(original.checklistRevision);
    // This persisted fixture intentionally includes a block outside the current schema.
    const checkedBlocks: unknown[] | undefined =
      "blocks" in checked.content
        ? checked.content.blocks
        : checked.content.slides[0]?.blocks;
    expect(checkedBlocks?.[0]).toEqual({
      type: "future-block",
      note: "Original context",
    });
    // Even an unsupported block participates in the opaque token before rendering filters it.
    await persist("Changed context");
    const current = await store.get(owner, saved.id);
    expect(current.checklistRevision).not.toBe(original.checklistRevision);
    await expect(store.check(owner, saved.id, target)).rejects.toMatchObject({
      name: "ChecklistRevisionConflictError",
    });
    expect((await store.get(owner, saved.id)).content).toEqual(current.content);
  });
}

for (const kind of ["page", "slides"] as const) {
  test(`checklist address revision refuses ${kind} swaps differing only in checkbox state`, async () => {
    const checklist = (checked: boolean) =>
      ({
        type: "checklist",
        items: [{ id: "done", text: "Shared task", checked }],
      }) satisfies PageBlock;
    const content = (swapped: boolean) => {
      const blocks = [checklist(swapped), checklist(!swapped)];
      return kind === "slides"
        ? {
            slides: blocks.map((block) => ({
              title: "Repair",
              blocks: [block],
            })),
          }
        : { blocks };
    };
    const saved = await store.save(
      owner,
      bot,
      input({ kind, title: "Repair", ...content(false) }),
    );
    const revised = await store.save(
      owner,
      bot,
      input({ ...revisionOf(saved), ...content(true) }),
    );
    const refusal = await routes.request(`/${saved.id}/checklist`, {
      method: "PATCH",
      headers: { "x-person": owner, "content-type": "application/json" },
      body: JSON.stringify({
        block: 0,
        ...(kind === "slides" ? { slide: 0 } : {}),
        item: "done",
        checked: true,
        expectedChecklistRevision: saved.checklistRevision,
      }),
    });
    expect(refusal.status).toBe(409);
    expect((await store.get(owner, saved.id)).content).toEqual(revised.content);
    expect(revised.checklistRevision).not.toBe(saved.checklistRevision);
  });
}

test("checklist address revision upgrades legacy content without exposing private metadata", async () => {
  const saved = await store.save(owner, bot, checklistInput(false));
  await database
    .update(openduetPages)
    .set({ content: sql`${openduetPages.content} - '_checklistRevision'` })
    .where(eq(openduetPages.id, saved.id));
  const legacy = await store.get(owner, saved.id);
  expect(legacy.checklistRevision).toHaveLength(64);
  expect((await store.get(owner, saved.id)).checklistRevision).toBe(
    legacy.checklistRevision,
  );
  const checked = await store.check(owner, saved.id, {
    block: 0,
    item: "coils",
    checked: true,
    expectedChecklistRevision: legacy.checklistRevision,
  });
  expect(checked.checklistRevision).toBe(legacy.checklistRevision);
  const revised = await store.save(owner, bot, input(revisionOf(checked)));
  expect(revised.checklistRevision).not.toBe(legacy.checklistRevision);
  expect(revised.content).toEqual(checked.content);
  const [stored] = await database
    .select()
    .from(openduetPages)
    .where(eq(openduetPages.id, saved.id));
  expect(stored?.content._checklistRevision).toBe(revised.checklistRevision);
  expect(revised.content).not.toHaveProperty("_checklistRevision");
  const tools = pageTools({
    get: (id) => store.get(owner, id),
    save: (value) => store.save(owner, bot, value),
    initiator: { kind: "person" },
  });
  const read = tools.find((tool) => tool.name === "read_page");
  if (!read) throw new Error("Missing read_page");
  expect(await read.execute({ id: saved.id })).not.toContain(
    "_checklistRevision",
  );
  expect(
    parsePageInput({ ...revisionOf(revised), _checklistRevision: "forged" }).ok,
  ).toBe(false);
});
