import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "@openbot/toolkit/continuation";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type FakeGoogle,
  startFakeGoogle,
} from "../../scripts/fake-google/server";
import { createApprovedActionExecutor } from "../src/approvals/execute";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import {
  createApprovalService,
  isApprovalRecheck,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalAction } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalRequests,
  approvalRules,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { callTool as callGoogle } from "../src/plugins/google-workspace-rest";
import { createPluginStore } from "../src/plugins/store";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "../src/proactive/private-share";
import type { WorkQueue } from "../src/work/queue";
import { testDatabaseUrl } from "./support/database";

/**
 * An approved action is carried out at most once, however many times its conversation is carried
 * on, and a step that asked twice cannot loop.
 *
 * The incident this reproduces: one turn replied to Sam twice in one step, which raised two
 * permission cards. Allow once on the first carried the conversation on without the second; the
 * Bot made the second send again, stopped on a new card, and the sweep took that stop for a failure
 * and retried, sending the first reply on every try. Fake Google ended up holding twelve copies.
 *
 * Real approval store, service, private-share check, plugin store and resume sweep, on a real
 * database, with the real Gmail adapter talking to the fake Google. The Bot is the one stand-in: it
 * does what the continuation tells it, sending again the calls it is told to send again.
 */

/** Two sends at once, each holding a transaction while its checks read: more than the usual two. */
const database = createDatabase(testDatabaseUrl(), { max: 6 });
const suite = randomUUID().slice(0, 8);
const owner = `user_send_once_${suite}`;
const botId = `agent_send_once_${suite}`;
const serverId = "google-workspace";
const TOOLS = ["gmail_search_messages", "gmail_send_reply"];
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT = { clientId: "fake-client", clientSecret: "fake-secret" };
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const SEND = "mcp__google-workspace__gmail_send_reply";

let fake: FakeGoogle;
const credentialIds: string[] = [];
let serverWasAlreadyThere = false;
let clientBefore: string | null = null;

const approvals = createApprovalStore(database);
const service = createApprovalService(approvals, undefined, undefined, {
  review: async () =>
    JSON.stringify({
      verdict: "proceed",
      preApproved: true,
      safety: "none",
      reason: "Test reviewer.",
    }),
});
const store = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvalGate: (candidate) => service.gate(candidate),
  privateShareCheck: createPrivateShareCheck({ approvals }),
  exchangeRefreshToken: async ({ refreshToken: presented }) => {
    const response = await fetch(`${fake.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: presented,
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      }),
    });
    const body = (await response.json()) as { access_token: string };
    return { accessToken: body.access_token };
  },
  callVendor: (connection, toolName, args) =>
    callGoogle(
      { url: fake.url, token: connection.token ?? "" },
      toolName,
      args,
    ),
});

/** Every approved action really carried out, not the re-check that only asks the gate. */
const carriedOut: string[] = [];
const executor = createApprovedActionExecutor({
  sourceFor: async () => ({}),
  gate: (candidate) => service.gate(candidate),
  computerTools: async () => [],
  hostTools: () => [],
  callTool: async () => {
    throw new Error("A share is carried out by the Bot's own send.");
  },
  credentialActorFor: async (actorId) => actorId,
  coordinationCall: async () => null,
  answer: (result) => result.text,
  privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
  refusalMarker: "Refused:",
  personInitiator: { kind: "person" },
});
const executeApprovedAction = async (action: ApprovalAction) => {
  if (!isApprovalRecheck()) carriedOut.push(action.toolCallId);
  return executor(action);
};

const send = (args: Record<string, unknown>) =>
  store.callTool({
    ref: `${serverId}/gmail_send_reply`,
    args,
    botId,
    actorId: owner,
    initiator: { kind: "person" },
  });

/** What the Bot heard back from each send it made in a continuation, in order. */
let heard: string[] = [];
/** How many continuations ran, and how many of the next ones fail after the Bot has acted. */
let runs = 0;
let failAfterSending = 0;
/** A Bot that ignores what it is told and sends every call of the step again. */
let resendsEverything = false;

/**
 * The Bot, carried on from a snapshot: every call of the step it is told to send again, it sends
 * again with the same arguments, in a run of its own. A send stopped on a decision stops the run.
 */
const bot: TurnRunner = async ({ continuation }) => {
  runs += 1;
  if (!continuation) throw new Error("Only continuations run here.");
  const { snapshot, result } = continuation;
  const answers = new Map<string, string>();
  for (const message of snapshot.messages)
    if (message.role === "tool")
      answers.set(message.toolCallId, String(message.content));
  answers.set(snapshot.toolCallId, result.content);
  const step = snapshot.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === snapshot.toolCallId),
  );
  const calls = step?.role === "assistant" ? (step.toolCalls ?? []) : [];
  const again = calls.filter(
    (call) =>
      resendsEverything ||
      answers.get(call.id)?.includes("make the same call now, unchanged"),
  );
  const runId = randomUUID();
  const sent = await Promise.allSettled(
    again.map((call) => {
      const args = JSON.parse(call.function.arguments) as Record<
        string,
        unknown
      >;
      return withApprovalContext(
        { ...snapshot, runId, toolCallId: randomUUID(), toolName: SEND, args },
        () => send(args),
      );
    }),
  );
  for (const outcome of sent) {
    if (outcome.status === "fulfilled") heard.push(outcome.value.text);
    else heard.push(String((outcome.reason as Error).message));
  }
  const stopped = sent.find(
    (outcome) =>
      outcome.status === "rejected" &&
      outcome.reason instanceof HeadlessToolSuspension,
  );
  if (stopped?.status === "rejected") throw stopped.reason;
  if (failAfterSending > 0) {
    failAfterSending -= 1;
    // A failure after the Bot has acted: the lease lost, or the server stopped mid-turn.
    throw new Error("The headless turn was cancelled.");
  }
  return { replyText: "Done." };
};

/** The sweep, handed this one decision's work item, as the queue would after a decision. */
const sweep = { attempts: new Map<string, number>(), finished: new Set() };
async function carryOn(approvalId: string) {
  const queue = {
    claim: async () => {
      if (sweep.finished.has(approvalId)) return [];
      const attempts = (sweep.attempts.get(approvalId) ?? 0) + 1;
      sweep.attempts.set(approvalId, attempts);
      return [
        {
          kind: "approval.resume",
          key: approvalId,
          payload: { ownerUserId: owner, approvalId },
          attempts,
        },
      ];
    },
    finish: async () => {
      sweep.finished.add(approvalId);
      return true;
    },
    release: async () => true,
  } as unknown as WorkQueue;
  await createApprovalResumeTick({
    approvalQueue: queue,
    approvalOwner: "replica",
    approvalService: service,
    executeApprovedAction,
    database,
    responsibilityStore: {} as never,
    groupConversations: { continueWaiting: (_id, run) => run() },
    approvalContinuationRunner: bot,
    channelStore: { recordActivity: async () => undefined } as never,
    actorFor: async () => ({ id: owner }) as never,
    notify: async () => undefined,
  })();
}

/** Sam's two questions, which the Bot answers in one step. */
const sam: Record<"boxes" | "friday", { id: string; threadId: string }> = {
  boxes: { id: "", threadId: "" },
  friday: { id: "", threadId: "" },
};
const replies = {
  boxes: "Hi Sam,\n\nPlease use the double-wall boxes.\n\nMaya",
  friday: "Hi Sam,\n\nYes, you can take Friday off. Enjoy the trip.\n\nMaya",
};
const replyArgs = (which: "boxes" | "friday") => ({
  threadId: sam[which].threadId,
  inReplyTo: sam[which].id,
  to: ["Sam Ruiz <sam@marlowceramics.com>"],
  subject:
    which === "boxes"
      ? "Re: Which box for the Hearth order?"
      : "Re: Friday off?",
  body: replies[which],
});

/** One turn, one step, two sends to Sam: both stop on the person, two cards. */
async function stepThatAsksTwice() {
  const threadId = `thread-${randomUUID()}`;
  const runId = randomUUID();
  const ids = {
    boxes: `toolu_boxes_${suite}`,
    friday: `toolu_friday_${suite}`,
  };
  const step: Message = {
    id: `step-${runId}`,
    role: "assistant",
    content: "",
    toolCalls: (["boxes", "friday"] as const).map((which) => ({
      id: `${ids[which]}_${runId.slice(0, 6)}`,
      type: "function" as const,
      function: { name: SEND, arguments: JSON.stringify(replyArgs(which)) },
    })),
  };
  const messages: Message[] = [
    {
      id: `ask-${runId}`,
      role: "user",
      content: "Reply to Sam: double-wall boxes, and yes, take Friday off.",
    },
    step,
  ];
  const stops = await Promise.allSettled(
    (step.role === "assistant" ? (step.toolCalls ?? []) : []).map((call) => {
      const args = JSON.parse(call.function.arguments) as Record<
        string,
        unknown
      >;
      const snapshot: ApprovalContinuation = {
        runId,
        threadId,
        toolCallId: call.id,
        toolName: SEND,
        args,
        messages,
        state: {},
        context: [],
        forwardedProps: {},
        initiator: { kind: "person" },
      };
      return withApprovalContext(snapshot, () => send(args));
    }),
  );
  for (const stop of stops) {
    expect(stop.status).toBe("rejected");
    if (stop.status === "rejected")
      expect(stop.reason).toBeInstanceOf(HeadlessToolSuspension);
  }
  const asked = (await approvals.list(owner)).filter(
    (request) => request.action.runId === runId,
  );
  const card = (which: "boxes" | "friday") => {
    const found = asked.find((request) =>
      String((request.action.args as { body?: unknown }).body).includes(
        which === "boxes" ? "double-wall" : "Friday off",
      ),
    );
    if (!found) throw new Error(`no card for the ${which} reply`);
    return found;
  };
  expect(asked).toHaveLength(2);
  return { threadId, boxes: card("boxes"), friday: card("friday") };
}

const sentTo = (body: string) =>
  fake.sent().filter((message) => message.body.trim() === body.trim()).length;
const waiting = async () =>
  (await approvals.list(owner)).filter(
    (request) => request.status === "pending",
  );

beforeAll(async () => {
  fake = startFakeGoogle();
  const verifier = randomBytes(32).toString("base64url");
  const consent = new URL(`${fake.url}/o/oauth2/v2/auth`);
  consent.search = new URLSearchParams({
    client_id: CLIENT.clientId,
    redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
    response_type: "code",
    state: "state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const back = new URL(
    (await fetch(consent, { redirect: "manual" })).headers.get("location") ??
      "",
  );
  const { refresh_token: refreshToken } = (await (
    await fetch(`${fake.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        code_verifier: verifier,
      }),
    })
  ).json()) as { refresh_token: string };

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  await database
    .insert(users)
    .values({
      id: owner,
      email: `${owner}@openduet.test`,
      name: "Maya Okafor",
      emailVerified: false,
    })
    .onConflictDoNothing();
  const [existing] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverWasAlreadyThere = existing !== undefined;
  clientBefore = existing?.credentialId ?? null;
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Gmail and Google Calendar",
      vendor: "Google",
      url: "https://www.googleapis.com/",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  for (const name of TOOLS)
    await database
      .insert(mcpTools)
      .values({ serverId, name, vendorName: name, description: name })
      .onConflictDoNothing();
  const [client] = await database
    .insert(credentials)
    .values({
      kind: "mcp_oauth_client",
      provider: serverId,
      keyId: `oauth-client-${suite}`,
      metadata: { clientId: CLIENT.clientId },
      encryptedValue: await encryptSecret(
        ENCRYPTION_KEY,
        JSON.stringify(CLIENT),
      ),
    })
    .returning({ id: credentials.id });
  if (!client) throw new Error("client was not stored");
  credentialIds.push(client.id);
  await database
    .update(mcpServers)
    .set({ credentialId: client.id })
    .where(eq(mcpServers.id, serverId));
  const [token] = await database
    .insert(credentials)
    .values({
      kind: "mcp_user_token",
      provider: serverId,
      keyId: owner,
      metadata: {},
      encryptedValue: await encryptSecret(ENCRYPTION_KEY, refreshToken),
    })
    .returning({ id: credentials.id });
  if (!token) throw new Error("token was not stored");
  credentialIds.push(token.id);
  await database.insert(mcpUserCredentials).values({
    serverId,
    userId: owner,
    credentialId: token.id,
    scope: "https://www.googleapis.com/auth/gmail.send",
  });
  for (const name of TOOLS)
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${serverId}/${name}`, agentId: botId })
      .onConflictDoNothing();

  const listed = JSON.parse(
    (
      await store.callTool({
        ref: `${serverId}/gmail_search_messages`,
        args: { query: "in:inbox newer_than:7d", maxResults: 50 },
        botId,
        actorId: owner,
        initiator: { kind: "person" },
      })
    ).text,
  ) as { messages: { id: string; threadId: string; subject: string }[] };
  for (const [which, subject] of [
    ["boxes", "Which box for the Hearth order?"],
    ["friday", "Friday off?"],
  ] as const) {
    const found = listed.messages.find(
      (message) => message.subject === subject,
    );
    if (!found) throw new Error(`the fake has no "${subject}" from Sam`);
    sam[which] = found;
  }
});

afterAll(async () => {
  await database
    .delete(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, owner));
  await database
    .delete(approvalRules)
    .where(eq(approvalRules.ownerUserId, owner));
  await database.delete(pluginGrants).where(
    and(
      eq(pluginGrants.agentId, botId),
      inArray(
        pluginGrants.ref,
        TOOLS.map((name) => `${serverId}/${name}`),
      ),
    ),
  );
  await database
    .delete(mcpUserCredentials)
    .where(
      and(
        eq(mcpUserCredentials.serverId, serverId),
        eq(mcpUserCredentials.userId, owner),
      ),
    );
  await database
    .update(mcpServers)
    .set({ credentialId: clientBefore })
    .where(eq(mcpServers.id, serverId));
  for (const id of credentialIds)
    await database.delete(credentials).where(eq(credentials.id, id));
  if (!serverWasAlreadyThere) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database
      .delete(mcpServers)
      .where(and(eq(mcpServers.id, serverId), isNull(mcpServers.credentialId)));
  }
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(eq(agents.id, botId));
  await fake.stop();
  await database.$client.close();
});

function reset() {
  fake.reset();
  carriedOut.length = 0;
  heard = [];
  runs = 0;
  failAfterSending = 0;
  resendsEverything = false;
}

describe("two sends to Sam in one step", () => {
  test("Allow once on each: each reply goes once, and the run is carried on once", async () => {
    reset();
    const { boxes, friday } = await stepThatAsksTwice();
    expect(fake.sent()).toEqual([]);

    await approvals.decide(owner, boxes.id, "allow_once");
    await carryOn(boxes.id);
    // The first is decided and done; the run waits for the second instead of going on without it.
    expect(runs).toBe(0);
    expect(fake.sent()).toEqual([]);
    expect((await approvals.get(owner, boxes.id)).status).toBe("approved");

    await approvals.decide(owner, friday.id, "allow_once");
    await carryOn(friday.id);
    expect(runs).toBe(1);
    expect(sentTo(replies.boxes)).toBe(1);
    expect(sentTo(replies.friday)).toBe(1);
    expect(fake.sent()).toHaveLength(2);
    expect(carriedOut.sort()).toEqual(
      [boxes.action.toolCallId, friday.action.toolCallId].sort(),
    );
    for (const request of [boxes, friday])
      expect((await approvals.get(owner, request.id)).status).toBe("completed");
    expect(await waiting()).toEqual([]);
  });

  test("a continuation tried five times, after the Bot sent, sends each reply once", async () => {
    reset();
    const { boxes, friday } = await stepThatAsksTwice();
    await approvals.decide(owner, boxes.id, "allow_once");
    await carryOn(boxes.id);
    await approvals.decide(owner, friday.id, "allow_once");
    // Every try but the last sends, then fails: a lost lease, or the server stopped mid-turn.
    failAfterSending = 4;
    for (let tries = 0; tries < 5; tries += 1) await carryOn(friday.id);
    expect(runs).toBe(5);
    expect(sentTo(replies.boxes)).toBe(1);
    expect(sentTo(replies.friday)).toBe(1);
    expect(fake.sent()).toHaveLength(2);
    // Each decision was carried out once; the Bot's repeats were told it had already gone.
    expect(carriedOut).toHaveLength(2);
    expect(
      heard.filter((answer) => answer.startsWith("Not sent again")),
    ).toHaveLength(8);
    // Nothing new was put to the person.
    expect(await waiting()).toEqual([]);
    expect((await approvals.get(owner, friday.id)).status).toBe("completed");
  });

  test("Allow once, then Refuse: only the allowed reply goes", async () => {
    reset();
    const { boxes, friday } = await stepThatAsksTwice();
    await approvals.decide(owner, boxes.id, "allow_once");
    await carryOn(boxes.id);
    await approvals.decide(owner, friday.id, "deny");
    await carryOn(friday.id);
    expect(runs).toBe(1);
    expect(sentTo(replies.boxes)).toBe(1);
    expect(sentTo(replies.friday)).toBe(0);
    expect(carriedOut).toEqual([boxes.action.toolCallId]);
    expect(await waiting()).toEqual([]);
  });

  test("in the reverse order, Refuse then Allow once: only the allowed reply goes", async () => {
    reset();
    const { boxes, friday } = await stepThatAsksTwice();
    await approvals.decide(owner, friday.id, "deny");
    await carryOn(friday.id);
    expect(runs).toBe(0);
    await approvals.decide(owner, boxes.id, "allow_once");
    await carryOn(boxes.id);
    expect(runs).toBe(1);
    expect(sentTo(replies.boxes)).toBe(1);
    expect(sentTo(replies.friday)).toBe(0);
    expect(fake.sent()).toHaveLength(1);
  });

  test("refused, both: nothing is carried out and nothing goes", async () => {
    reset();
    const { boxes, friday } = await stepThatAsksTwice();
    for (const request of [boxes, friday]) {
      await approvals.decide(owner, request.id, "deny");
      await carryOn(request.id);
    }
    expect(runs).toBe(1);
    expect(carriedOut).toEqual([]);
    expect(fake.sent()).toEqual([]);
    expect(await waiting()).toEqual([]);
  });

  test("a Bot that sends a refused reply anyway is asked again, sends nothing, and does not loop", async () => {
    reset();
    resendsEverything = true;
    const { boxes, friday } = await stepThatAsksTwice();
    await approvals.decide(owner, boxes.id, "allow_once");
    await carryOn(boxes.id);
    await approvals.decide(owner, friday.id, "deny");
    // Its continuation stops on the new question: that is the conversation waiting, not a
    // failure, so the sweep finishes rather than retries it.
    for (let tries = 0; tries < 5; tries += 1) await carryOn(friday.id);
    expect(runs).toBe(1);
    expect(sweep.finished.has(friday.id)).toBe(true);
    expect(sentTo(replies.boxes)).toBe(1);
    expect(sentTo(replies.friday)).toBe(0);
    const asked = await waiting();
    expect(asked).toHaveLength(1);
    expect(
      String(asked[0]?.action.args && JSON.stringify(asked[0].action.args)),
    ).toContain("Friday off");
    await approvals.decide(owner, asked[0]?.id ?? "", "deny");
  });
});
