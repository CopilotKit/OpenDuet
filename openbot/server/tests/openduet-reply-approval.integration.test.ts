import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withApprovalContext } from "@openbot/toolkit/continuation";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type FakeGoogle,
  startFakeGoogle,
} from "../../scripts/fake-google/server";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
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
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "../src/proactive/private-share";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * OpenDuet's promise, end to end: a reply it drafts reaches Gmail only after the person answers.
 *
 * Real plugin store, real approval store and service, real private-share check, on a real database.
 * The vendor is the fake Google in scripts/fake-google, reached over HTTP by the real Gmail adapter,
 * so "nothing was sent" is read from the mailbox that would have received it, not inferred from a
 * mock that was not called. The only stand-in is the auto-review model, which answers as told.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `user_reply_owner_${suite}`;
const botId = `agent_reply_${suite}`;
const serverId = "google-workspace";
const TOOLS = [
  "gmail_search_messages",
  "gmail_read_message",
  "gmail_send_reply",
  "calendar_list_events",
];
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT = { clientId: "fake-client", clientSecret: "fake-secret" };
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** What the auto-review model answers. Each test sets it; "proceed" unless a test says otherwise. */
let reviewer: { verdict: "proceed" | "needs_approval"; preApproved: boolean } =
  { verdict: "proceed", preApproved: true };

let fake: FakeGoogle;
let refreshToken = "";
const credentialIds: string[] = [];
let serverWasAlreadyThere = false;
let clientBefore: string | null = null;

const approvals = createApprovalStore(database);
const service = createApprovalService(approvals, undefined, undefined, {
  review: async () =>
    JSON.stringify({ ...reviewer, safety: "none", reason: "Test reviewer." }),
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
  // Google's token endpoint is the fake's, so the access token the adapter carries is one the fake
  // issued from the refresh token this person connected with.
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
  // The real Gmail adapter, pointed at the fake instead of www.googleapis.com.
  callVendor: (connection, toolName, args) =>
    callGoogle(
      { url: fake.url, token: connection.token ?? "" },
      toolName,
      args,
    ),
});

/** Consent and redeem a code with PKCE, as OpenBot's connect flow does, for a real refresh token. */
async function signIn(): Promise<string> {
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
  const tokens = (await (
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
  return tokens.refresh_token;
}

/** The message OpenDuet is replying to: Ana asking for Friday's ship date. */
let original: { id: string; threadId: string; from: string };

function replyTo(to = "Ana Pereira <ana@hearthandco.com>") {
  return {
    threadId: original.threadId,
    inReplyTo: original.id,
    to: [to],
    subject: "Friday ship date for the 120 mugs?",
    body: "Hi Ana, our kiln is down until Monday. Could we ship your 120 mugs on Tuesday instead? Thanks, Maya",
  };
}

const send = (args: Record<string, unknown>) =>
  store.callTool({
    ref: `${serverId}/gmail_send_reply`,
    args,
    botId,
    actorId: owner,
    initiator: { kind: "person" },
  });

/** A send inside a run that can wait for the person, which is how a Bot's turn makes it. */
function inRun<T>(threadId: string, args: unknown, run: () => Promise<T>) {
  const toolCallId = randomUUID();
  return withApprovalContext(
    {
      runId: randomUUID(),
      threadId,
      toolCallId,
      toolName: "google-workspace__gmail_send_reply",
      args,
      messages: [
        {
          id: "u1",
          role: "user",
          content: "Ask Ana whether Tuesday works instead.",
        },
      ],
      state: {},
      context: [],
      forwardedProps: {},
    },
    run,
  );
}

const pending = async () =>
  (await approvals.list(owner)).filter(
    (request) => request.status === "pending",
  );

beforeAll(async () => {
  fake = startFakeGoogle();
  refreshToken = await signIn();

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

  // The message being answered, read through the store like any other call.
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
  ) as {
    messages: { id: string; threadId: string; from: string; subject: string }[];
  };
  const found = listed.messages.find(
    (message) => message.subject === "Friday ship date for the 120 mugs?",
  );
  if (!found) throw new Error("the fake has no message from Ana");
  original = found;
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

describe("a reply OpenDuet drafted", () => {
  test("waits for the person, and nothing reaches Gmail until they answer", async () => {
    fake.reset();
    const args = replyTo();
    const waiting = await inRun("thread-wait", args, () => send(args)).catch(
      (error: unknown) => error,
    );
    expect(waiting).toBeInstanceOf(HeadlessToolSuspension);
    expect(fake.sent()).toEqual([]);
    const asked = await pending();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.action.toolRef).toBe(PRIVATE_SHARE_TOOL_REF);
    const shared = asked[0]?.action.args as { audience?: unknown } | undefined;
    expect(String(shared?.audience)).toContain("ana@hearthandco.com");
  });

  test("Refuse never sends it, and trying again only asks again", async () => {
    const [request] = await pending();
    if (!request) throw new Error("nothing was waiting");
    await approvals.decide(owner, request.id, "deny");
    expect(fake.sent()).toEqual([]);
    // A Bot that sends again after a refusal is not let through: it is a new question.
    const args = replyTo();
    const retried = await inRun("thread-wait", args, () => send(args)).catch(
      (error: unknown) => error,
    );
    expect(retried).toBeInstanceOf(HeadlessToolSuspension);
    expect(fake.sent()).toEqual([]);
    const [left] = await pending();
    if (left) await approvals.decide(owner, left.id, "deny");
  });

  test("Allow once sends that reply, in Ana's thread, and only that one", async () => {
    fake.reset();
    const args = replyTo();
    await inRun("thread-once", args, () => send(args)).catch(() => undefined);
    const [request] = await pending();
    if (!request) throw new Error("nothing was waiting");
    await approvals.decide(owner, request.id, "allow_once");

    // The Bot is told to send again, unchanged, and this time the check passes.
    const result = await inRun("thread-once", args, () => send(args));
    expect(result.isError).toBe(false);
    const sent = fake.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to.join(", ")).toContain("ana@hearthandco.com");
    expect(sent[0]?.threadId).toBe(original.threadId);
    expect(sent[0]?.inReplyTo).toBeTruthy();

    // Once means once: the same reply in another conversation asks again.
    const again = await inRun("thread-once-again", args, () =>
      send(args),
    ).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(HeadlessToolSuspension);
    expect(fake.sent()).toHaveLength(1);
    const [left] = await pending();
    if (left) await approvals.decide(owner, left.id, "deny");
  });

  test("Allow once is one send: the same reply again in the same conversation is not sent", async () => {
    fake.reset();
    const args = replyTo();
    await inRun("thread-once-only", args, () => send(args)).catch(
      () => undefined,
    );
    const [request] = await pending();
    if (!request) throw new Error("nothing was waiting");
    await approvals.decide(owner, request.id, "allow_once");
    await inRun("thread-once-only", args, () => send(args));
    expect(fake.sent()).toHaveLength(1);

    // A continuation carried on twice, or a Bot repeating itself: refused, nothing sent, nobody asked.
    const again = await inRun("thread-once-only", args, () => send(args)).catch(
      (error: unknown) => error,
    );
    expect(again).toBeInstanceOf(PluginRefusedError);
    expect(String((again as Error).message)).toContain("Not sent again");
    expect(fake.sent()).toHaveLength(1);
    expect(await pending()).toEqual([]);
  });

  test("Always allow sends this one and the next one to the same person without asking", async () => {
    fake.reset();
    const args = replyTo();
    await inRun("thread-always", args, () => send(args)).catch(() => undefined);
    const [request] = await pending();
    if (!request) throw new Error("nothing was waiting");
    await approvals.decide(owner, request.id, "allow_always");
    await inRun("thread-always", args, () => send(args));
    expect(fake.sent()).toHaveLength(1);

    const next = {
      ...args,
      body: "Hi Ana, one more thing: the slate mugs ship with the rest. Maya",
    };
    const result = await inRun("thread-always-next", next, () => send(next));
    expect(result.isError).toBe(false);
    expect(fake.sent()).toHaveLength(2);
    expect(await pending()).toEqual([]);
  });

  test("a reply to someone else still asks, whatever was allowed for Ana", async () => {
    fake.reset();
    const args = replyTo("Leah Gold <leah@goldenhourhome.com>");
    const waiting = await inRun("thread-other", args, () => send(args)).catch(
      (error: unknown) => error,
    );
    expect(waiting).toBeInstanceOf(HeadlessToolSuspension);
    expect(fake.sent()).toEqual([]);
    const [left] = await pending();
    if (left) await approvals.decide(owner, left.id, "deny");
  });

  test("asks once: a send the person just allowed is not put to the reviewer again", async () => {
    fake.reset();
    // A reviewer that would ask about everything. The person's own answer stands in for it.
    reviewer = { verdict: "needs_approval", preApproved: false };
    try {
      const args = replyTo("Chris Park <chris@parkandpine.co>");
      const first = await inRun("thread-reviewed", args, () =>
        send(args),
      ).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(HeadlessToolSuspension);
      expect(fake.sent()).toEqual([]);
      const [share] = await pending();
      if (!share) throw new Error("nothing was waiting");
      await approvals.decide(owner, share.id, "allow_once");
      const result = await inRun("thread-reviewed", args, () => send(args));
      expect(result.isError).toBe(false);
      expect(fake.sent()).toHaveLength(1);
      expect(await pending()).toEqual([]);
    } finally {
      reviewer = { verdict: "proceed", preApproved: true };
    }
  });

  test("outside a run that can ask, a send nobody allowed is refused and nothing goes out", async () => {
    fake.reset();
    await expect(
      send(replyTo("Priya Shah <priya@shahaccounting.com>")),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(fake.sent()).toEqual([]);
  });
});
