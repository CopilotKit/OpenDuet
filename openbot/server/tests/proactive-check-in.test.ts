import { describe, expect, test } from "bun:test";
import { OFFER_TASK_TOOL, readCheckIn } from "@openbot/shared/check-in";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import type { AuditInitiator } from "../src/audit";
import {
  checkInWindow,
  createProactiveEngine,
  type ProactiveScope,
  researchInstruction,
  suggestionNotice,
  type TaskThreads,
} from "../src/proactive/engine";
import {
  checkInInitiator,
  createReadOnlyClassifier,
  guardProactiveCallback,
  isCheckInInitiator,
  proactiveInitiator,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "../src/proactive/restriction";
import type { ProactiveStore } from "../src/proactive/store";
import {
  MIN_INTERVAL_MINUTES,
  type ProactiveSetting,
  type ProactiveSuggestion,
  proactiveSettingInputSchema,
} from "../src/proactive/types";
import type { WorkQueue } from "../src/work/queue";

/** These engines never start a task; one that tried would fail the test loudly. */
const NO_TASKS: TaskThreads = {
  open: async () => {
    throw new Error("This test never opens a task.");
  },
  scope: async () => null,
  failedTurn: async () => {
    throw new Error("This test never retries a task.");
  },
};

/**
 * Background research as check-ins: each reads only what is new, most end silently, and one that
 * found something writes first in the person's own conversation, holding nothing but `offer_task`.
 */

const NOW = new Date("2026-10-22T17:30:00.000Z");
const ROSA = "Reply to Rosa about the glaze substitute";

function settingWith(
  overrides: Partial<ProactiveSetting> = {},
): ProactiveSetting {
  return {
    id: "setting",
    ownerUserId: "owner",
    agentId: "openduet",
    channelId: "chat-channel",
    threadId: "research-thread",
    focus: "",
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: NOW,
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function suggestionRow(
  overrides: Partial<ProactiveSuggestion>,
): ProactiveSuggestion {
  return {
    id: "open-1",
    ownerUserId: "owner",
    agentId: "openduet",
    settingId: "setting",
    runId: "earlier",
    title: ROSA,
    detail: "Rosa needs an answer by end of day.",
    sourceApp: "Gmail",
    sourceRef: null,
    sourceLink: null,
    status: "open",
    deliveredAt: NOW,
    resolvedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * One run, driven through the queue the way the sweep drives it. `research` is what the model does
 * in the research turn, given the run's own tools.
 */
async function checkIn(options: {
  setting?: ProactiveSetting;
  open?: ProactiveSuggestion[];
  /** Suggestions the person hid, answered as the store does: this Bot's, hidden since `since`. */
  hidden?: ProactiveSuggestion[];
  research?: (tools: HeadlessTool[]) => Promise<unknown>;
  checkInFails?: boolean;
  withoutCheckIn?: boolean;
}) {
  const setting = options.setting ?? settingWith();
  const added: ProactiveSuggestion[] = [];
  const statuses: string[] = [];
  const instructions: string[] = [];
  const notified: { scope: ProactiveScope; text: string }[] = [];
  const checkIns: {
    scope: ProactiveScope;
    input: { runId: string; text: string; initiator: AuditInitiator };
  }[] = [];
  let given = false;
  const queue = {
    offer: async () => "queued",
    claim: async ({ kind }: { kind: string }) => {
      if (given || kind !== "proactive.run") return [];
      given = true;
      return [
        {
          kind,
          key: "k",
          payload: { settingId: setting.id, runId: "run-1" },
          attempts: 1,
        },
      ];
    },
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
  } as unknown as WorkQueue;
  const store = {
    claimDue: async () => [],
    byId: async () => setting,
    recordRun: async (_id: string, status: string) => {
      statuses.push(status);
    },
    readsFor: async () => [],
    suggestions: async () => options.open ?? [],
    hiddenSince: async (owner: string, agentId: string, since: Date) =>
      (options.hidden ?? [])
        .filter(
          (row) =>
            row.ownerUserId === owner &&
            row.agentId === agentId &&
            row.status === "dismissed" &&
            row.resolvedAt !== null &&
            row.resolvedAt >= since,
        )
        .map((row) => row.title),
    countSuggestions: async () => added.length,
    addSuggestion: async (
      input: Omit<
        ProactiveSuggestion,
        "id" | "status" | "deliveredAt" | "resolvedAt" | "createdAt"
      >,
    ) => {
      const row = suggestionRow({
        ...input,
        id: `new-${added.length}`,
        deliveredAt: null,
      });
      added.push(row);
      return row;
    },
    undelivered: async () => added.filter((row) => !row.deliveredAt),
    markDelivered: async (id: string) => {
      const row = added.find((entry) => entry.id === id);
      if (row) row.deliveredAt = NOW;
    },
  } as unknown as ProactiveStore;
  const runTurn: TurnRunner = async (input) => {
    instructions.push(input.instruction);
    const tools = await engine.toolsForTurn({
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      initiator: input.initiator ?? { kind: "person" },
    });
    await options.research?.(tools);
    return { replyText: "Looked at the inbox since the last check-in." };
  };
  const engine = createProactiveEngine({
    store,
    memory: {
      formMemory: async () => ({ id: "m", duplicate: false, forgotten: false }),
    },
    queue,
    owner: "worker",
    runTurn,
    resolveScope: async (ownerUserId, channelId, agentId) => ({
      ownerUserId,
      channelId,
      agentId,
      threadId: `${channelId}-thread`,
    }),
    notify: async (scope, input) => {
      notified.push({ scope, text: input.text });
    },
    tasks: NO_TASKS,
    startTask: async () => {
      throw new Error("A check-in never starts a task.");
    },
    ...(options.withoutCheckIn
      ? {}
      : {
          checkIn: async (
            scope: ProactiveScope,
            input: { runId: string; text: string; initiator: AuditInitiator },
          ) => {
            checkIns.push({ scope, input });
            if (options.checkInFails)
              throw new Error("The thread is locked by the person's own turn.");
          },
        }),
    catalogue: { listServers: async () => [] },
    mintThreadId: () => "t",
    now: () => NOW,
  });
  await engine.sweep();
  return { added, statuses, instructions, notified, checkIns };
}

/** The model suggesting one next step through the run's own tool. */
function suggest(title: string, detail = "Priya's mugs arrived broken.") {
  return async (tools: HeadlessTool[]) => {
    const tool = tools.find(
      (entry) => entry.definition.name === "suggest_next_step",
    );
    return tool?.execute(
      { title, detail },
      { toolCallId: "call", signal: new AbortController().signal },
    );
  };
}

describe("the window a check-in reads", () => {
  test("the first check-in reads the last day, and says so", () => {
    const window = checkInWindow(settingWith(), NOW, []);
    expect(window).toMatchObject({ firstRun: true });
    expect(window.since.toISOString()).toBe("2026-10-21T17:30:00.000Z");
    const prompt = researchInstruction(settingWith(), window);
    const after = Math.floor(window.since.getTime() / 1000);
    expect(prompt).toContain(`after:${after}`);
    expect(prompt).toContain(
      "the last day, because this is the first check-in",
    );
    expect(prompt).toContain("today's and tomorrow's events");
  });

  test("after a successful check-in it reads only what is new since that one", () => {
    const last = new Date("2026-10-22T16:30:00.000Z");
    const window = checkInWindow(
      settingWith({ lastRunAt: last, lastStatus: "succeeded" }),
      NOW,
      [],
    );
    expect(window).toMatchObject({ firstRun: false, since: last });
    expect(researchInstruction(settingWith(), window)).toContain(
      `"in:inbox after:${Math.floor(last.getTime() / 1000)}"`,
    );
  });

  test("after a failed check-in it goes back a day, since that run's reads are not to be trusted", () => {
    const window = checkInWindow(
      settingWith({
        lastRunAt: new Date("2026-10-22T16:30:00.000Z"),
        lastStatus: "error",
      }),
      NOW,
      [],
    );
    expect(window.firstRun).toBe(true);
    expect(window.since.toISOString()).toBe("2026-10-21T17:30:00.000Z");
  });

  test("the prompt makes silence the usual outcome and lists what is still open", () => {
    const prompt = researchInstruction(
      settingWith(),
      checkInWindow(settingWith(), NOW, [ROSA, "Confirm the kiln delivery"]),
    );
    expect(prompt).toContain("Most check-ins should record nothing");
    expect(prompt).toContain("silence is the right outcome");
    expect(prompt).toContain(
      `Never suggest any of these again, however you would word it:\n- ${ROSA}\n- Confirm the kiln delivery`,
    );
  });

  test("the run is given the window and this Bot's open suggestions, and no other Bot's", async () => {
    const last = new Date("2026-10-22T16:30:00.000Z");
    const { instructions } = await checkIn({
      setting: settingWith({ lastRunAt: last, lastStatus: "succeeded" }),
      open: [
        suggestionRow({ title: ROSA }),
        suggestionRow({
          id: "other",
          agentId: "another-bot",
          title: "File the quarterly taxes",
        }),
      ],
    });
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain(
      `after:${Math.floor(last.getTime() / 1000)}`,
    );
    expect(instructions[0]).toContain(`- ${ROSA}`);
    expect(instructions[0]).not.toContain("File the quarterly taxes");
  });
});

describe("what the person hid", () => {
  const hiddenDaysAgo = (id: string, title: string, days: number) =>
    suggestionRow({
      id,
      title,
      status: "dismissed",
      resolvedAt: new Date(NOW.getTime() - days * 86_400_000),
    });

  test("the prompt carries a title hidden recently and leaves out one hidden 15 days ago", async () => {
    const { instructions } = await checkIn({
      hidden: [
        hiddenDaysAgo("h-1", "Renew the Makers Market stall", 2),
        hiddenDaysAgo("h-2", "Book the kiln technician", 15),
      ],
    });
    expect(instructions[0]).toContain(
      "The person hid these in the last 14 days. Never suggest any of them again either:\n- Renew the Makers Market stall",
    );
    expect(instructions[0]).not.toContain("Book the kiln technician");
  });

  test("a recently hidden title is refused if suggested anyway, and nothing reaches the person", async () => {
    let answer: unknown;
    const { added, notified, checkIns } = await checkIn({
      hidden: [hiddenDaysAgo("h-1", "Renew the Makers Market stall", 2)],
      research: async (tools) => {
        answer = await suggest("renew the Makers Market stall.")(tools);
      },
    });
    expect(String(answer)).toStartWith("Refused.");
    expect(String(answer)).toContain("hidden by the person");
    expect(added).toEqual([]);
    expect(notified).toEqual([]);
    expect(checkIns).toEqual([]);
  });
});

describe("a check-in", () => {
  test("that records nothing starts no turn and notifies nothing", async () => {
    const { statuses, notified, checkIns } = await checkIn({});
    expect(statuses).toEqual(["running", "succeeded"]);
    expect(notified).toEqual([]);
    expect(checkIns).toEqual([]);
  });

  test("that records one writes first: exactly one framed turn, in the setting's conversation", async () => {
    const { added, notified, checkIns, statuses } = await checkIn({
      research: suggest("Send Priya replacement mugs today"),
    });
    expect(statuses).toEqual(["running", "succeeded"]);
    expect(added).toHaveLength(1);
    expect(checkIns).toHaveLength(1);
    const [only] = checkIns;
    // The person's own conversation with the Bot, not the research thread.
    expect(only?.scope).toEqual({
      ownerUserId: "owner",
      channelId: "chat-channel",
      agentId: "openduet",
      threadId: "chat-channel-thread",
    });
    expect(only?.input.runId).toBe("check-in-run-1");
    expect(isCheckInInitiator(only?.input.initiator)).toBe(true);
    expect(readCheckIn(only?.input.text ?? "")).toEqual({
      checkedAt: NOW.toISOString(),
      offers: [
        {
          id: "new-0",
          title: "Send Priya replacement mugs today",
          why: "Priya's mugs arrived broken.",
        },
      ],
    });
    // Delivered first, and the push names what is ready.
    expect(notified.map((entry) => entry.text)).toEqual([
      "Send Priya replacement mugs today\nPriya's mugs arrived broken.",
    ]);
  });

  test("that cannot be started is skipped, and the delivery is kept", async () => {
    const { notified, checkIns, statuses } = await checkIn({
      research: suggest("Send Priya replacement mugs today"),
      checkInFails: true,
    });
    expect(checkIns).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(statuses).toEqual(["running", "succeeded"]);
  });

  test("on a deployment that cannot write first, research only notifies", async () => {
    const { notified, checkIns } = await checkIn({
      research: suggest("Send Priya replacement mugs today"),
      withoutCheckIn: true,
    });
    expect(notified).toHaveLength(1);
    expect(checkIns).toEqual([]);
  });

  test("never suggests again what is still open, however it is cased or punctuated", async () => {
    let answer: unknown;
    const { added, notified, checkIns } = await checkIn({
      open: [suggestionRow({ title: ROSA })],
      research: async (tools) => {
        answer = await suggest("reply to Rosa about the glaze  substitute.")(
          tools,
        );
      },
    });
    expect(String(answer)).toStartWith("Refused.");
    expect(String(answer)).toContain("already suggested and still open");
    expect(added).toEqual([]);
    expect(notified).toEqual([]);
    expect(checkIns).toEqual([]);
  });
});

describe("the notification", () => {
  test("leads with the title, then why, then where it came from", () => {
    const text = suggestionNotice({
      title: ROSA,
      detail:
        "Rosa needs a yes or no on Oat Satin by 4pm.\n\nNext: Reply in her thread with the two options.",
      sourceApp: "Gmail",
    });
    expect(text).toBe(
      `${ROSA}\nRosa needs a yes or no on Oat Satin by 4pm.\nFrom Gmail`,
    );
    expect(text).not.toContain("Suggested next step");
    expect(
      suggestionNotice({ title: ROSA, detail: "Soon.", sourceApp: null }),
    ).toBe(`${ROSA}\nSoon.`);
  });
});

describe("what a check-in may call", () => {
  const granted = (
    name: string,
    ref: string,
    calls: string[],
  ): GrantedTool => ({
    name,
    ref,
    description: ref,
    parameters: z.object({}),
    execute: async () => {
      calls.push(ref);
      return `${ref} ran`;
    },
  });
  const catalogue = createReadOnlyClassifier({
    listServers: async () => [
      {
        id: "google-workspace",
        title: "Google Workspace",
        tools: [
          {
            ref: "google-workspace/gmail_search_messages",
            effect: "read",
            destructive: false,
          },
          {
            ref: "google-workspace/gmail_send_reply",
            effect: "write",
            destructive: false,
          },
        ],
      },
    ],
  });

  test("offer_task and nothing else, not even a read", async () => {
    const calls: string[] = [];
    const load = async () => [
      granted(OFFER_TASK_TOOL, `openduet/${OFFER_TASK_TOOL}`, calls),
      granted(
        "mcp__google-workspace__gmail_search_messages",
        "google-workspace/gmail_search_messages",
        calls,
      ),
      granted(
        "mcp__google-workspace__gmail_send_reply",
        "google-workspace/gmail_send_reply",
        calls,
      ),
    ];
    const held = await restrictToolsForRun(
      checkInInitiator("c"),
      load,
      catalogue,
    )();
    expect(held.map((tool) => tool.name)).toEqual([OFFER_TASK_TOOL]);
    // A research run still reads, and is still never offered the card.
    expect(
      (
        await restrictToolsForRun(proactiveInitiator("r"), load, catalogue)()
      ).map((tool) => tool.name),
    ).toEqual(["mcp__google-workspace__gmail_search_messages"]);
    // No hand-offs, and the remote door refuses a read as firmly as a write.
    expect(
      await restrictCoordinationForRun(checkInInitiator("c"), async () => [
        "message_bot",
      ])(),
    ).toEqual([]);
    const run = { initiator: checkInInitiator("c") };
    for (const name of [
      "google-workspace/gmail_search_messages",
      "google-workspace/gmail_send_reply",
      "message_bot",
    ])
      expect(
        (await guardProactiveCallback({ name, run }, catalogue))?.text,
      ).toStartWith("Refused.");
    expect(
      await guardProactiveCallback(
        { name: `openduet/${OFFER_TASK_TOOL}`, run },
        catalogue,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("everything else the Bot holds is answered with a hidden refusal", async () => {
    const asked: AuditInitiator[] = [];
    const engine = createProactiveEngine({
      store: {} as ProactiveStore,
      memory: {
        formMemory: async () => ({
          id: "m",
          duplicate: false,
          forgotten: false,
        }),
      },
      queue: {} as WorkQueue,
      owner: "worker",
      runTurn: async () => ({ replyText: "" }),
      resolveScope: async () => null,
      notify: async () => undefined,
      tasks: NO_TASKS,
      startTask: async () => undefined,
      catalogue: { listServers: async () => [] },
      deniedToolNames: async (_owner, _agent, initiator) => {
        asked.push(initiator);
        return ["mcp__google-workspace__gmail_send_reply", "computer_click"];
      },
      mintThreadId: () => "t",
    });
    const tools = await engine.toolsForTurn({
      ownerUserId: "owner",
      agentId: "openduet",
      initiator: checkInInitiator("c"),
    });
    expect(tools.map((tool) => [tool.definition.name, tool.hidden])).toEqual([
      ["mcp__google-workspace__gmail_send_reply", true],
      ["computer_click", true],
    ]);
    expect(
      String(
        await tools[0]?.execute(
          {},
          { toolCallId: "x", signal: new AbortController().signal },
        ),
      ),
    ).toStartWith("Refused.");
    expect(asked).toEqual([checkInInitiator("c")]);
  });
});

describe("how often", () => {
  test("a person may ask for a check-in every fifteen minutes, and no more often", () => {
    expect(MIN_INTERVAL_MINUTES).toBe(15);
    const input = { agentId: "openduet", channelId: "chat-channel" };
    expect(
      proactiveSettingInputSchema.safeParse({ ...input, intervalMinutes: 15 })
        .success,
    ).toBe(true);
    expect(
      proactiveSettingInputSchema.safeParse({ ...input, intervalMinutes: 14 })
        .success,
    ).toBe(false);
  });
});
