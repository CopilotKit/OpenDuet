import {
  keepPreviousData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ProactiveSetting = {
  id: string;
  agentId: string;
  channelId: string;
  focus: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "error";
  lastError: string | null;
};
export type ProactiveSuggestion = {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceLink: string | null;
  createdAt: string;
};

/**
 * Where a started suggestion stands, as the server decides it: working while its turn is queued or
 * running, needs input when it ended on something only the person can give, ready for review when
 * it finished with a reply to read, and failed when it couldn't finish. Failed is never ready.
 */
export type StartedState =
  | "working"
  | "needs_input"
  | "ready_for_review"
  | "failed";

/** A suggestion the person started, with where it stands and the conversation it runs in. */
export type StartedSuggestion = Pick<
  ProactiveSuggestion,
  "id" | "agentId" | "title" | "detail" | "sourceApp" | "sourceLink"
> & {
  startedAt: string;
  state: StartedState;
  /** The next step, one line: its reply's last sentence, its question, or why it failed. */
  next: string | null;
  /** The approval or question it stopped on, when the person's inbox lists that request too. */
  waitingOn: { kind: "approval" | "question"; id: string } | null;
  /** When the person checked it off. Null while it is still theirs to deal with. */
  resolvedAt: string | null;
  /** Whether Try again can run it: the server's verdict, false for a decision it couldn't carry out. */
  canRetry: boolean;
  /** When it last changed. */
  at: string;
  /** Where the turn runs and its reply lands: the research setting's conversation. */
  channelId: string;
};

/** Everything started and not checked off, the newest checked-off ones, and how many older. */
export type StartedList = {
  started: StartedSuggestion[];
  olderResolved: number;
};

/** How many checked-off tasks a list shows at first, and how many more each "Show more" adds. */
export const RESOLVED_PAGE = 20;

export const proactiveKeys = {
  settings: ["proactive", "settings"] as const,
  suggestions: ["proactive", "suggestions"] as const,
  started: ["proactive", "started"] as const,
  startedList: (resolvedLimit: number) =>
    ["proactive", "started", { resolvedLimit }] as const,
};

/**
 * How often to read what was started: every few seconds while one is still working, so it moves on
 * when its turn ends, and otherwise as the suggestions read.
 */
const STARTED_WORKING_POLL_MS = 5_000;

export const proactiveSettingsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.settings,
    queryFn: (): Promise<ProactiveSetting[]> =>
      client("/api/proactive/settings", "settings", {
        fallback: "Could not load background research",
      }),
    refetchInterval: 30_000,
  });
export const proactiveSuggestionsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.suggestions,
    queryFn: (): Promise<ProactiveSuggestion[]> =>
      client("/api/proactive/suggestions", "suggestions", {
        fallback: "Could not load suggestions",
      }),
    refetchInterval: 30_000,
  });

export const startedSuggestionsQueryOptions = (resolvedLimit = RESOLVED_PAGE) =>
  queryOptions({
    queryKey: proactiveKeys.startedList(resolvedLimit),
    // Showing more is the same list, longer: what is on screen stays while the rest arrives.
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<StartedList> =>
      (
        await client(`/api/proactive/started?resolved=${resolvedLimit}`, {
          fallback: "Could not load your tasks",
        })
      ).json(),
    refetchInterval: (query) =>
      query.state.data?.started.some(
        (item) => item.state === "working" && !item.resolvedAt,
      )
        ? STARTED_WORKING_POLL_MS
        : 30_000,
  });

/**
 * What the person started, by the section Tasks lists it under, each newest first by when it last
 * changed. Checked-off ones are resolved whatever they were. A failed one waits on the person, to
 * try it again or check it off, so it is listed with what needs input.
 */
export function startedSections(started: readonly StartedSuggestion[]) {
  const where = (keep: (item: StartedSuggestion) => boolean) =>
    started.filter(keep).sort((a, b) => b.at.localeCompare(a.at));
  const active = (state: StartedState) => (item: StartedSuggestion) =>
    !item.resolvedAt && item.state === state;
  return {
    ready: where(active("ready_for_review")),
    needsInput: where(
      (item) =>
        !item.resolvedAt &&
        (item.state === "needs_input" || item.state === "failed"),
    ),
    working: where(active("working")).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
    resolved: where((item) => Boolean(item.resolvedAt)),
  };
}

/**
 * What needs input, counted once each: the started tasks waiting on the person, and the approvals
 * and questions in their inbox that no started task is already waiting on. The tab's badge and
 * the Needs input heading both read this, so they never disagree.
 */
export function needsInputCount(
  inbox: { requests: { id: string }[]; questions: { id: string }[] },
  started: readonly StartedSuggestion[] | undefined,
): number {
  const tasks = startedSections(started ?? []).needsInput;
  const claimed = new Set(tasks.flatMap((item) => item.waitingOn?.id ?? []));
  const loose = [...inbox.requests, ...inbox.questions].filter(
    (request) => !claimed.has(request.id),
  );
  return tasks.length + loose.length;
}

/** Check a started task off, or put it back. */
export const resolveStartedMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      client(
        `/api/proactive/started/${encodeURIComponent(id)}/${resolved ? "resolve" : "reopen"}`,
        {
          method: "POST",
          fallback: resolved
            ? "Couldn't check this off. Try again."
            : "Couldn't put this back. Try again.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: proactiveKeys.started }),
  });

/** Run a failed task's turn again. */
export const retryStartedMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) =>
      client(`/api/proactive/started/${encodeURIComponent(id)}/retry`, {
        method: "POST",
        fallback: "Couldn't try this again. Try once more in a moment.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: proactiveKeys.started }),
  });

export const createProactiveSetting = (input: {
  agentId: string;
  channelId: string;
  focus: string;
  intervalMinutes: number;
}) =>
  client("/api/proactive/settings", {
    method: "POST",
    body: input,
    fallback: "Could not turn on background research",
  });
export const updateProactiveSetting = (
  id: string,
  input: { enabled?: boolean; intervalMinutes?: number; focus?: string },
) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "Could not change background research",
  });
export const runProactiveNow = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}/run`, {
    method: "POST",
    fallback: "Could not start background research",
  });
export const removeProactiveSetting = (id: string) =>
  client(`/api/proactive/settings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not remove background research",
  });
export const resolveSuggestion = (id: string, action: "start" | "dismiss") =>
  client(`/api/proactive/suggestions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    fallback:
      action === "start"
        ? "Could not start this suggestion"
        : "Could not dismiss this suggestion",
  });

/**
 * A setting's research produces suggestions, and starting one adds to what was started, so a
 * change to any of them refreshes all three.
 */
const settleProactive = (queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.started }),
  ]);

/** Start a suggested next step as a task, or dismiss it. */
export const resolveSuggestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: settleProactive(queryClient),
  });

export const createProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createProactiveSetting,
    onSuccess: settleProactive(queryClient),
  });

/** How often research runs when one button turns it on: every four hours, as when OpenBot does. */
export const DEFAULT_RESEARCH_INTERVAL_MINUTES = 240;

/**
 * Turn a Bot's background research on from one button.
 *
 * A setting the person turned off comes back on as it was. Without one, a new one is made in the
 * conversation `channelId` resolves to. That is only asked for here, because finding or starting the
 * conversation is work a setting that already exists does not need.
 */
export const turnOnResearchMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async (input: {
      setting: Pick<ProactiveSetting, "id"> | undefined;
      agentId: string;
      focus: string;
      channelId: () => Promise<string>;
    }) =>
      input.setting
        ? updateProactiveSetting(input.setting.id, { enabled: true })
        : createProactiveSetting({
            agentId: input.agentId,
            channelId: await input.channelId(),
            focus: input.focus,
            intervalMinutes: DEFAULT_RESEARCH_INTERVAL_MINUTES,
          }),
    onSuccess: settleProactive(queryClient),
  });

/** What can be done to one background-research setting from its row. */
export type ProactiveChange =
  | { kind: "toggle" }
  | { kind: "run" }
  | { kind: "remove" }
  | { kind: "interval"; minutes: number };

export const changeProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({
      setting,
      change,
    }: {
      setting: Pick<ProactiveSetting, "id" | "enabled">;
      change: ProactiveChange;
    }) =>
      change.kind === "run"
        ? runProactiveNow(setting.id)
        : change.kind === "remove"
          ? removeProactiveSetting(setting.id)
          : updateProactiveSetting(
              setting.id,
              change.kind === "toggle"
                ? { enabled: !setting.enabled }
                : { intervalMinutes: change.minutes },
            ),
    onSuccess: settleProactive(queryClient),
  });
