import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { ActivityScreen } from "@/components/shell/activity-screen";
import { agentKeys } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/** The Activity tab: what the product's own Bot did, read from the ledgers OpenBot keeps. */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let activity: Record<string, unknown> = {};
let requests: unknown[] = [];
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/bots/openduet/activity")
      return Response.json({ activity });
    if (url === "/api/approvals")
      return Response.json({ requests, questions: [] });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw() {
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
  ]);
  const router = createRouter({
    routeTree: createRootRoute({ component: ActivityScreen }),
    history: createMemoryHistory({ initialEntries: ["/activity"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const item = (overrides: Record<string, unknown>) => ({
  id: "x",
  kind: "follow_up",
  title: "Review the launch deck",
  detail: null,
  status: "done",
  at: "2026-10-21T14:59:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...overrides,
});

test("with nothing done yet it says what will appear", async () => {
  activity = { inProgress: [], scheduled: [], completed: [] };
  requests = [];
  serving();
  const view = draw();
  expect(await view.findByText("Nothing yet.")).toBeTruthy();
});

test("finished work and answered actions are listed under Handled for you", async () => {
  activity = {
    inProgress: [],
    scheduled: [
      item({ id: "later", title: "Morning brief", status: "scheduled" }),
    ],
    completed: [
      item({ id: "done", status: "done" }),
      item({
        id: "broke",
        kind: "routine",
        title: "Tidy inbox",
        status: "failed",
      }),
    ],
  };
  requests = [
    {
      id: "r",
      status: "completed",
      createdAt: "2026-10-21T14:58:00Z",
      decidedAt: "2026-10-21T14:59:00Z",
      decision: "allow_once",
      action: {
        botId: "openduet",
        toolRef: "gmail/GMAIL_SEND_EMAIL",
        effect: "write",
        scope: "ana@example.com",
        threadId: "t",
        args: {},
        target: {},
        policy: { behaviour: "ask", source: "rule", reason: "Asked." },
      },
    },
  ];
  serving();
  const view = draw();
  const handled = await view.findByRole("region", { name: "Handled for you" });
  const text = handled.textContent ?? "";
  expect(text).toContain("Review the launch deck");
  expect(text).toContain("Follow-up · Done");
  expect(text).toContain("Tidy inbox");
  expect(text).toContain("Didn't finish");
  expect(text).toContain("Send email");
  expect(text).toContain("Allowed once by you");
  const upcoming = view.getByRole("region", { name: "Coming up" });
  expect(within(upcoming).getByText("Morning brief")).toBeTruthy();
});
