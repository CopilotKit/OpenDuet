import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { channels, intelligenceChannelMappings } from "../src/db/schema/core";
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
  replyEnding,
  replyTail,
  TASK_ATTEMPTS,
} from "../src/proactive/engine";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import { proactiveInitiator } from "../src/proactive/restriction";
import {
  createProactiveStore,
  recordQuestionContinuation,
  recordTaskContinuation,
} from "../src/proactive/store";
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
    "Approval carried out",
    "Decision gave up",
    "Answer gave up",
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
  const runningApproval = `${prefix}-approval-running`;
  const stuckApproval = `${prefix}-approval-stuck`;
  const stalledQuestion = `${prefix}-question-stalled`;
  const questionKey = `${prefix}-question`;
  await database.insert(workItems).values([
    task("Queued"),
    task("Running", { claimedBy: "a", leaseUntil: later, attempts: 1 }),
    task("Answered", { attempts: 1, finishedAt: finished }),
    task("Asks in its reply", { attempts: 1, finishedAt: finished }),
    task("Asked through a tool", { attempts: 1, finishedAt: askerFinished }),
    task("Stopped on an approval", { attempts: 1, finishedAt: finished }),
    task("Approval decided", { attempts: 1, finishedAt: finished }),
    task("Approval carried out", { attempts: 1, finishedAt: finished }),
    task("Decision gave up", { attempts: 1, finishedAt: finished }),
    task("Answer gave up", { attempts: 1, finishedAt: finished }),
    // The question it stopped on, answered; carrying the answer on failed on its one try.
    {
      kind: "person.question",
      key: stalledQuestion,
      finishedAt: new Date(),
      payload: {
        actorId: owner,
        botId: bot,
        channelId: setting.channelId,
        threadId: "t",
        question: "Shall I tell Ana?",
      },
    },
    {
      kind: "person.response",
      key: stalledQuestion,
      attempts: 1,
      lastError:
        "Waiting for permission to share private information with google-workspace: ana@hearth.example. Nothing was sent.",
      payload: { ownerUserId: owner, response: "Yes." },
    },
    // Carrying that decision out failed at every try, and stopped being offered.
    {
      kind: "approval.resume",
      key: stuckApproval,
      attempts: 5,
      lastError:
        "Waiting for permission to share private information with google-workspace: rosa@clayworks.example. Nothing was sent.",
    },
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
    [pendingApproval, decidedApproval, runningApproval, stuckApproval].map(
      (approvalId) => ({
        id: approvalId,
        ownerUserId: owner,
        runId: approvalId,
        toolCallId: "call",
        actionDigest: "digest",
        ...(approvalId === decidedApproval
          ? { status: "completed" as const, decision: "allow_once" as const }
          : approvalId === runningApproval || approvalId === stuckApproval
            ? { status: "approved" as const, decision: "allow_once" as const }
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
      }),
    ),
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
  await proactive.recordTaskOutcome(id("Approval carried out"), {
    waiting: { kind: "approval", id: runningApproval },
  });
  await proactive.recordTaskOutcome(id("Decision gave up"), {
    waiting: { kind: "approval", id: stuckApproval },
  });
  await proactive.recordTaskOutcome(id("Answer gave up"), {
    waiting: { kind: "person_question", id: stalledQuestion },
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
      next: "Just started",
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
    // Decided and being carried out: working until the conversation replies, with no stock phrase.
    expect(of("Approval carried out")).toEqual({
      state: "working",
      next: null,
    });
    // A decision that could not be carried out never reads Working for good, and can't be retried.
    expect(of("Decision gave up")).toEqual({
      state: "failed",
      next: "it needed another approval to carry on",
    });
    expect(
      started.find((entry) => entry.id === id("Decision gave up"))?.canRetry,
    ).toBe(false);
    // Nor does an answer that could not be carried on.
    expect(of("Answer gave up")).toEqual({
      state: "failed",
      next: "it needed another approval to carry on",
    });
    expect(started.find((entry) => entry.id === id("Errored"))?.canRetry).toBe(
      true,
    );
    // Carried out, with nothing to say yet: no stock phrase either.
    expect(of("Approval decided")).toEqual({
      state: "ready_for_review",
      next: null,
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

    // Answered on its card: working on the answer while it is carried on, then where its reply
    // leaves it.
    const card = async () => {
      const row = (await proactive.started(owner)).started.find(
        (entry) => entry.id === id("Asked through a tool"),
      );
      return { state: row?.state, next: row?.next };
    };
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(
          eq(workItems.kind, "person.question"),
          eq(workItems.key, questionKey),
        ),
      );
    await database.insert(workItems).values({
      kind: "person.response",
      key: questionKey,
      payload: { ownerUserId: owner, response: "The large box." },
    });
    expect(await card()).toEqual({
      state: "working",
      next: "“The large box.”",
    });
    await recordQuestionContinuation(database, {
      ownerUserId: owner,
      questionKey,
      replyText: "Quoted the large box to Ana. Anything else?",
    });
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(
          eq(workItems.kind, "person.response"),
          eq(workItems.key, questionKey),
        ),
      );
    expect(await card()).toEqual({
      state: "needs_input",
      next: "Quoted the large box to Ana. Anything else?",
    });
  } finally {
    await database
      .delete(workItems)
      .where(
        inArray(workItems.key, [
          ...made.map((row) => row.id),
          questionKey,
          stuckApproval,
          stalledQuestion,
        ]),
      );
    await database
      .delete(approvalRequests)
      .where(
        inArray(approvalRequests.id, [
          pendingApproval,
          decidedApproval,
          runningApproval,
          stuckApproval,
        ]),
      );
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

test("a task the person answers in its conversation works on their answer, then stands where the reply leaves it", async () => {
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
      sourceApp: null,
      sourceRef: null,
      sourceLink: null,
    });
  const [asks, said, waits] = await Promise.all(
    ["Asks the person", "Said its piece", "Waits on an approval"].map(make),
  );
  if (!asks || !said || !waits) throw new Error("suggestions missing");
  for (const suggestion of [asks, said, waits])
    await proactive.resolveSuggestion(owner, suggestion.id, "started");
  const at = (seconds: number) => new Date(Date.now() + seconds * 1_000);
  const followUp = `${prefix}-follow-up`;
  const nextApproval = `${prefix}-next-approval`;
  const stopped = `${prefix}-stopped`;
  await database.insert(workItems).values(
    [
      [said, at(-60)],
      [asks, at(-30)],
      [waits, at(-90)],
    ].map(([suggestion, finishedAt]) => ({
      kind: PROACTIVE_TASK_KIND,
      key: (suggestion as { id: string }).id,
      payload: {
        ownerUserId: owner,
        suggestionId: (suggestion as { id: string }).id,
      },
      attempts: 1,
      finishedAt: finishedAt as Date,
    })),
  );
  await proactive.recordTaskOutcome(said.id, {
    reply: "The draft is in your conversation.",
    asks: false,
  });
  await proactive.recordTaskOutcome(asks.id, {
    reply: "Do you want me to ask him, or add this to your tasks?",
    asks: true,
  });
  await proactive.recordTaskOutcome(waits.id, {
    waiting: { kind: "approval", id: stopped },
  });
  const stateOf = async (suggestionId: string) => {
    const row = (await proactive.started(owner)).started.find(
      (entry) => entry.id === suggestionId,
    );
    return (
      row && { state: row.state, next: row.next, waitingOn: row.waitingOn }
    );
  };
  try {
    expect((await stateOf(asks.id))?.state).toBe("needs_input");
    // The person answers in the conversation: the task that last asked them works on it.
    await proactive.noteConversation(owner, setting.channelId, {
      text: "Ask him, please.",
      agentId: null,
      at: at(-20),
    });
    expect(await stateOf(asks.id)).toEqual({
      state: "working",
      next: "“Ask him, please.”",
      waitingOn: null,
    });
    // A task that didn't ask, and one waiting on its approval card, are not answered by words.
    expect((await stateOf(said.id))?.state).toBe("ready_for_review");
    // The turn their answer started asks for an approval: that is the same task's, counted once.
    await database.insert(approvalRequests).values({
      id: followUp,
      ownerUserId: owner,
      runId: followUp,
      toolCallId: "call",
      actionDigest: "digest",
      action: {
        actorId: owner,
        botId: bot,
        toolRef: "mail/send",
        effect: "send",
        scope: "dev@kilnworks.example",
        args: {},
        runId: followUp,
        threadId: `${prefix}-thread`,
        toolCallId: "call",
        actionDigest: "digest",
      },
    });
    await database
      .insert(channels)
      .values({
        id: setting.channelId,
        name: "OpenDuet",
        description: "",
      })
      .onConflictDoNothing();
    await database.insert(intelligenceChannelMappings).values({
      userId: owner,
      channelId: setting.channelId,
      threadId: `${prefix}-thread`,
    });
    expect(await stateOf(asks.id)).toEqual({
      state: "needs_input",
      next: null,
      waitingOn: { kind: "approval", id: followUp },
    });
    // Decided: working while the decision is carried out.
    await database
      .update(approvalRequests)
      .set({ status: "denied", decision: "deny" })
      .where(eq(approvalRequests.id, followUp));
    expect(await stateOf(asks.id)).toEqual({
      state: "working",
      next: null,
      waitingOn: null,
    });
    // Carried out: the reply it continued with is where the task now stands.
    await recordTaskContinuation(database, {
      ownerUserId: owner,
      approvalId: followUp,
      channelId: setting.channelId,
      askedAt: at(-10),
      replyText:
        "Nothing was sent to Dev. Who should I ask instead, you or the vendor?",
    });
    await database
      .update(approvalRequests)
      .set({ status: "completed" })
      .where(eq(approvalRequests.id, followUp));
    expect(await stateOf(asks.id)).toEqual({
      state: "needs_input",
      next: "Who should I ask instead, you or the vendor?",
      waitingOn: null,
    });
    // Answered again, and the browser's reply settles it.
    await proactive.noteConversation(owner, setting.channelId, {
      text: "The vendor.",
      agentId: null,
      at: at(1),
    });
    expect((await stateOf(asks.id))?.state).toBe("working");
    await proactive.noteConversation(owner, setting.channelId, {
      text: "I emailed the vendor. I'll tell you when they answer.",
      agentId: bot,
      at: at(2),
    });
    expect(await stateOf(asks.id)).toEqual({
      state: "ready_for_review",
      next: "I'll tell you when they answer.",
      waitingOn: null,
    });
    // A decision on the approval a task stopped on: it takes the continuation's reply.
    await recordTaskContinuation(database, {
      ownerUserId: owner,
      approvalId: stopped,
      channelId: setting.channelId,
      askedAt: at(-100),
      replyText: "Sent to Ana. Anything else for her?",
    });
    expect(await stateOf(waits.id)).toEqual({
      state: "needs_input",
      next: "Anything else for her?",
      waitingOn: null,
    });
    // An answer whose reply never came (the browser closed mid-turn) stops counting after a while.
    await database
      .update(workItems)
      .set({
        payload: sql`${workItems.payload} || jsonb_build_object('reply', 'Shall I send it?'::text, 'asks', true, 'answeredAt', ${new Date(Date.now() - 6 * 60_000).toISOString()}::text, 'answer', 'Yes.'::text)`,
      })
      .where(eq(workItems.key, said.id));
    expect(await stateOf(said.id)).toEqual({
      state: "needs_input",
      next: "Shall I send it?",
      waitingOn: null,
    });
    // Carried on, then stopped on another approval: the task now waits on that one.
    await proactive.recordTaskOutcome(waits.id, {
      waiting: { kind: "approval", id: stopped },
    });
    await database.insert(approvalRequests).values({
      id: nextApproval,
      ownerUserId: owner,
      runId: nextApproval,
      toolCallId: "call",
      actionDigest: "digest",
      action: {
        actorId: owner,
        botId: bot,
        toolRef: "mail/send",
        effect: "send",
        scope: "rosa@clayworks.example",
        args: {},
        runId: nextApproval,
        threadId: `${prefix}-thread`,
        toolCallId: "call",
        actionDigest: "digest",
      },
    });
    await recordTaskContinuation(database, {
      ownerUserId: owner,
      approvalId: stopped,
      channelId: setting.channelId,
      askedAt: at(-100),
      replyText: null,
      stoppedOn: { kind: "approval", id: nextApproval },
    });
    const waiting = await stateOf(waits.id);
    expect(waiting?.state).toBe("needs_input");
    expect(waiting?.waitingOn).toEqual({ kind: "approval", id: nextApproval });
  } finally {
    await database
      .delete(workItems)
      .where(inArray(workItems.key, [asks.id, said.id, waits.id]));
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.id, [followUp, nextApproval]));
    await database.delete(channels).where(eq(channels.id, setting.channelId));
  }
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
