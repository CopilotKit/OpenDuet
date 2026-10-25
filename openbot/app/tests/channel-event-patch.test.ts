import { describe, expect, test } from "bun:test";
import {
  CancelledError,
  InfiniteQueryObserver,
  QueryClient,
} from "@tanstack/react-query";
import {
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
} from "../src/lib/channels/queries";
import {
  applyChannelEvent,
  type ChannelActivityEvent,
  updateChannelEventCache,
} from "../src/lib/channels/use-channel-events";

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function cache(...pages: ChannelSummary[][]) {
  return {
    pages: pages.map(
      (channels): ChannelPage => ({ channels, nextCursor: null }),
    ),
    pageParams: pages.map(() => ""),
  };
}

function event(
  overrides: Partial<ChannelActivityEvent> & { channelId: string },
): ChannelActivityEvent {
  return {
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    ...overrides,
  };
}

describe("an ordinary activity event", () => {
  test("patches the row inside the page that holds it and re-sorts that page", () => {
    const data = cache([
      channel("a", { lastMessageAt: "2024-03-01T00:00:00.000Z" }),
      channel("b"),
    ]);

    const patched = applyChannelEvent(
      data,
      event({
        channelId: "b",
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["b", "a"]);
    expect(patched.pages[0]?.channels[0]?.lastMessage).toBe("Said something.");
  });

  test("is unknown when no page holds the channel, so the caller refetches", () => {
    expect(
      applyChannelEvent(cache([channel("a")]), event({ channelId: "z" })),
    ).toBe("unknown");
  });
});

/**
 * A channel somebody deleted in another tab, or on another replica.
 *
 * The tab that issued the delete moves itself; every other tab only ever hears about it here, so
 * without this the row stays on their roster until something else makes them refetch.
 */
describe("a deleted channel", () => {
  test("is removed from the page that held it", () => {
    const data = cache([channel("a"), channel("b")], [channel("c")]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "b", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["a"]);
    // The other page is untouched, object identity included, so its rows do not re-render.
    expect(patched.pages[1]).toBe(data.pages[1]);
  });

  test("is never spread onto the row instead of removing it", () => {
    const patched = applyChannelEvent(
      cache([channel("a")]),
      event({ channelId: "a", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    // The failure this guards is a row left on the roster carrying `deleted: true`, which renders
    // as an ordinary channel whose every query now 404s.
    expect(patched.pages[0]?.channels).toEqual([]);
  });

  test("changes nothing when this cache never had the channel", () => {
    const data = cache([channel("a")]);

    // Unlike an ordinary event, an unknown id here is not a stale roster: the channel is already
    // gone from this cache, so there is nothing to patch and nothing to refetch for.
    expect(
      applyChannelEvent(data, event({ channelId: "z", deleted: true })),
    ).toBe(data);
  });
});

/**
 * A pin this person made in one of their own tabs.
 *
 * Scoped to them by the server, so arriving here means it is the reader's own pin.
 */
describe("a pin", () => {
  test("patches only the pinned flag, leaving the last message alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", pinned: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      pinned: true,
    });
  });

  test("unpins the same way", () => {
    const patched = applyChannelEvent(
      cache([channel("a", { pinned: true })]),
      event({ channelId: "a", pinned: false }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]?.pinned).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { pinned: true })]);

    // A duplicate, or the tab that made the pin hearing its own event back. Identity preserved, so
    // React re-renders nothing at all.
    expect(
      applyChannelEvent(data, event({ channelId: "a", pinned: true })),
    ).toBe(data);
  });
});

/**
 * A busy signal: a turn started or ended in the channel.
 *
 * Server-side headless work — a handoff hop, a relay — that no browser streamed, surfaced on the
 * roster as a working indicator. Message-less on purpose: it must not disturb the preview or the
 * order the way an ordinary activity event does.
 */
describe("a busy signal", () => {
  test("aborts superseded roster transport before its next page", async () => {
    const queryClient = new QueryClient();
    const key = channelKeys.list();
    const oldPage = { channels: [channel("a")], nextCursor: "obsolete" };
    const busy = event({ channelId: "a", busy: true });
    const currentRow = channel("a", { busy: true });
    const currentPage = { channels: [currentRow], nextCursor: "current" };
    const lastPage = cache([channel("b")]).pages[0];
    const held = Promise.withResolvers<Response>();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const errors: unknown[] = [];
    let obsoleteSignal: AbortSignal | null | undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (requests.length === 1) {
          obsoleteSignal = init?.signal;
          return held.promise;
        }
        if (url !== "/api/channels" && url !== "/api/channels?cursor=current") {
          errors.push(new Error(`Unexpected request: ${url}`));
        }
        return Response.json(url === "/api/channels" ? currentPage : lastPage);
      },
      { preconnect: originalFetch.preconnect },
    );
    queryClient.setQueryData(key, cache([channel("a")], [channel("b")]));
    const observer = new InfiniteQueryObserver(queryClient, {
      ...channelListQueryOptions(),
      staleTime: Infinity,
      retry: false,
    });
    const unsubscribe = observer.subscribe((result) => {
      if (result.isError) errors.push(result.error);
    });
    try {
      const recovery = queryClient.invalidateQueries({ queryKey: key });
      const initiallyAborted = obsoleteSignal?.aborted;
      updateChannelEventCache(queryClient, busy);
      // Even a transport that completes after abort must not advance the obsolete cursor.
      held.resolve(Response.json(oldPage));
      await recovery;
      for (let turn = 0; turn < 20; turn++) await Bun.sleep(0);
      expect(initiallyAborted).toBe(false);
      expect(obsoleteSignal?.aborted).toBe(true);
      expect(requests).not.toContain("/api/channels?cursor=obsolete");
      expect(requests).toContain("/api/channels?cursor=current");
      expect(observer.getCurrentResult().isSuccess).toBe(true);
      expect(observer.getCurrentResult().isFetching).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
      queryClient.clear();
      held.resolve(Response.json(oldPage));
      await held.promise;
      await Bun.sleep(0);
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves a busy release received before the first roster response", async () => {
    const queryClient = new QueryClient();
    const key = channelKeys.list();
    const oldPage = cache([channel("a", { busy: true })]).pages[0]!;
    const currentPage = cache([channel("a", { busy: false })]).pages[0]!;
    const held = Promise.withResolvers<ChannelPage>();
    let response = held.promise;
    const errors: unknown[] = [];
    const observer = new InfiniteQueryObserver(queryClient, {
      ...channelListQueryOptions(),
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      queryFn: () => response,
    });
    const unsubscribe = observer.subscribe((result) => {
      if (result.isError) errors.push(result.error);
    });

    try {
      expect(queryClient.getQueryData(key)).toBeUndefined();
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching");
      // A corrective read sees the release that the held initial snapshot missed.
      response = Promise.resolve(currentPage);
      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", busy: false }),
      );
      held.resolve(oldPage);
      await held.promise;
      for (let turn = 0; turn < 20; turn++) {
        await Bun.sleep(0);
        if (queryClient.getQueryState(key)?.fetchStatus !== "fetching") break;
      }
      expect(
        observer.getCurrentResult().data?.find((row) => row.id === "a")?.busy,
      ).toBe(false);
      expect(queryClient.getQueryState(key)).toMatchObject({
        status: "success",
        fetchStatus: "idle",
      });
      expect(errors).toEqual([]);
    } finally {
      held.resolve(oldPage);
      unsubscribe();
      queryClient.clear();
    }
  });

  test("preserves active roster recovery when a busy event overlaps it", async () => {
    const queryClient = new QueryClient();
    const key = channelKeys.list();
    const seeded = cache([channel("a", { busy: true }), channel("b")]);
    const oldPage = cache([channel("a", { busy: true })]).pages[0]!;
    const currentPage = cache([channel("a", { busy: false })]).pages[0]!;
    const held = Promise.withResolvers<ChannelPage>();
    let response = held.promise;
    queryClient.setQueryData(key, seeded);
    const observer = new InfiniteQueryObserver(queryClient, {
      ...channelListQueryOptions(),
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      queryFn: () => response,
    });
    const unsubscribe = observer.subscribe(() => {});
    const recovery = queryClient.invalidateQueries(
      { queryKey: key },
      { throwOnError: true },
    );

    try {
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching");
      // Any replacement read observes the server after the release and B's deletion.
      response = Promise.resolve(currentPage);
      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", busy: false }),
      );
      held.resolve(oldPage);
      await held.promise;
      await recovery;
      for (let turn = 0; turn < 20; turn++) {
        await Bun.sleep(0);
        if (queryClient.getQueryState(key)?.fetchStatus !== "fetching") break;
      }
      const rows = queryClient
        .getQueryData<typeof seeded>(key)
        ?.pages.flatMap((page) => page.channels);
      expect(rows?.find((row) => row.id === "a")?.busy).toBe(false);
      expect(rows?.map((row) => row.id)).toEqual(["a"]);
      expect(queryClient.getQueryState(key)).toMatchObject({
        status: "success",
        fetchStatus: "idle",
      });
    } finally {
      held.resolve(oldPage);
      unsubscribe();
      queryClient.clear();
    }
  });

  test("an older roster read cannot undo a busy release event", async () => {
    const queryClient = new QueryClient();
    const key = channelKeys.list();
    const oldData = cache([channel("a", { busy: true })]);
    const held = Promise.withResolvers<ChannelPage>();
    queryClient.setQueryData(key, oldData);
    const earlierRead = queryClient
      .fetchInfiniteQuery({
        ...channelListQueryOptions(),
        queryFn: () => held.promise,
      })
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError)) throw error;
      });
    const currentRow = () =>
      queryClient.getQueryData<typeof oldData>(key)?.pages[0]?.channels[0];

    try {
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching");
      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", lastMessage: "A newer message." }),
      );
      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", busy: false }),
      );
      expect(currentRow()?.busy).toBe(false);
      expect(currentRow()?.lastMessage).toBe("A newer message.");

      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", busy: true }),
      );
      expect(currentRow()?.busy).toBe(true);
      updateChannelEventCache(
        queryClient,
        event({ channelId: "a", busy: false }),
      );
      expect(currentRow()?.busy).toBe(false);

      held.resolve(oldData.pages[0]!);
      await held.promise;
      await earlierRead;
      await Bun.sleep(0); // Let the cancelled read's underlying promise finish too.
      expect(currentRow()?.busy).toBe(false);
      expect(currentRow()?.lastMessage).toBe("A newer message.");
      expect(queryClient.getQueryState(key)).toMatchObject({
        status: "success",
        fetchStatus: "idle",
      });
    } finally {
      held.resolve(oldData.pages[0]!);
      queryClient.clear();
    }
  });

  test("patches only the busy flag, leaving the last message and order alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
      channel("b", { lastMessageAt: "2024-05-01T00:00:00.000Z" }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", busy: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    // Only `busy` changed on row a; its message survives, and b did not jump ahead of it.
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["a", "b"]);
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      busy: true,
    });
  });

  test("clears the same way", () => {
    const patched = applyChannelEvent(
      cache([channel("a", { busy: true })]),
      event({ channelId: "a", busy: false }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]?.busy).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { busy: true })]);

    expect(applyChannelEvent(data, event({ channelId: "a", busy: true }))).toBe(
      data,
    );
  });
});

/**
 * A conversation the server has just named.
 *
 * Written by a sweep some seconds after the message that prompted it, so it arrives on its own long
 * after that message was announced.
 */
describe("a summary", () => {
  test("patches only the summary, leaving the last message alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", summary: "Expense categories" }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      summary: "Expense categories",
    });
  });

  test("does not move the row it names", () => {
    // Naming a conversation is not something anybody said in it. A row that jumped to the top
    // seconds after the message that put it there would read as a second message arriving.
    const data = cache([
      channel("recent", { lastMessageAt: "2024-04-02T00:00:00.000Z" }),
      channel("older", { lastMessageAt: "2024-04-01T00:00:00.000Z" }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "older", summary: "Something older" }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual([
      "recent",
      "older",
    ]);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { summary: "Expense categories" })]);

    expect(
      applyChannelEvent(
        data,
        event({ channelId: "a", summary: "Expense categories" }),
      ),
    ).toBe(data);
  });
});
