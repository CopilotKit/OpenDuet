import { expect, test } from "bun:test";
import type { ApprovalRequest, PersonQuestion } from "@/lib/approvals";
import { agoShort } from "@/lib/relative-time";
import {
  activeGroups,
  matchesSearch,
  needsInputCount,
  RESOLVED_FOR_MS,
  sortByTime,
  taskTag,
} from "@/lib/tasks/groups";
import type { TaskRecord } from "@/lib/tasks/queries";

/**
 * How Tasks' Active list is grouped, ordered and counted, worked out without drawing anything: the
 * order of the groups, a task's approval belonging to the task, the week Resolved keeps, and the
 * badge counting what Needs input lists.
 */

const NOW = Date.parse("2026-10-22T12:00:00Z");
const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();

const task = (overrides: Partial<TaskRecord>): TaskRecord => ({
  id: "task",
  botId: "openduet",
  channelId: `${overrides.id ?? "task"}-channel`,
  threadId: `${overrides.id ?? "task"}-thread`,
  title: overrides.id ?? "task",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  failure: null,
  failedAt: null,
  status: "working",
  resolvedAt: null,
  createdAt: at(60),
  updatedAt: at(60),
  ...overrides,
});

const request = (id: string, threadId: string): ApprovalRequest => ({
  id,
  status: "pending",
  createdAt: at(5),
  action: {
    botId: "openduet",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "ana@example.com",
    threadId,
    args: {},
    target: {},
  },
});

const question = (id: string, threadId: string): PersonQuestion => ({
  id,
  botId: "openduet",
  threadId,
  question: "Which deck?",
  createdAt: at(3),
});

const group = (input: Partial<Parameters<typeof activeGroups>[0]> = {}) =>
  activeGroups({
    tasks: [],
    conversation: () => undefined,
    requests: [],
    questions: [],
    working: [],
    handled: [],
    now: NOW,
    order: "newest",
    query: "",
    ...input,
  });

test("the groups come in order, and an empty one is left out", () => {
  const groups = group({
    tasks: [
      task({ id: "done", status: "resolved", resolvedAt: at(10) }),
      task({ id: "run", status: "working" }),
      task({ id: "read", status: "ready_for_review" }),
    ],
  });
  expect(groups.map((entry) => entry.id)).toEqual([
    "ready_for_review",
    "working",
    "resolved",
  ]);
  expect(groups.map((entry) => entry.label)).toEqual([
    "Ready for review",
    "Working",
    "Resolved",
  ]);
});

test("a task's own approval or question makes it Needs input and is not listed again", () => {
  const groups = group({
    tasks: [
      task({ id: "rosa", status: "ready_for_review" }),
      task({ id: "sam", status: "working" }),
    ],
    requests: [request("mine", "rosa-thread"), request("loose", "elsewhere")],
    questions: [question("asked", "sam-thread")],
  });
  expect(groups.map((entry) => entry.id)).toEqual(["needs_input"]);
  const items = groups[0]?.items ?? [];
  expect(items.map((item) => item.key).sort()).toEqual([
    "request:loose",
    "task:rosa",
    "task:sam",
  ]);
  const needs = Object.fromEntries(
    items.flatMap((item) =>
      item.kind === "task" ? [[item.task.id, item.need]] : [],
    ),
  );
  expect(needs).toEqual({
    rosa: "Allow it to send email, or refuse",
    sam: "Which deck?",
  });
});

for (const status of ["failed", "working", "ready_for_review"] as const) {
  test(`an accepted answer does not turn a ${status} task back into Needs input`, () => {
    const answered = {
      ...task({ id: "answered", status, failure: "a service didn't answer" }),
      answeredQuestionIds: ["old"],
    };
    const questions = [question("old", "answered-thread")];
    const groups = group({ tasks: [answered], questions });
    expect(groups.map((entry) => entry.id)).toEqual([status]);
    if (status === "failed")
      expect(groups[0]?.items[0]).toMatchObject({
        status: "failed",
        need: "Couldn't finish: a service didn't answer.",
      });
    expect(
      needsInputCount([answered], {
        enabled: true,
        rules: [],
        teamRules: [],
        requests: [],
        questions,
      }),
    ).toBe(0);
  });
}

test("accepted question IDs preserve new questions, approvals, and other tasks' questions", () => {
  const answered = {
    ...task({ id: "answered", status: "failed" }),
    answeredQuestionIds: ["old"],
  };
  for (const waiting of [
    { questions: [question("new", "answered-thread")], requests: [] },
    { questions: [], requests: [request("approval", "answered-thread")] },
  ]) {
    expect(group({ tasks: [answered], ...waiting })[0]?.id).toBe("needs_input");
    expect(
      needsInputCount([answered], {
        enabled: true,
        rules: [],
        teamRules: [],
        ...waiting,
      }),
    ).toBe(1);
  }
  const groups = group({
    tasks: [answered, task({ id: "other", status: "working" })],
    questions: [question("old", "other-thread")],
  });
  expect(
    groups
      .find((entry) => entry.id === "needs_input")
      ?.items.map((item) => item.key),
  ).toEqual(["task:other"]);
});

test("a busy conversation reads Working, and a waiting one still reads Needs input", () => {
  const groups = group({
    tasks: [
      task({ id: "read", status: "ready_for_review" }),
      task({ id: "wait", status: "needs_input" }),
    ],
    conversation: () => ({ busy: true, lastMessageAt: null }),
  });
  expect(
    groups.map((entry) => [entry.id, entry.items.map((item) => item.key)]),
  ).toEqual([
    ["needs_input", ["task:wait"]],
    ["working", ["task:read"]],
  ]);
});

test("Resolved keeps a week of done tasks", () => {
  const groups = group({
    tasks: [
      task({ id: "recent", status: "resolved", resolvedAt: at(60) }),
      task({
        id: "old",
        status: "resolved",
        resolvedAt: new Date(NOW - RESOLVED_FOR_MS - 60_000).toISOString(),
      }),
    ],
  });
  expect(groups[0]?.items.map((item) => item.key)).toEqual(["task:recent"]);
});

test("Updated is the newest thing in a group: the task's conversation counts", () => {
  const groups = group({
    tasks: [
      task({ id: "a", status: "ready_for_review", updatedAt: at(300) }),
      task({ id: "b", status: "ready_for_review", updatedAt: at(200) }),
    ],
    conversation: (channelId) =>
      channelId === "a-channel"
        ? { busy: false, lastMessageAt: at(2) }
        : undefined,
  });
  expect(groups[0]?.updatedAt).toBe(at(2));
  expect(groups[0]?.items.map((item) => item.key)).toEqual([
    "task:a",
    "task:b",
  ]);
  expect(agoShort(groups[0]?.updatedAt ?? "", NOW)).toBe("2 min ago");
});

test("search keeps the things whose title has every word typed, in any case", () => {
  expect(matchesSearch("Reply to Rosa about the glaze", "rosa GLAZE")).toBe(
    true,
  );
  expect(matchesSearch("Reply to Rosa about the glaze", "rosa invoice")).toBe(
    false,
  );
  expect(matchesSearch("Anything", "  ")).toBe(true);
  const groups = group({
    tasks: [
      task({ id: "rosa", title: "Reply to Rosa", status: "working" }),
      task({ id: "sam", title: "Answer Sam", status: "working" }),
    ],
    query: "sam",
  });
  expect(groups[0]?.items.map((item) => item.key)).toEqual(["task:sam"]);
});

test("sorting turns a list round, keeping ties as given", () => {
  const items = [
    { id: "a", at: at(10) },
    { id: "b", at: at(5) },
    { id: "c", at: at(10) },
  ];
  expect(sortByTime(items, "newest").map((item) => item.id)).toEqual([
    "b",
    "a",
    "c",
  ]);
  expect(sortByTime(items, "oldest").map((item) => item.id)).toEqual([
    "a",
    "c",
    "b",
  ]);
});

test("a task's tag is You asked, or where it came from", () => {
  expect(taskTag({ origin: "asked", sourceApp: "Gmail" })).toBe("You asked");
  expect(taskTag({ origin: "suggestion", sourceApp: "Gmail" })).toBe("Gmail");
  expect(taskTag({ origin: "check_in", sourceApp: null })).toBe("Suggested");
});

test("the badge counts Needs input: waiting tasks once, and what waits outside any task", () => {
  const tasks = [
    task({ id: "rosa", status: "needs_input" }),
    task({ id: "sam", status: "working" }),
  ];
  expect(
    needsInputCount(tasks, {
      enabled: true,
      rules: [],
      teamRules: [],
      requests: [
        request("rosa-own", "rosa-thread"),
        request("sam-own", "sam-thread"),
        request("loose", "chat-thread"),
        { ...request("done", "chat-thread"), status: "completed" },
      ],
      questions: [question("q", "chat-thread")],
    }),
  ).toBe(4);
  expect(needsInputCount(undefined, undefined)).toBe(0);
});

test("how long ago, in a heading's few words", () => {
  expect(agoShort(at(0), NOW)).toBe("just now");
  expect(agoShort(at(1), NOW)).toBe("1 min ago");
  expect(agoShort(at(59), NOW)).toBe("59 min ago");
  expect(agoShort(at(60 * 3), NOW)).toBe("3 hr ago");
  expect(agoShort(at(60 * 30), NOW)).toBe("yesterday");
  expect(agoShort(at(60 * 24 * 4), NOW)).toBe("4 days ago");
  expect(agoShort(at(60 * 24 * 15), NOW)).toBe("2 wk ago");
  expect(agoShort("not a time", NOW)).toBe("just now");
});
