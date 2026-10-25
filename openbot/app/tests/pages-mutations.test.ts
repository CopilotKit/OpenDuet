import { afterEach, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  type ChecklistChange,
  checkPageMutationOptions,
  deletePageMutationOptions,
} from "@/lib/pages/mutations";
import {
  type PageRecord,
  pageKeys,
  pageQueryOptions,
  pageRecordSchema,
} from "@/lib/pages/queries";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) client.clear();
});

function page(id: string, a = false, b = false): PageRecord {
  return pageRecordSchema.parse({
    checklistRevision: "a".repeat(64),
    id,
    kind: "page",
    title: "Checklist",
    summary: null,
    updatedAt: "2026-10-23T12:00:00Z",
    slideCount: 0,
    preview: { blocks: [] },
    content: {
      blocks: [
        {
          type: "checklist",
          items: [
            { id: "a", text: "A", checked: a },
            { id: "b", text: "B", checked: b },
          ],
        },
      ],
    },
  });
}

function checking(
  respond: (id: string, change: ChecklistChange) => Promise<Response>,
  read?: (id: string) => Promise<Response>,
  remove?: (id: string) => Promise<Response>,
) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  clients.push(client);
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const match = /^\/api\/openduet\/pages\/([^/]+)(\/checklist)?$/.exec(
        String(input),
      );
      if (!match?.[1]) throw new Error(`Unexpected request: ${input}`);
      expect(init?.credentials).toBe("include");
      if (!match[2]) {
        if (init?.method === "DELETE") {
          if (!remove) throw new Error(`Unexpected page delete: ${input}`);
          return remove(decodeURIComponent(match[1]));
        }
        expect(init?.method ?? "GET").toBe("GET");
        if (!read) throw new Error(`Unexpected page read: ${input}`);
        return read(decodeURIComponent(match[1]));
      }
      expect(init?.method).toBe("PATCH");
      return respond(
        decodeURIComponent(match[1]),
        JSON.parse(String(init?.body)),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    client,
    // Separate observers also cover closing and reopening a page while a save is pending.
    mutate: (id: string, item: string) =>
      new MutationObserver(client, checkPageMutationOptions(client, id)).mutate(
        {
          block: 0,
          expectedChecklistRevision: "a".repeat(64),
          item,
          checked: true,
        },
      ),
  };
}

test("a slow earlier checklist response cannot roll back a later saved item", async () => {
  const earlier = Promise.withResolvers<Response>();
  const later = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const firstSaved = {
    ...page("plan", true),
    updatedAt: "2026-10-23T12:00:01.000Z",
  };
  const secondSaved = {
    ...page("plan", true, true),
    updatedAt: "2026-10-23T12:00:02.000Z",
  };
  const requestedItems: string[] = [];
  const { client, mutate } = checking(async (_id, change) => {
    requestedItems.push(change.item);
    if (change.item === "a") {
      started.resolve();
      return earlier.promise;
    }
    return later.promise;
  });
  client.setQueryData(pageKeys.detail("plan"), page("plan"));
  client.setQueryData(pageKeys.list, [page("plan")]);

  const first = mutate("plan", "a");
  await started.promise;
  const second = mutate("plan", "b");
  const both = Promise.all([first, second]);
  // If requests overlap, B's A+B snapshot arrives first and A's A-only snapshot arrives last.
  // Drain that ready response before releasing A; serialized requests cannot start B yet.
  later.resolve(Response.json({ page: secondSaved }));
  await setImmediate();
  const requestedBeforeFirstFinished = [...requestedItems];
  earlier.resolve(Response.json({ page: firstSaved }));
  await both;

  expect(requestedBeforeFirstFinished).toEqual(["a"]);
  expect(requestedItems).toEqual(["a", "b"]);
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    secondSaved,
  );
  expect(client.getQueryState(pageKeys.list)?.isInvalidated).toBe(true);
});

test("an older checklist response cannot replace a newer completed detail read", async () => {
  const saved = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  const saving = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const checked = {
    ...page("plan", true),
    updatedAt: "2026-10-23T12:00:01.000Z",
  };
  const revised = {
    ...page("plan", true, true),
    title: "Revised checklist",
    updatedAt: "2026-10-23T12:00:02.000Z",
    checklistRevision: "b".repeat(64),
  };
  const { client, mutate } = checking(
    async () => {
      saving.resolve();
      return saved.promise;
    },
    async () => {
      reading.resolve();
      return fresh.promise;
    },
  );
  client.setQueryData(pageKeys.detail("plan"), page("plan"));
  client.setQueryData(pageKeys.list, [page("plan")]);

  const mutation = mutate("plan", "a");
  await saving.promise;
  const detail = client.fetchQuery(pageQueryOptions("plan"));
  await reading.promise;
  fresh.resolve(Response.json({ page: revised }));
  expect(await detail).toEqual(revised);
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    revised,
  );

  saved.resolve(Response.json({ page: checked }));
  expect(await mutation).toEqual(checked);
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    revised,
  );
  expect(client.getQueryState(pageKeys.list)?.isInvalidated).toBe(true);
});

test("deleting a page after a checklist save keeps its detail cache removed", async () => {
  const saved = Promise.withResolvers<Response>();
  const saving = Promise.withResolvers<void>();
  const methods: string[] = [];
  const { client, mutate } = checking(
    async () => {
      methods.push("PATCH");
      saving.resolve();
      return saved.promise;
    },
    async () => {
      methods.push("GET");
      return Response.json(
        { error: "Couldn't find that page." },
        { status: 404 },
      );
    },
    async () => {
      methods.push("DELETE");
      return new Response(null, { status: 204 });
    },
  );
  client.setQueryData(pageKeys.detail("plan"), page("plan"));
  client.setQueryData(pageKeys.list, [page("plan")]);

  // The server saved the check, but its successful response is still in flight.
  const mutation = mutate("plan", "a");
  await saving.promise;
  const deletion = new MutationObserver(
    client,
    deletePageMutationOptions(client, "plan"),
  ).mutate();
  await setImmediate();
  const requestedBeforeSaveFinished = [...methods];
  saved.resolve(Response.json({ page: page("plan", true) }));
  await Promise.all([mutation, deletion]);

  expect(client.getQueryData(pageKeys.detail("plan"))).toBeUndefined();
  expect(requestedBeforeSaveFinished).toEqual(["PATCH"]);
  expect(client.getQueryState(pageKeys.list)?.isInvalidated).toBe(true);
  // Reopening the deleted page must not retain any saved content after its 404.
  await expect(client.fetchQuery(pageQueryOptions("plan"))).rejects.toThrow(
    "Couldn't find that page.",
  );
  expect(client.getQueryData(pageKeys.detail("plan"))).toBeUndefined();
  expect(methods).toEqual(["PATCH", "DELETE", "GET"]);
});

test.each(["before", "during"])(
  "a stale detail read started %s a checklist save cannot roll it back",
  async (when) => {
    const stale = Promise.withResolvers<Response>();
    const saved = Promise.withResolvers<Response>();
    const saving = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const { client, mutate } = checking(
      async () => {
        saving.resolve();
        return saved.promise;
      },
      async () => {
        reading.resolve();
        return stale.promise;
      },
    );
    client.setQueryData(pageKeys.detail("plan"), page("plan"));
    let detailSettled = false;
    const read = () =>
      client.fetchQuery(pageQueryOptions("plan")).finally(() => {
        detailSettled = true;
      });
    const before = when === "before" ? read() : undefined;
    if (before) await reading.promise;
    const mutation = mutate("plan", "a");
    await saving.promise;
    const detail = before ?? read();
    await reading.promise;

    saved.resolve(Response.json({ page: page("plan", true) }));
    await mutation;
    expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
      page("plan", true),
    );
    // A canceled read with cached data settles before its HTTP response arrives.
    const settledBeforeResponse = detailSettled;
    stale.resolve(Response.json({ page: page("plan") }));
    await detail;
    // The HTTP response can still arrive even after its query was canceled.
    await setImmediate();

    expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
      page("plan", true),
    );
    expect(settledBeforeResponse).toBe(true);
    expect(client.getQueryState(pageKeys.detail("plan"))).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      error: null,
    });
  },
);

test("a stale detail response between serialized saves preserves the first save", async () => {
  const stale = Promise.withResolvers<Response>();
  const earlier = Promise.withResolvers<Response>();
  const later = Promise.withResolvers<Response>();
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const { client, mutate } = checking(
    async (_id, change) => {
      if (change.item === "a") {
        firstStarted.resolve();
        return earlier.promise;
      }
      secondStarted.resolve();
      return later.promise;
    },
    async () => {
      reading.resolve();
      return stale.promise;
    },
  );
  client.setQueryData(pageKeys.detail("plan"), page("plan"));
  const first = mutate("plan", "a");
  await firstStarted.promise;
  const second = mutate("plan", "b");
  let detailSettled = false;
  const detail = client.fetchQuery(pageQueryOptions("plan")).finally(() => {
    detailSettled = true;
  });
  await reading.promise;
  earlier.resolve(Response.json({ page: page("plan", true) }));
  await first;
  await secondStarted.promise;
  try {
    const settledBeforeResponse = detailSettled;
    stale.resolve(Response.json({ page: page("plan") }));
    await detail;
    await setImmediate();
    expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
      page("plan", true),
    );
    expect(settledBeforeResponse).toBe(true);
    expect(client.getQueryState(pageKeys.detail("plan"))).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      error: null,
    });
  } finally {
    later.resolve(Response.json({ page: page("plan", true, true) }));
    await second;
  }
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    page("plan", true, true),
  );
});

test("a fresh detail read after a checklist save can update the page", async () => {
  const held = Promise.withResolvers<Response>();
  const reading = Promise.withResolvers<void>();
  const fresh = {
    ...page("plan", true, true),
    title: "Revised checklist",
    updatedAt: "2026-10-23T12:01:00Z",
  };
  const { client, mutate } = checking(
    async () => Response.json({ page: page("plan", true) }),
    async () => {
      reading.resolve();
      return held.promise;
    },
  );
  client.setQueryData(pageKeys.detail("plan"), page("plan"));

  await mutate("plan", "a");
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    page("plan", true),
  );
  const detail = client.fetchQuery(pageQueryOptions("plan"));
  await reading.promise;
  expect(client.getQueryState(pageKeys.detail("plan"))?.fetchStatus).toBe(
    "fetching",
  );
  held.resolve(Response.json({ page: fresh }));
  expect(await detail).toEqual(fresh);
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    fresh,
  );
  expect(client.getQueryState(pageKeys.detail("plan"))).toMatchObject({
    status: "success",
    fetchStatus: "idle",
    error: null,
  });
});

test("a checklist save leaves another page's detail read running", async () => {
  const held = Promise.withResolvers<Response>();
  const reading = Promise.withResolvers<void>();
  const { client, mutate } = checking(
    async (id) => Response.json({ page: page(id, true) }),
    async () => {
      reading.resolve();
      return held.promise;
    },
  );
  client.setQueryData(pageKeys.detail("other"), page("other"));
  const detail = client.fetchQuery(pageQueryOptions("other"));
  await reading.promise;
  await mutate("plan", "a");
  expect(client.getQueryState(pageKeys.detail("other"))?.fetchStatus).toBe(
    "fetching",
  );
  held.resolve(Response.json({ page: page("other", true, true) }));
  expect(await detail).toEqual(page("other", true, true));
  expect(client.getQueryData<PageRecord>(pageKeys.detail("other"))).toEqual(
    page("other", true, true),
  );
});

test("a pending checklist save does not hold up another page", async () => {
  const held = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const { client, mutate } = checking(async (id) => {
    if (id === "first") {
      started.resolve();
      return held.promise;
    }
    return Response.json({ page: page(id, true) });
  });

  client.setQueryData(pageKeys.detail("first"), page("first"));
  const first = mutate("first", "a");
  await started.promise;
  // Closing the sheet can let its detail entry be collected while the save is pending.
  client.removeQueries({ queryKey: pageKeys.detail("first"), exact: true });
  try {
    await mutate("other", "a");
    expect(client.getQueryData<PageRecord>(pageKeys.detail("other"))).toEqual(
      page("other", true),
    );
    expect(
      client.getQueryData<PageRecord>(pageKeys.detail("first")),
    ).toBeUndefined();
  } finally {
    held.resolve(Response.json({ page: page("first", true) }));
    await first;
  }
  expect(client.getQueryData<PageRecord>(pageKeys.detail("first"))).toEqual(
    page("first", true),
  );
});

test("a failed checklist save reports its error and lets the next save finish", async () => {
  const failed = Promise.withResolvers<Response>();
  const next = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const { client, mutate } = checking(async (_id, change) => {
    if (change.item === "a") {
      started.resolve();
      return failed.promise;
    }
    return next.promise;
  });
  client.setQueryData(pageKeys.detail("plan"), page("plan"));

  const refusal = mutate("plan", "a").catch((error: unknown) => error);
  await started.promise;
  const second = mutate("plan", "b");
  failed.resolve(new Response(null, { status: 500 }));
  expect(await refusal).toEqual(
    new Error("Couldn't save that check. Try again."),
  );
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    page("plan"),
  );
  next.resolve(Response.json({ page: page("plan", false, true) }));
  await second;
  expect(client.getQueryData<PageRecord>(pageKeys.detail("plan"))).toEqual(
    page("plan", false, true),
  );
});
