import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import { replyEnding, replyTail } from "../src/proactive/engine";
import { proactiveInitiator } from "../src/proactive/restriction";
import { createProactiveStore } from "../src/proactive/store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
} from "../src/proactive/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `proactive-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const secondBot = `${prefix}-second-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/list_issues`;
const auditStore = createAuditStore(database);
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const proactive = createProactiveStore(database);
const memory = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store: memory, plugins });

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Research Bot", type: "built_in", configuration: {} },
    { id: secondBot, name: "Second Bot", type: "built_in", configuration: {} },
  ]);
  await database.insert(agentProfiles).values(
    [bot, secondBot].map((agentId) => ({
      agentId,
      ownerUserId: owner,
      title: agentId,
      roleDescription: "Assist",
      avatarSeed: agentId,
      visibility: "private" as const,
    })),
  );
  await database.insert(mcpServers).values({
    id: server,
    title: "Issue tracker",
    vendor: "Fixture",
    url: "https://issues.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: server,
    name: "list_issues",
    vendorName: "list_issues",
    effect: "read",
    inputSchema: {},
  });
  await plugins.grant("mcp", ref, bot, owner);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, secondBot]));
  await database.delete(mcpServers).where(eq(mcpServers.id, server));
  await database.$client.close();
});

const settingInput = {
  agentId: bot,
  channelId: `${prefix}-channel`,
  intervalMinutes: 60,
};

test("settings are owner scoped, one per Bot, and bounded in frequency", async () => {
  const setting = await proactive.create(owner, settingInput, `${prefix}-t`);
  expect(setting).toMatchObject({
    enabled: true,
    intervalMinutes: 60,
    lastStatus: "idle",
  });
  await expect(
    proactive.create(owner, settingInput, `${prefix}-t2`),
  ).rejects.toBeInstanceOf(ProactiveRefusedError);
  // Every fifteen minutes at most: a check-in reads only what is new, so it can come often.
  await expect(
    proactive.create(
      owner,
      { ...settingInput, agentId: secondBot, intervalMinutes: 14 },
      `${prefix}-t3`,
    ),
  ).rejects.toBeInstanceOf(ProactiveRefusedError);
  // The database refuses what the schema refuses, even past the parser.
  const refusal = await database
    .insert(proactiveSettings)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: secondBot,
      channelId: "c",
      threadId: "t",
      intervalMinutes: 5,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(
    (refusal as { cause?: { constraint?: string } } | null)?.cause?.constraint,
  ).toBe("proactive_settings_interval_check");
  expect((await proactive.list(other)).length).toBe(0);
  await expect(proactive.get(other, setting.id)).rejects.toBeInstanceOf(
    ProactiveNotFoundError,
  );
  await expect(
    proactive.update(other, setting.id, { enabled: false }),
  ).rejects.toBeInstanceOf(ProactiveNotFoundError);
  await expect(proactive.remove(other, setting.id)).rejects.toBeInstanceOf(
    ProactiveNotFoundError,
  );
  expect(
    (await proactive.update(owner, setting.id, { focus: "Billing" })).focus,
  ).toBe("Billing");
  // The database takes the fifteen-minute floor the parser allows.
  expect(
    (await proactive.update(owner, setting.id, { intervalMinutes: 15 }))
      .intervalMinutes,
  ).toBe(15);
  await proactive.update(owner, setting.id, { intervalMinutes: 60 });
});

test("a due setting is claimed once and its next run moves forward by its interval", async () => {
  const [setting] = await proactive.list(owner);
  if (!setting) throw new Error("setting missing");
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1000) })
    .where(eq(proactiveSettings.id, setting.id));
  const [first, second] = await Promise.all([
    proactive.claimDue(10),
    proactive.claimDue(10),
  ]);
  const claimed = [...first, ...second].filter((row) => row.id === setting.id);
  expect(claimed).toHaveLength(1);
  const next = claimed[0]?.nextRunAt.getTime() ?? 0;
  expect(next - Date.now()).toBeGreaterThan(55 * 60_000);
  expect(
    (await proactive.claimDue(10)).some((row) => row.id === setting.id),
  ).toBe(false);
  await proactive.recordRun(setting.id, "running");
  await proactive.recordRun(setting.id, "error", "x".repeat(900));
  const after = await proactive.get(owner, setting.id);
  expect(after.lastStatus).toBe("error");
  expect(after.lastRunAt).not.toBeNull();
  expect(after.lastError).toHaveLength(500);
  // A disabled setting is never claimed.
  await proactive.update(owner, setting.id, { enabled: false });
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1000) })
    .where(eq(proactiveSettings.id, setting.id));
  expect(
    (await proactive.claimDue(10)).some((row) => row.id === setting.id),
  ).toBe(false);
  await proactive.update(owner, setting.id, { enabled: true });
});

test("a run's reads come from its own successful audit rows only", async () => {
  const runId = randomUUID();
  const otherRun = randomUUID();
  await auditStore.insert({
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: ref,
    actorUserId: owner,
    initiator: proactiveInitiator(runId),
    payload: {},
  });
  await auditStore.insert({
    eventType: "mcp.call_failed",
    targetType: "mcp_tool",
    targetId: `${server}/failed`,
    actorUserId: owner,
    initiator: proactiveInitiator(runId),
    payload: {},
  });
  await auditStore.insert({
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: `${server}/elsewhere`,
    actorUserId: owner,
    initiator: proactiveInitiator(otherRun),
    payload: {},
  });
  const reads = await proactive.readsFor(runId);
  expect(reads.map((read) => read.ref)).toEqual([ref]);
  expect(reads[0]?.at).toBeInstanceOf(Date);
});

test("suggestions are delivered once, listed to their owner, and resolved once", async () => {
  const [setting] = await proactive.list(owner);
  if (!setting) throw new Error("setting missing");
  const runId = randomUUID();
  const suggestion = await proactive.addSuggestion({
    ownerUserId: owner,
    agentId: bot,
    settingId: setting.id,
    runId,
    title: "Reply to Sam",
    detail: "Sam asked for the spec.",
    sourceApp: "Issue tracker",
    sourceRef: ref,
    sourceLink: "https://issues.example.test/1",
  });
  await proactive.addSuggestion({
    ownerUserId: owner,
    agentId: bot,
    settingId: setting.id,
    runId,
    title: "Second",
    detail: "Second.",
    sourceApp: null,
    sourceRef: null,
    sourceLink: null,
  });
  expect(await proactive.countSuggestions(runId)).toBe(2);
  expect(await proactive.undelivered(runId)).toHaveLength(2);
  await proactive.markDelivered(suggestion.id);
  expect((await proactive.undelivered(runId)).map((row) => row.title)).toEqual([
    "Second",
  ]);
  expect(
    (await proactive.suggestions(owner)).some(
      (row) => row.id === suggestion.id,
    ),
  ).toBe(true);
  expect(await proactive.suggestions(other)).toEqual([]);
  await expect(
    proactive.suggestion(other, suggestion.id),
  ).rejects.toBeInstanceOf(ProactiveNotFoundError);
  await expect(
    proactive.resolveSuggestion(other, suggestion.id, "dismissed"),
  ).rejects.toBeInstanceOf(ProactiveRefusedError);
  const [started, again] = await Promise.allSettled([
    proactive.resolveSuggestion(owner, suggestion.id, "started"),
    proactive.resolveSuggestion(owner, suggestion.id, "dismissed"),
  ]);
  expect(
    [started, again].filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    (await proactive.suggestions(owner)).some(
      (row) => row.id === suggestion.id,
    ),
  ).toBe(false);
});

test("a reply's last sentence is kept as its next step, without its Markdown", () => {
  expect(
    replyTail(
      "I drafted the reply.\n\n- **Rosa:** she needs a yes.\n\nShould I send it now?",
    ),
  ).toBe("Should I send it now?");
  expect(
    replyTail("Sent. It's in her thread. Tell me if Rosa answers by Friday."),
  ).toBe("Tell me if Rosa answers by Friday.");
  // A short closing question is kept with what it asks about.
  expect(
    replyTail("I can draft a note to Shopify support.\n\nDo you want me to?"),
  ).toBe("I can draft a note to Shopify support. Do you want me to?");
  expect(replyTail("1. Check the `order` page.")).toBe("Check the order page.");
  expect(replyTail("   \n\n")).toBeNull();
  expect(replyTail(undefined)).toBeNull();
  expect(replyTail("x".repeat(500))?.length).toBe(240);
});

test("how a reply ends: its last question even before a remark, past lists and drafts, through emoji and quotes", () => {
  expect(
    replyEnding(
      "I read it. Should Sam have Friday off? If so, someone else has to finish packing. I haven't replied to Sam.",
    ),
  ).toEqual({ tail: "Should Sam have Friday off?", asks: true });
  expect(
    replyEnding("Here are the options:\n\n- Send draft A\n- Send draft B"),
  ).toEqual({ tail: "Here are the options:", asks: false });
  expect(
    replyEnding(
      "I drafted it. Want me to send it?\n\n**Draft:** Hi Leah, thanks!",
    ),
  ).toEqual({ tail: "I drafted it. Want me to send it?", asks: true });
  expect(replyEnding("Done. Shall I?")).toEqual({
    tail: "Done. Shall I?",
    asks: true,
  });
  expect(replyEnding("Should I send it (to Rosa)?)").asks).toBe(true);
  expect(replyEnding("Is this ok? 🙂")).toEqual({
    tail: "Is this ok?",
    asks: true,
  });
  expect(replyEnding('Which one: "A" or "B?"').asks).toBe(true);
  expect(
    replyEnding("Paste the key terms here and I'll go through them with you."),
  ).toEqual({
    tail: "Paste the key terms here and I'll go through them with you.",
    asks: false,
  });
});

test("Bot-formed memories carry provenance, await review, and never come back once forgotten", async () => {
  const observedAt = new Date("2026-09-01T10:00:00Z");
  const formed = await memory.formMemory(owner, {
    agentId: bot,
    content: "Owns the billing migration",
    sourceApp: "Issue tracker",
    sourceRef: ref,
    sourceLink: "https://issues.example.test/42",
    observedAt,
  });
  expect(formed.duplicate).toBe(false);
  const [row] = (await memory.list(owner)).filter(
    (entry) => entry.id === formed.id,
  );
  expect(row).toMatchObject({
    formedBy: "bot",
    formedByAgentId: bot,
    reviewState: "unreviewed",
    sourceApp: "Issue tracker",
    sourceRef: ref,
    sourceLink: "https://issues.example.test/42",
    observedAt,
    enabled: true,
  });
  expect(row?.provenance).toContain("2026-09-01T10:00:00.000Z");
  expect(
    await memory.formMemory(owner, {
      agentId: bot,
      content: "owns the billing migration",
      sourceApp: "Issue tracker",
    }),
  ).toMatchObject({ id: formed.id, duplicate: true });
  await expect(
    memory.formMemory(owner, {
      agentId: bot,
      content: "Link",
      sourceApp: "x",
      sourceLink: "javascript:alert(1)",
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  expect(
    (await memory.list(other)).some((entry) => entry.id === formed.id),
  ).toBe(false);
  // The person edits it: it stays theirs, now reviewed.
  expect(
    (await memory.update(owner, formed.id, { content: "Leads billing" }))
      .reviewState,
  ).toBe("edited");

  const forgettable = await memory.formMemory(owner, {
    agentId: bot,
    content: "Prefers async updates",
    sourceApp: "Issue tracker",
    sourceRef: ref,
  });
  await memory.remove(owner, forgettable.id);
  expect(
    await memory.formMemory(owner, {
      agentId: bot,
      content: "Prefers async updates",
      sourceApp: "Issue tracker",
      sourceRef: ref,
    }),
  ).toMatchObject({ id: forgettable.id, duplicate: true, forgotten: true });
  expect(
    (await memory.list(owner)).some((entry) => entry.id === forgettable.id),
  ).toBe(false);
});

test("a Bot-formed memory reaches only its Bot, only while it holds the source app", async () => {
  const formed = await memory.formMemory(owner, {
    agentId: bot,
    content: "Launch review is on Thursdays",
    sourceApp: "Issue tracker",
    sourceRef: ref,
  });
  const recalled = async (agentId: string) =>
    (await ingestion.recall(owner, agentId)).some(
      (row) => row.id === formed.id,
    );
  expect(await recalled(bot)).toBe(true);
  expect(await ingestion.contextFor(owner, bot)).toContain(
    "Launch review is on Thursdays",
  );
  expect(await recalled(secondBot)).toBe(false);
  expect(
    (await ingestion.recall(other, bot)).some((row) => row.id === formed.id),
  ).toBe(false);
  // Without the Bot's holdings, none are returned.
  expect(
    (await memory.retrieve(owner, [])).some((row) => row.id === formed.id),
  ).toBe(false);
  await memory.update(owner, formed.id, { enabled: false });
  expect(await recalled(bot)).toBe(false);
  await memory.update(owner, formed.id, { enabled: true });
  await plugins.revoke("mcp", ref, bot, owner);
  expect(await recalled(bot)).toBe(false);
  await plugins.grant("mcp", ref, bot, owner);
  expect(await recalled(bot)).toBe(true);
});
test("what the person hid is read back for this Bot only, and only since the window opened", async () => {
  const [setting] = await proactive.list(owner);
  if (!setting) throw new Error("setting missing");
  const hide = async (title: string, daysAgo: number) => {
    const row = await proactive.addSuggestion({
      ownerUserId: owner,
      agentId: bot,
      settingId: setting.id,
      runId: randomUUID(),
      title,
      detail: "Hidden.",
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
    });
    await proactive.resolveSuggestion(owner, row.id, "dismissed");
    await database
      .update(proactiveSuggestions)
      .set({ resolvedAt: new Date(Date.now() - daysAgo * 86_400_000) })
      .where(eq(proactiveSuggestions.id, row.id));
  };
  await hide("Renew the market stall", 2);
  await hide("Book the kiln technician", 15);
  const since = new Date(Date.now() - 14 * 86_400_000);
  // The earlier test may have hidden one of its own, so look only at these two.
  const hidden = await proactive.hiddenSince(owner, bot, since);
  expect(hidden).toContain("Renew the market stall");
  expect(hidden).not.toContain("Book the kiln technician");
  expect(await proactive.hiddenSince(owner, secondBot, since)).toEqual([]);
  expect(await proactive.hiddenSince(other, bot, since)).toEqual([]);
});
