import { expect, test } from "bun:test";
import { primaryBot } from "@/lib/agents/primary-bot";
import type { AgentProfile } from "@/lib/agents/queries";
import { ongoingChannel } from "@/lib/channels/ongoing";
import type { ChannelSummary } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";

function channel(
  id: string,
  agentIds: string[],
  lastMessageAt: string | null,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

test("the Chat tab's conversation is the Bot's most recently used one", () => {
  const found = ongoingChannel(
    [
      channel("older", ["openduet"], "2026-10-20T10:00:00Z"),
      channel("newest", ["openduet"], "2026-10-21T10:00:00Z"),
      channel("other bot", ["helper"], "2026-10-22T10:00:00Z"),
    ],
    "openduet",
  );
  expect(found?.id).toBe("newest");
});

test("a group with the Bot in it and a deleted Bot's channel are not the conversation", () => {
  const found = ongoingChannel(
    [
      channel("group", ["openduet", "helper"], "2026-10-22T10:00:00Z"),
      channel("gone", ["openduet"], "2026-10-21T10:00:00Z", { active: false }),
      channel("this one", ["openduet"], "2026-10-20T10:00:00Z"),
    ],
    "openduet",
  );
  expect(found?.id).toBe("this one");
});

test("a task's own conversation is never Chat's, however recently it was used", () => {
  const found = ongoingChannel(
    [
      channel("task", ["openduet"], "2026-10-22T10:00:00Z", {
        taskId: "task-1",
      }),
      channel("chat", ["openduet"], "2026-10-20T10:00:00Z", { taskId: null }),
    ],
    "openduet",
  );
  expect(found?.id).toBe("chat");
});

test("a conversation nobody has spoken in yet counts from when it was made", () => {
  const found = ongoingChannel(
    [
      channel("spoken", ["openduet"], "2026-10-02T00:00:00Z"),
      channel("just made", ["openduet"], null, {
        createdAt: "2026-10-03T00:00:00Z",
      }),
    ],
    "openduet",
  );
  expect(found?.id).toBe("just made");
  expect(ongoingChannel(undefined, "openduet")).toBeUndefined();
});

const bot = (id: string) => ({ id, name: id }) as AgentProfile;

test("the tabs are about the tenant's own Bot, or the default Bot without one", () => {
  const own = appConfig.brand.tenantId;
  expect(primaryBot([bot("helper"), bot(own)])?.id).toBe(own);
  expect(primaryBot([bot("helper"), bot("another")])?.id).toBe("helper");
  expect(primaryBot(undefined)).toBeUndefined();
});

test("one of the person's channels is never Chat's, however recently it was used", () => {
  const found = ongoingChannel(
    [
      channel("kiln move", ["openduet"], "2026-10-22T10:00:00Z", {
        openduetChannel: true,
      }),
      channel("chat", ["openduet"], "2026-10-20T10:00:00Z"),
    ],
    "openduet",
  );
  expect(found?.id).toBe("chat");
});
