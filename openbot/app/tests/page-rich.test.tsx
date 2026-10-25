import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PageCard } from "@/components/duet/page-card";
import { PageSheet } from "@/components/duet/page-sheet";
import { PageBlocks, SlideCard } from "@/components/duet/page-view";
import { filterPages, MAKE_KINDS } from "@/components/shell/make-screen";
import { type PageBlock, type PageRecord, pageKeys } from "@/lib/pages/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const thumbnail =
  '<svg viewBox="0 0 320 180"><text x="10" y="40" fill="var(--duet-ink)">$528K</text></svg>';
function page(): PageRecord {
  return {
    checklistRevision: "a".repeat(64),
    id: "plan-1",
    botId: "bot-1",
    kind: "doc",
    title: "Kiln plan",
    theme: "earth",
    summary: null,
    updatedAt: "2026-10-23T12:00:00Z",
    slideCount: 0,
    thumbnail,
    preview: { blocks: [] },
    content: {
      blocks: [
        {
          type: "checklist",
          items: [{ id: "coils", text: "Check coils", checked: false }],
        },
      ],
    },
  };
}

test("the six stored kinds filter independently and content SVG replaces the fallback preview", () => {
  const pages = MAKE_KINDS.map((kind) => ({
    ...page(),
    id: kind.id,
    kind: kind.id,
  }));
  expect(new Set(pages.map((page) => page.kind)).size).toBe(6);
  for (const kind of MAKE_KINDS)
    expect(filterPages(pages, kind.id).map((page) => page.id)).toEqual([
      kind.id,
    ]);
  const view = render(
    <PageCard
      page={page()}
      size="grid"
      link={({ children }) => <a href="/make/plan-1">{children}</a>}
    />,
  );
  expect(
    view.container.querySelector("[data-preview] svg text")?.textContent,
  ).toBe("$528K");
  view.rerender(
    <PageCard
      page={{ ...page(), thumbnail: '<svg onload="bad()"/>' }}
      size="grid"
      link={({ children }) => <a href="/make/plan-1">{children}</a>}
    />,
  );
  expect(view.container.querySelector("[data-preview] svg")).toBeNull();
  expect(view.container.textContent).toContain("Kiln plan");
});

test("all rich blocks render and a checklist sends the exact item state", () => {
  const checked: unknown[] = [];
  const view = render(
    <PageBlocks
      blocks={[
        {
          type: "timeline",
          items: [
            {
              date: "October 25",
              title: "Repair kiln",
              text: "Inspect the coil.",
            },
          ],
        },
        {
          type: "decision",
          question: "Repair or replace?",
          options: [
            { title: "Repair", pros: ["Cheaper"], cons: ["Short warranty"] },
            { title: "Replace", pros: ["Lasts longer"], cons: ["More money"] },
          ],
          pick: "Repair",
        },
        {
          type: "checklist",
          items: [{ id: "coils", text: "Check coils", checked: false }],
        },
        { type: "table", columns: ["Item", "Cost"], rows: [["Coil", "$45"]] },
        {
          type: "comparison",
          columns: [
            { title: "Today", items: ["Repair"] },
            { title: "Next month", items: ["Replace"] },
          ],
        },
        { type: "image", alt: "Wholesale orders", svg: thumbnail },
      ]}
      onCheck={(...args) => checked.push(args)}
    />,
  );
  expect(view.getByText("October 25")).toBeTruthy();
  expect(view.getByText("Pick: Repair")).toBeTruthy();
  expect(view.getByRole("columnheader", { name: "Item" }).className).toContain(
    "sticky left-0",
  );
  expect(view.getByRole("img", { name: "Wholesale orders" })).toBeTruthy();
  fireEvent.click(view.getByRole("checkbox", { name: "Check coils" }));
  expect(checked).toEqual([[2, "coils", true]]);
});

test.each(["page", "legacy-v1", "current-v2"] as const)(
  "decision options preserve their exact content after a duplicate-title reorder in %s",
  (surface) => {
    type Decision = Extract<PageBlock, { type: "decision" }>;
    const first = { title: "A", pros: ["First benefit"], cons: ["First cost"] };
    const second = {
      title: "A",
      pros: ["Second benefit"],
      cons: ["Second cost"],
    };
    const third = { title: "B", pros: ["Third benefit"], cons: ["Third cost"] };
    const decision = (options: Decision["options"]) => {
      const blocks: Decision[] = [
        { type: "decision", question: "Choose", options },
      ];
      return surface === "page" ? (
        <PageBlocks blocks={blocks} />
      ) : (
        <SlideCard
          layoutVersion={surface === "legacy-v1" ? 1 : 2}
          slide={{ title: "Options", blocks }}
        />
      );
    };
    const view = render(decision([first, second, third]));
    const visibleOptions = () =>
      view.getAllByRole("heading", { level: 4 }).map((heading) => ({
        title: heading.textContent,
        details: Array.from(
          heading.parentElement!.querySelectorAll("p"),
          (p) => p.textContent,
        ),
      }));
    expect(visibleOptions()).toEqual([
      { title: "A", details: ["+First benefit", "−First cost"] },
      { title: "A", details: ["+Second benefit", "−Second cost"] },
      { title: "B", details: ["+Third benefit", "−Third cost"] },
    ]);

    view.rerender(decision([third, second]));
    expect(visibleOptions()).toEqual([
      { title: "B", details: ["+Third benefit", "−Third cost"] },
      { title: "A", details: ["+Second benefit", "−Second cost"] },
    ]);
  },
);

test.each(["row", "grid"] as const)(
  "%s comparison previews preserve the exact column sequence after duplicate-title reorder",
  (size) => {
    const comparison = (titles: string[]) => (
      <PageCard
        page={{
          ...page(),
          thumbnail: null,
          preview: {
            blocks: [
              {
                type: "comparison",
                columns: titles.map((title) => ({
                  title,
                  items: ["Column detail"],
                })),
              },
            ],
          },
        }}
        size={size}
        link={({ children }) => <a href="/make/plan-1">{children}</a>}
      />
    );
    const view = render(comparison(["A", "A", "B"]));
    const visibleColumns = () =>
      Array.from(
        view.container.querySelectorAll("[data-preview] span"),
        (column) => column.textContent,
      );
    expect(visibleColumns()).toEqual(["A", "A", "B"]);

    view.rerender(comparison(["B", "A"]));
    expect(visibleColumns()).toEqual(["B", "A"]);
  },
);

test("full-page actions copy a link, prefill revision, start a task, and delete; checklist reloads checked", async () => {
  let saved = page();
  let detailGets = 0;
  const requests: { url: string; method: string; body: unknown }[] = [];
  const deleted = Promise.withResolvers<Response>();
  let closed = 0;
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method)
      requests.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
    if (url.endsWith("/checklist")) {
      saved = {
        ...saved,
        content: {
          blocks: [
            {
              type: "checklist",
              items: [{ id: "coils", text: "Check coils", checked: true }],
            },
          ],
        },
      };
      return Response.json({ page: saved });
    }
    if (url === "/api/openduet/pages/plan-1" && init?.method === "DELETE")
      return deleted.promise;
    if (url === "/api/openduet/pages/plan-1") {
      expect(init?.method ?? "GET").toBe("GET");
      detailGets++;
      return Response.json({ page: saved });
    }
    if (url === "/api/openduet/pages") return Response.json({ pages: [saved] });
    if (url === "/api/openduet/tasks" && init?.method === "POST")
      return Response.json({ task: { id: "task-1" } });
    if (url.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "bot-1", name: "Bot" }] });
    return Response.json({});
  }) as typeof fetch;
  const pageSheet = (
    <QueryClientProvider client={queryClient}>
      <PageSheet
        pageId="plan-1"
        onClose={() => {
          closed++;
        }}
      />
    </QueryClientProvider>
  );
  const view = render(pageSheet);
  let sheet = await view.findByRole("dialog", { name: "Kiln plan" });
  expect(
    within(sheet).getByRole("button", { name: "Back" }).closest("header")
      ?.className,
  ).toContain("grid-cols-[auto_1fr_auto]");
  fireEvent.click(within(sheet).getByRole("checkbox", { name: "Check coils" }));
  await waitFor(() =>
    expect(within(sheet).getByRole<HTMLInputElement>("checkbox").checked).toBe(
      true,
    ),
  );
  expect(requests[0]?.body).toEqual({
    block: 0,
    item: "coils",
    checked: true,
    expectedChecklistRevision: page().checklistRevision,
  });
  expect(detailGets).toBe(1);
  // Reopen without the mutation's cached result or the original mounted observer.
  view.rerender(null);
  queryClient.removeQueries({ queryKey: pageKeys.detail("plan-1") });
  view.rerender(pageSheet);
  await waitFor(() => expect(detailGets).toBe(2));
  sheet = await view.findByRole("dialog", { name: "Kiln plan" });
  expect(
    within(sheet).getByRole<HTMLInputElement>("checkbox", {
      name: "Check coils",
    }).checked,
  ).toBe(true);
  fireEvent.click(within(sheet).getByRole("button", { name: "Page actions" }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(copied).toBe("http://localhost:3010/make/plan-1"));
  fireEvent.click(within(sheet).getByRole("button", { name: "Page actions" }));
  await waitFor(() =>
    expect(
      within(sheet)
        .getByRole("button", { name: "Revise" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(within(sheet).getByRole("button", { name: "Revise" }));
  const revise = await view.findByRole("dialog", {
    name: "What should change?",
  });
  expect(
    (within(revise).getByRole("textbox") as HTMLTextAreaElement).value,
  ).toContain("Revise “Kiln plan”: …");
  fireEvent.click(within(revise).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "What should change?" }),
    ).toBeNull(),
  );
  fireEvent.click(within(sheet).getByRole("button", { name: "Page actions" }));
  fireEvent.click(
    within(sheet).getByRole("button", { name: "Turn into a task" }),
  );
  await waitFor(() => expect(closed).toBe(1));
  expect(
    requests.find((request) => request.url === "/api/openduet/tasks")?.body,
  ).toEqual({
    botId: "bot-1",
    instruction:
      "Read saved page plan-1 with read_page, then carry out the plan in “Kiln plan”. Ask before any external action that needs approval.",
  });
  fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      { url: "/api/openduet/pages/plan-1", method: "DELETE", body: null },
    ]),
  );
  expect(closed).toBe(1);
  deleted.resolve(new Response(null, { status: 204 }));
  await waitFor(() => expect(closed).toBe(2));
});
