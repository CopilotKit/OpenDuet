import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { workItems } from "../src/db/schema/work";
import {
  PROACTIVE_TASK_KIND,
  replyTail,
  TASK_ATTEMPTS,
} from "../src/proactive/engine";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
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
  await expect(
    proactive.create(
      owner,
      { ...settingInput, agentId: secondBot, intervalMinutes: 30 },
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

test("what the person started is listed with where it stands, its next step, and the conversation it lands in", async () => {
  const [setting] = await proactive.list(owner);
  if (!setting) throw new Error("setting missing");
  const runId = randomUUID();
  const make = (title: string) =>
    proactive.addSuggestion({
      ownerUserId: owner,
      agentId: bot,
      settingId: setting.id,
      runId,
      title,
      detail: `${title}.`,
      sourceApp: "Issue tracker",
      sourceRef: ref,
      sourceLink: null,
    });
  const titles = [
    "Queued",
    "Running",
    "Answered",
    "Asks in its reply",
    "Asked through a tool",
    "Stopped on an approval",
    "Approval decided",
    "Errored",
    "Lost once",
    "Lost twice",
    "Never queued",
    "Just started",
    "Open",
    "Hidden",
  ];
  const made = await Promise.all(titles.map(make));
  const by = Object.fromEntries(
    made.map((suggestion, index) => [titles[index] as string, suggestion]),
  );
  const id = (title: string) => {
    const found = by[title];
    if (!found) throw new Error(`${title} missing`);
    return found.id;
  };
  for (const title of titles.filter((t) => t !== "Open" && t !== "Hidden"))
    await proactive.resolveSuggestion(owner, id(title), "started");
  await proactive.resolveSuggestion(owner, id("Hidden"), "dismissed");
  // Started a few minutes ago and never queued: past the moment between starting and queueing.
  await database
    .update(proactiveSuggestions)
    .set({ resolvedAt: new Date(Date.now() - 5 * 60_000) })
    .where(eq(proactiveSuggestions.id, id("Never queued")));

  const later = new Date(Date.now() + 5 * 60_000);
  const earlier = new Date(Date.now() - 5 * 60_000);
  // Task turns run one at a time: the one that asked the question finished first after it.
  const finished = new Date(Date.now() + 60_000);
  const askerFinished = new Date(Date.now() + 1_000);
  const task = (title: string, values: Record<string, unknown> = {}) => ({
    kind: PROACTIVE_TASK_KIND,
    key: id(title),
    payload: { ownerUserId: owner, suggestionId: id(title) },
    ...values,
  });
  const pendingApproval = `${prefix}-approval-pending`;
  const decidedApproval = `${prefix}-approval-decided`;
  const questionKey = `${prefix}-question`;
  await database.insert(workItems).values([
    task("Queued"),
    task("Running", { claimedBy: "a", leaseUntil: later, attempts: 1 }),
    task("Answered", { attempts: 1, finishedAt: finished }),
    task("Asks in its reply", { attempts: 1, finishedAt: finished }),
    task("Asked through a tool", { attempts: 1, finishedAt: askerFinished }),
    task("Stopped on an approval", { attempts: 1, finishedAt: finished }),
    task("Approval decided", { attempts: 1, finishedAt: finished }),
    // Given up after an error on its first try: at the cap, with the runner's reason.
    task("Errored", { claimedBy: "a", leaseUntil: later, attempts: 1 }),
    // Its replica died mid-run; it gets one more go.
    task("Lost once", { claimedBy: "b", leaseUntil: earlier, attempts: 1 }),
    task("Lost twice", { claimedBy: "b", leaseUntil: earlier, attempts: 2 }),
    // A question it asked in its conversation while it ran, still waiting.
    {
      kind: "person.question",
      key: questionKey,
      payload: {
        actorId: owner,
        botId: bot,
        channelId: setting.channelId,
        threadId: "t",
        question: "Which box size should I quote?",
      },
    },
  ]);
  await database.insert(approvalRequests).values(
    [pendingApproval, decidedApproval].map((approvalId) => ({
      id: approvalId,
      ownerUserId: owner,
      runId: approvalId,
      toolCallId: "call",
      actionDigest: "digest",
      ...(approvalId === decidedApproval
        ? { status: "completed" as const, decision: "allow_once" as const }
        : {}),
      action: {
        actorId: owner,
        botId: bot,
        toolRef: "mail/send",
        effect: "send",
        scope: "once",
        args: {},
        runId: approvalId,
        threadId: "t",
        toolCallId: "call",
        actionDigest: "digest",
      },
    })),
  );
  await proactive.recordTaskOutcome(id("Answered"), {
    reply: "The draft is in your conversation.",
  });
  await proactive.recordTaskOutcome(id("Asks in its reply"), {
    reply: "Should I send it now?",
  });
  await proactive.recordTaskOutcome(id("Stopped on an approval"), {
    waiting: { kind: "approval", id: pendingApproval },
  });
  await proactive.recordTaskOutcome(id("Approval decided"), {
    waiting: { kind: "approval", id: decidedApproval },
  });
  await proactive.giveUpTask(
    id("Errored"),
    "a",
    "The routine's turn was stopped after 180s.",
    TASK_ATTEMPTS,
  );
  const justStarted = id("Just started");
  try {
    const { started, olderResolved } = await proactive.started(owner);
    const of = (title: string) => {
      const row = started.find((entry) => entry.id === id(title));
      return row ? { state: row.state, next: row.next } : undefined;
    };
    expect(of("Queued")).toEqual({ state: "working", next: "Just started" });
    expect(of("Running")).toEqual({ state: "working", next: "Just started" });
    expect(of("Just started")).toEqual({
      state: "working",
      next: "Just started",
    });
    expect(of("Lost once")).toEqual({
      state: "working",
      next: "Starting again",
    });
    expect(of("Answered")).toEqual({
      state: "ready_for_review",
      next: "The draft is in your conversation.",
    });
    // Ending on a question to the person is waiting on them.
    expect(of("Asks in its reply")).toEqual({
      state: "needs_input",
      next: "Should I send it now?",
    });
    expect(of("Asked through a tool")).toEqual({
      state: "needs_input",
      next: "Which box size should I quote?",
    });
    expect(of("Stopped on an approval")).toEqual({
      state: "needs_input",
      next: null,
    });
    expect(of("Approval decided")).toEqual({
      state: "ready_for_review",
      next: "You allowed what it asked to do.",
    });
    // A failure is said in plain words, never as the runner's message.
    expect(of("Errored")).toEqual({
      state: "failed",
      next: "it ran out of time",
    });
    expect(of("Lost twice")).toEqual({
      state: "failed",
      next: "it was interrupted twice",
    });
    expect(of("Never queued")).toEqual({
      state: "failed",
      next: "it never started",
    });
    // Only what was started: not what is still open, and not what was hidden.
    expect(of("Open")).toBeUndefined();
    expect(of("Hidden")).toBeUndefined();
    const waiting = started.find(
      (entry) => entry.id === id("Stopped on an approval"),
    );
    expect(waiting).toMatchObject({
      agentId: bot,
      channelId: setting.channelId,
      waitingOn: { kind: "approval", id: pendingApproval },
      resolvedAt: null,
    });
    expect(
      started.find((entry) => entry.id === id("Asked through a tool"))
        ?.waitingOn,
    ).toEqual({ kind: "question", id: questionKey });
    expect(olderResolved).toBe(0);
    expect(await proactive.started(other)).toEqual({
      started: [],
      olderResolved: 0,
    });

    // Checked off, it stays listed, marked; put back, it is active again. Older marks are counted.
    await proactive.resolveTask(owner, id("Answered"), true);
    const checked = (await proactive.started(owner)).started.find(
      (entry) => entry.id === id("Answered"),
    );
    expect(checked?.resolvedAt).toBeInstanceOf(Date);
    expect(checked?.state).toBe("ready_for_review");
    expect((await proactive.started(owner, 0)).olderResolved).toBe(1);
    expect(
      (await proactive.started(owner, 0)).started.some(
        (entry) => entry.id === id("Answered"),
      ),
    ).toBe(false);
    await proactive.resolveTask(owner, id("Answered"), false);
    expect(
      (await proactive.started(owner)).started.find(
        (entry) => entry.id === id("Answered"),
      )?.resolvedAt,
    ).toBeNull();
    await expect(
      proactive.resolveTask(other, id("Answered"), true),
    ).rejects.toBeInstanceOf(ProactiveNotFoundError);
    await expect(
      proactive.resolveTask(owner, id("Open"), true),
    ).rejects.toBeInstanceOf(ProactiveRefusedError);
    // A turn that was never queued can still be checked off.
    await proactive.resolveTask(owner, id("Never queued"), true);
    expect(
      (await proactive.started(owner)).started.find(
        (entry) => entry.id === id("Never queued"),
      )?.resolvedAt,
    ).toBeInstanceOf(Date);

    // Only a failed turn goes back on the queue.
    expect(await proactive.resetTask(id("Errored"), TASK_ATTEMPTS)).toBe(
      "reset",
    );
    expect(
      (await proactive.started(owner)).started.find(
        (entry) => entry.id === id("Errored"),
      ),
    ).toMatchObject({ state: "working", next: "Just started" });
    expect(await proactive.resetTask(id("Answered"), TASK_ATTEMPTS)).toBe(
      "busy",
    );
    expect(await proactive.resetTask(id("Lost once"), TASK_ATTEMPTS)).toBe(
      "busy",
    );
    expect(await proactive.resetTask(justStarted, TASK_ATTEMPTS)).toBe(
      "missing",
    );
  } finally {
    await database
      .delete(workItems)
      .where(
        inArray(workItems.key, [...made.map((row) => row.id), questionKey]),
      );
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.id, [pendingApproval, decidedApproval]));
  }
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
