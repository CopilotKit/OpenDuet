import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import { PageSheet } from "@/components/duet/page-sheet";
import type { ChecklistChange } from "@/lib/pages/mutations";
import { blockSchema } from "@/lib/pages/queries";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function checklist(text: string, checked = false) {
  return {
    type: "checklist",
    // IDs identify an item within its block, so another checklist can use the same ID.
    items: [{ id: "shared-item", text, checked }],
  };
}

const arrangements = [
  { name: "unknown prefix", prefix: [{ type: "future-block" }], suffix: [] },
  {
    name: "malformed prefix",
    prefix: [{ type: "heading", text: 42 }],
    suffix: [],
  },
  {
    name: "supported-only control",
    prefix: [{ type: "heading", text: "Plan" }],
    suffix: [],
  },
  { name: "unknown suffix", prefix: [], suffix: [{ type: "future-block" }] },
];
const changes = z
  .object({
    block: z.number().int().min(0),
    slide: z.number().int().min(0).optional(),
    item: z.string(),
    checked: z.boolean(),
    expectedChecklistRevision: z.string(),
  })
  .strict();

for (const kind of ["page", "slides"]) {
  for (const { name, prefix, suffix } of arrangements) {
    test(`${kind}: ${name} keeps checklist mutations at their persisted address`, async () => {
      const blocks: unknown[] = [
        ...prefix,
        checklist("Neighbor item"),
        checklist("Target item"),
        ...suffix,
      ];
      const slides = [
        { title: "Earlier slide", blocks: [checklist("Other slide item")] },
        { title: "Target slide", blocks },
      ];
      const saved = {
        id: "addresses",
        kind,
        title: "Checklist addresses",
        updatedAt: "2026-10-23T12:00:00Z",
        checklistRevision: "a".repeat(64),
        preview: { blocks: [] },
        content: kind === "slides" ? { slides } : { blocks },
      };
      const initial = structuredClone(saved);
      const requested: ChecklistChange[] = [];
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (String(input) === "/api/openduet/pages/addresses") {
            expect(init?.method ?? "GET").toBe("GET");
            return Response.json({ page: saved });
          }
          expect(String(input)).toBe("/api/openduet/pages/addresses/checklist");
          expect(init?.method).toBe("PATCH");
          const change = changes.parse(JSON.parse(String(init?.body)));
          requested.push(change);
          // The server addresses the original saved array, never the app's parsed/display array.
          const persisted =
            kind === "slides" ? slides[change.slide ?? -1]?.blocks : blocks;
          const block = blockSchema.safeParse(persisted?.[change.block]);
          if (!persisted || !block.success || block.data.type !== "checklist")
            return Response.json(
              { error: "Couldn't find that page." },
              { status: 404 },
            );
          const item = block.data.items.find((item) => item.id === change.item);
          if (!item)
            return Response.json(
              { error: "Couldn't find that page." },
              { status: 404 },
            );
          item.checked = change.checked;
          persisted[change.block] = block.data;
          return Response.json({ page: saved });
        },
        { preconnect: originalFetch.preconnect },
      );
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      clients.push(client);
      const view = render(
        <QueryClientProvider client={client}>
          <PageSheet pageId="addresses" onClose={() => {}} />
        </QueryClientProvider>,
      );
      await view.findByRole("dialog", { name: "Checklist addresses" });
      if (kind === "slides") {
        fireEvent.click(
          await view.findByRole("button", { name: "Next slide" }),
        );
      }
      const target = await view.findByRole("checkbox", {
        name: "Target item",
      });
      if (!(target instanceof HTMLInputElement))
        throw new Error("Target checkbox must be an input");
      fireEvent.click(target);
      await waitFor(() => expect(requested).toHaveLength(1));
      expect(blocks).toEqual([
        ...prefix,
        checklist("Neighbor item"),
        checklist("Target item", true),
        ...suffix,
      ]);
      expect(slides[0]?.blocks).toEqual([checklist("Other slide item")]);
      expect(requested[0]).toEqual({
        ...(kind === "slides" ? { slide: 1 } : {}),
        block: prefix.length + 1,
        item: "shared-item",
        checked: true,
        expectedChecklistRevision: saved.checklistRevision,
      });
      await waitFor(() => expect(target.checked).toBe(true));
      const neighbor = view.getByRole("checkbox", { name: "Neighbor item" });
      if (!(neighbor instanceof HTMLInputElement))
        throw new Error("Neighbor checkbox must be an input");
      expect(neighbor.checked).toBe(false);

      // A parsed mutation response must retain the same address for the next interaction.
      fireEvent.click(target);
      await waitFor(() => expect(requested).toHaveLength(2));
      expect(saved).toEqual(initial);
      expect(requested[1]).toEqual({ ...requested[0], checked: false });
      await waitFor(() => expect(target.checked).toBe(false));
    });
  }
}

for (const kind of ["page", "slides"] as const) {
  test(`${kind}: a stale checkbox reports a conflict and refreshes before another explicit click`, async () => {
    const blocks = [checklist("Target item"), checklist("Neighbor item")];
    const page = (revised: boolean) => ({
      id: "conflict",
      kind,
      title: "Changed checklist",
      updatedAt: revised ? "2026-10-23T12:01:00Z" : "2026-10-23T12:00:00Z",
      checklistRevision: (revised ? "b" : "a").repeat(64),
      preview: { blocks: [] },
      content:
        kind === "slides"
          ? {
              slides: [
                {
                  title: "Repair",
                  blocks: revised ? [...blocks].reverse() : blocks,
                },
              ],
            }
          : { blocks: revised ? [...blocks].reverse() : blocks },
    });
    let reads = 0;
    const requested: ChecklistChange[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) === "/api/openduet/pages/conflict") {
          reads += 1;
          return Response.json({ page: page(reads > 1) });
        }
        expect(String(input)).toBe("/api/openduet/pages/conflict/checklist");
        const change = changes.parse(JSON.parse(String(init?.body)));
        requested.push(change);
        if (change.expectedChecklistRevision !== "b".repeat(64)) {
          return Response.json(
            {
              error:
                "This page changed. Refresh it before checking that item again.",
            },
            { status: 409 },
          );
        }
        expect(change.block).toBe(1);
        const target = blocks[0]?.items[0];
        if (!target) throw new Error("Missing target");
        target.checked = change.checked;
        return Response.json({ page: page(true) });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        // A checklist conflict must never inherit retries configured for unrelated mutations.
        mutations: { retry: 2, retryDelay: 0 },
      },
    });
    clients.push(client);
    const view = render(
      <QueryClientProvider client={client}>
        <PageSheet pageId="conflict" onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(await view.findByRole("checkbox", { name: "Target item" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "This page changed.",
    );
    expect(requested).toEqual([
      {
        block: 0,
        ...(kind === "slides" ? { slide: 0 } : {}),
        item: "shared-item",
        checked: true,
        expectedChecklistRevision: "a".repeat(64),
      },
    ]);
    expect(blocks).toEqual([
      checklist("Target item"),
      checklist("Neighbor item"),
    ]);
    fireEvent.click(view.getByRole("button", { name: "Refresh page" }));
    await waitFor(() => expect(view.queryByRole("alert") === null).toBe(true));
    expect(reads).toBe(2);
    expect(requested).toHaveLength(1);
    fireEvent.click(view.getByRole("checkbox", { name: "Target item" }));
    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]).toEqual({
      ...requested[0],
      block: 1,
      expectedChecklistRevision: "b".repeat(64),
    });
    await waitFor(() => {
      const target = view.getByRole("checkbox", { name: "Target item" });
      if (!(target instanceof HTMLInputElement))
        throw new Error("Target checkbox must be an input");
      expect(target.checked).toBe(true);
    });
    const neighbor = view.getByRole("checkbox", { name: "Neighbor item" });
    if (!(neighbor instanceof HTMLInputElement))
      throw new Error("Neighbor checkbox must be an input");
    expect(neighbor.checked).toBe(false);
  });
}
