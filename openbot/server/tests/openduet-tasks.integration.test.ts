import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { ADD_TASKS_TOOL } from "../src/openduet/tasks";
import { createOpenDuetTools } from "../src/openduet/wiring";
import { createProactiveStore } from "../src/proactive/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A task asked for in a conversation lands where the Tasks tab reads: an open suggestion of the
 * person's, under a research setting for the Bot that says where Start runs it. Nothing here turns
 * background research on.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-tasks-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const researched = `${prefix}-researched`;
const proactive = createProactiveStore(database);
const directAsked: string[] = [];

const tools = createOpenDuetTools({
  database,
  callTool: async () => ({ text: "{}", isError: false }),
  complete: async () => "{}",
  model: "test-model",
  directChannel: async (ownerUserId, agentId) => {
    directAsked.push(`${ownerUserId}:${agentId}`);
    return { id: `${prefix}-direct-${agentId}`, threadId: `${prefix}-thread` };
  },
});

function addTasks(actor: string, agentId: string) {
  const found = tools(actor, agentId, { kind: "person" }).find(
    (tool) => tool.name === ADD_TASKS_TOOL,
  );
  if (!found) throw new Error(`${ADD_TASKS_TOOL} is not offered`);
  return found;
}

const SECURITY = {
  title: "Triage the order-form vulnerability report",
  why: "A researcher will publish in 7 days unless they hear it is being fixed.",
  next: "Reply to Ravi that it is being fixed, then patch the wholesale form.",
  source: "Gmail",
  link: "https://mail.google.com/mail/u/0/#inbox/n26",
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "OpenDuet", type: "built_in", configuration: {} },
    { id: researched, name: "Researcher", type: "built_in", configuration: {} },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, researched]));
  await database.$client.close();
});

test("asked-for tasks become open cards on the Tasks tab, with research left off", async () => {
  const result = JSON.parse(
    await addTasks(owner, bot).execute({
      tasks: [
        SECURITY,
        {
          title: "Answer Sam about Friday off",
          why: "Sam needs an answer today to book a train.",
          next: "Reply yes or no in his thread.",
        },
      ],
    }),
  );
  expect(result.added).toHaveLength(2);

  const cards = (await proactive.suggestions(owner)).filter(
    (card) => card.agentId === bot,
  );
  expect(cards.map((card) => card.title).sort()).toEqual(
    ["Answer Sam about Friday off", SECURITY.title].sort(),
  );
  const security = cards.find((card) => card.title === SECURITY.title);
  expect(security).toMatchObject({
    status: "open",
    sourceApp: "Gmail",
    sourceLink: SECURITY.link,
    detail: `${SECURITY.why}\n\nNext: ${SECURITY.next}`,
  });
  expect(security?.runId).toStartWith("asked:");

  // Start runs a card in its setting's conversation: the person's own one with the Bot.
  const [setting] = (await proactive.list(owner)).filter(
    (row) => row.agentId === bot,
  );
  expect(setting).toMatchObject({
    enabled: false,
    channelId: `${prefix}-direct-${bot}`,
    threadId: `${prefix}-thread`,
  });
  expect(directAsked).toEqual([`${owner}:${bot}`]);

  // Nobody else sees them.
  expect(await proactive.suggestions(other)).toEqual([]);
});

test("a second request reuses the setting rather than making another", async () => {
  await addTasks(owner, bot).execute({ tasks: [SECURITY] });
  expect(
    (await proactive.list(owner)).filter((row) => row.agentId === bot),
  ).toHaveLength(1);
  expect(directAsked).toEqual([`${owner}:${bot}`]);
});

test("where research is already on, the cards join it and it stays on", async () => {
  const setting = await proactive.create(
    owner,
    { agentId: researched, channelId: `${prefix}-research-channel` },
    `${prefix}-research-thread`,
  );
  await addTasks(owner, researched).execute({ tasks: [SECURITY] });
  const cards = (await proactive.suggestions(owner)).filter(
    (card) => card.agentId === researched,
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]?.settingId).toBe(setting.id);
  expect(
    (await proactive.list(owner)).find((row) => row.id === setting.id)?.enabled,
  ).toBe(true);
  expect(directAsked).not.toContain(`${owner}:${researched}`);
});
