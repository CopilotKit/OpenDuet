import { describe, expect, test } from "bun:test";
import {
  ADD_TASKS_TOOL,
  type AskedTask,
  MAX_TASKS_PER_CALL,
  taskDetail,
  taskTools,
} from "../src/openduet/tasks";
import { titleFrom } from "../src/openduet/task-store";

const INITIATOR = { kind: "person" } as const;

function tool(saved: { tasks: AskedTask[] }[] = []) {
  const [addTasks] = taskTools({
    actorId: "owner",
    botId: "openduet",
    initiator: INITIATOR,
    save: async (input) => {
      saved.push({ tasks: input.tasks });
      return input.tasks.map((task, index) => ({
        id: `task-${index}`,
        title: task.title,
      }));
    },
  });
  if (!addTasks) throw new Error("no tool");
  return addTasks;
}

const ROSA: AskedTask = {
  title: "Reply to Rosa about the glaze substitute",
  why: "Rosa needs a yes or no on Oat Satin by end of day to keep the slot.",
  next: "Decide between Oat Satin and waiting two weeks, then reply in her thread.",
  source: "Gmail",
  link: "https://mail.google.com/mail/u/0/#inbox/m-rosa",
};

describe(ADD_TASKS_TOOL, () => {
  test("saves each task for the person and the Bot, and says where they went", async () => {
    const saved: { tasks: AskedTask[] }[] = [];
    const result = JSON.parse(
      await tool(saved).execute({
        tasks: [
          ROSA,
          {
            title: "Book the kiln technician",
            why: "Kiln 2 is down.",
            next: "Call Dev.",
          },
        ],
      }),
    );
    expect(saved).toEqual([
      {
        tasks: [
          ROSA,
          {
            title: "Book the kiln technician",
            why: "Kiln 2 is down.",
            next: "Call Dev.",
          },
        ],
      },
    ]);
    expect(result.added.map((task: { title: string }) => task.title)).toEqual([
      ROSA.title,
      "Book the kiln technician",
    ]);
    expect(result.note).toContain("Tasks tab");
  });

  test("refuses a call it cannot turn into cards, and saves nothing", async () => {
    const saved: { tasks: AskedTask[] }[] = [];
    const addTasks = tool(saved);
    for (const args of [
      {},
      { tasks: [] },
      { tasks: [{ title: "No reason or step" }] },
      { tasks: [{ ...ROSA, link: "javascript:alert(1)" }] },
      { tasks: Array.from({ length: MAX_TASKS_PER_CALL + 1 }, () => ROSA) },
    ]) {
      expect(await addTasks.execute(args)).toStartWith("Refused.");
    }
    expect(saved).toEqual([]);
  });

  test("tells the Bot never to write a list to a file instead", () => {
    expect(tool().description).toContain("Never write a task list to a file");
  });

  test("the card reads the reason first, then the step", () => {
    expect(taskDetail(ROSA)).toBe(
      "Rosa needs a yes or no on Oat Satin by end of day to keep the slot.\n\nNext: Decide between Oat Satin and waiting two weeks, then reply in her thread.",
    );
  });
});

describe("titleFrom", () => {
  test("is the first sentence of the ask's first line, without its full stop", () => {
    expect(
      titleFrom("\n  Find a time for coffee with Sam.  \nHe prefers mornings."),
    ).toBe("Find a time for coffee with Sam");
    expect(
      titleFrom("Find a time for coffee with Sam. He prefers mornings."),
    ).toBe("Find a time for coffee with Sam");
    expect(titleFrom("Can you chase Rosa? She owes us a quote.")).toBe(
      "Can you chase Rosa?",
    );
    expect(titleFrom("Wait for it... then send")).toBe(
      "Wait for it... then send",
    );
    expect(titleFrom("Pay invoice no. 5521 today")).toBe(
      "Pay invoice no. 5521 today",
    );
    expect(titleFrom("Reply to   Rosa")).toBe("Reply to Rosa");
  });

  test("cuts a long line at a word, with an ellipsis", () => {
    const title = titleFrom(
      "Draft a reply to Rosa saying we will take Oat Satin instead of the discontinued gloss glaze for the spring order",
    );
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe(
      "Draft a reply to Rosa saying we will take Oat Satin instead of the discontinued…",
    );
  });
});
