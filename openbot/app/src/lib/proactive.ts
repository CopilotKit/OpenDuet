import {
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
 * How the turn a started suggestion asked for stands: waiting for the next sweep, running, done, or
 * given up on. A started suggestion gets one attempt, so a failed one stays failed.
 */
export type StartedRun = "queued" | "running" | "finished" | "failed";

/** A suggestion the person started, with how its turn stands and the conversation it runs in. */
export type StartedSuggestion = Pick<
  ProactiveSuggestion,
  "id" | "agentId" | "title" | "detail" | "sourceApp" | "sourceLink"
> & {
  startedAt: string;
  run: StartedRun;
  /** When the run last changed: started, finished, or gave up. */
  at: string;
  /** Why it gave up, when it did. */
  error: string | null;
  /** Where the turn runs and its reply lands: the research setting's conversation. */
  channelId: string;
};

export const proactiveKeys = {
  settings: ["proactive", "settings"] as const,
  suggestions: ["proactive", "suggestions"] as const,
  started: ["proactive", "started"] as const,
};

/** Started and not yet ended: queued for the next sweep, or running. */
export const stillWorking = (item: Pick<StartedSuggestion, "run">) =>
  item.run === "queued" || item.run === "running";

/**
 * How often to read what was started: every few seconds while one is still working, so it reaches
 * Ready for review when its turn ends, and otherwise as the suggestions read.
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

export const startedSuggestionsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.started,
    queryFn: (): Promise<StartedSuggestion[]> =>
      client("/api/proactive/started", "started", {
        fallback: "Could not load what you started",
      }),
    refetchInterval: (query) =>
      query.state.data?.some(stillWorking) ? STARTED_WORKING_POLL_MS : 30_000,
  });

/**
 * What the person started, by where Tasks lists it: Working on while its turn is queued or running,
 * Ready for review once it finished, and Done, as not finished, when it gave up. A failed turn is
 * never Ready for review. Each list is newest first by when it last changed.
 */
export function startedByState(started: readonly StartedSuggestion[]) {
  const newest = (items: StartedSuggestion[]) =>
    items.sort((a, b) => b.at.localeCompare(a.at));
  return {
    working: newest(started.filter(stillWorking)),
    ready: newest(started.filter((item) => item.run === "finished")),
    failed: newest(started.filter((item) => item.run === "failed")),
  };
}

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
