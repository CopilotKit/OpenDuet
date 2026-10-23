import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { OFFER_TASK_TOOL } from "../src/openduet/offers";
import { createOpenDuetTools } from "../src/openduet/wiring";
import type { ProactiveEngine } from "../src/proactive/engine";
import { createProactiveRoutes } from "../src/proactive/routes";
import { createProactiveStore } from "../src/proactive/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * `offer_task` reads one of the person's own suggestions for the card a check-in ends on, and
 * nothing of anybody else's: another person's id is answered exactly as an id that does not exist.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-offers-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const proactive = createProactiveStore(database);

const tools = createOpenDuetTools({
  database,
  callTool: async () => ({ text: "{}", isError: false }),
  complete: async () => "{}",
  model: "test-model",
  directChannel: async () => ({
    id: `${prefix}-channel`,
    threadId: `${prefix}-thread`,
  }),
});

function offerTask(actor: string) {
  const found = tools(actor, bot, { kind: "person" }).find(
    (tool) => tool.name === OFFER_TASK_TOOL,
  );
  if (!found) throw new Error(`${OFFER_TASK_TOOL} is not offered`);
  return found;
}

let mine = "";
let theirs = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database
    .insert(agents)
    .values({ id: bot, name: "OpenDuet", type: "built_in", configuration: {} });
  for (const [person, title] of [
    [owner, "Send Priya replacement mugs today"],
    [other, "Pay the studio rent"],
  ] as const) {
    const setting = await proactive.create(
      person,
      { agentId: bot, channelId: `${prefix}-${person}-channel` },
      `${prefix}-${person}-thread`,
    );
    const row = await proactive.addSuggestion({
      ownerUserId: person,
      agentId: bot,
      settingId: setting.id,
      runId: `${prefix}-run`,
      title,
      detail: "Two of the six mugs arrived in pieces.\n\nNext: Reply to Priya.",
      sourceApp: "Gmail",
      sourceRef: "google-workspace/gmail_search_messages",
      sourceLink: null,
    });
    if (person === owner) mine = row.id;
    else theirs = row.id;
  }
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

test("offers the person's own suggestion with its title, why, source and status", async () => {
  const result = JSON.parse(
    await offerTask(owner).execute({ suggestionId: mine }),
  );
  expect(result).toMatchObject({
    id: mine,
    title: "Send Priya replacement mugs today",
    detail: "Two of the six mugs arrived in pieces.\n\nNext: Reply to Priya.",
    source: "Gmail",
    status: "open",
  });
});

test("refuses another person's suggestion exactly as one that does not exist", async () => {
  const theirsAnswer = await offerTask(owner).execute({ suggestionId: theirs });
  const missingAnswer = await offerTask(owner).execute({
    suggestionId: `${prefix}-missing`,
  });
  expect(theirsAnswer).toStartWith("Refused.");
  expect(theirsAnswer).toBe(missingAnswer);
  expect(theirsAnswer).not.toContain("Pay the studio rent");
  expect(await offerTask(owner).execute({})).toStartWith("Refused.");
});

test("says what became of a suggestion once it was started or hidden", async () => {
  await proactive.resolveSuggestion(owner, mine, "started");
  expect(
    JSON.parse(await offerTask(owner).execute({ suggestionId: mine })).status,
  ).toBe("started");
  // The route a card reads to draw Started or Hidden is scoped the same way.
  const app = new Hono<{ Variables: AppVariables }>();
  let actor = owner;
  app.route(
    "/api/proactive",
    createProactiveRoutes(proactive, {} as ProactiveEngine, async (c, next) => {
      c.set("actor", { id: actor } as AppVariables["actor"]);
      await next();
    }),
  );
  const read = (id: string) => app.request(`/api/proactive/suggestions/${id}`);
  const own = await read(mine);
  expect(own.status).toBe(200);
  expect(
    ((await own.json()) as { suggestion: { status: string } }).suggestion
      .status,
  ).toBe("started");
  expect((await read(theirs)).status).toBe(404);
  actor = other;
  expect((await read(mine)).status).toBe(404);
});
