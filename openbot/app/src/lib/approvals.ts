import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { taskKeys } from "@/lib/tasks/queries";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & { id: string };
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
/** One action a Bot asked to take, as the inbox returns it: waiting, decided, or done. */
export type ApprovalRequest = {
  id: string;
  status: string;
  createdAt: string;
  action: {
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    threadId: string;
    toolCallId?: string;
    args: unknown;
    target: unknown;
    policy?: {
      behaviour: "allow" | "ask" | "hand_off" | "deny";
      source: string;
      reason: string;
    };
  };
  /** What the person chose, once they did. */
  decision?: ApprovalDecision | null;
  /** ISO-8601, when they chose. */
  decidedAt?: string | null;
  /** ISO-8601, when the action finished running. */
  completedAt?: string | null;
  /** How running it went; the content stays on the server. */
  result?: { error?: string } | null;
};
export type ApprovalInboxData = {
  enabled: boolean;
  requests: ApprovalRequest[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: PersonQuestion[];
};
/** A question a Bot asked mid-run and is waiting on the person to answer. */
export type PersonQuestion = {
  id: string;
  botId: string;
  /** The Bot whose conversation this belongs to: for a hand-off, the Bot that handed it on. */
  conversationBotId?: string;
  threadId: string;
  question: string;
  why?: string;
  createdAt: string;
};

/**
 * Everything waiting on the person: the actions still pending and the questions still open, newest
 * first. Tasks lists them under Needs input, each one raised in a task's conversation as its task,
 * and the tab's badge counts them the same way (`needsInputCount` in lib/tasks/groups.ts).
 */
export function waitingOnYou(data: ApprovalInboxData | undefined): {
  requests: ApprovalRequest[];
  questions: PersonQuestion[];
  count: number;
} {
  const requests = (data?.requests ?? []).filter(
    (request) => request.status === "pending",
  );
  const questions = data?.questions ?? [];
  return { requests, questions, count: requests.length + questions.length };
}
/** How often the inbox is read again on its own, in ms. */
export const INBOX_POLL_MS = 10_000;
export const approvalInboxOptions = () =>
  queryOptions({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalInboxData> => {
      const response = await client("/api/approvals", {
        fallback: "Your approvals could not be loaded.",
      });
      return response.json();
    },
    refetchInterval: INBOX_POLL_MS,
  });
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "Your decision could not be saved.",
  });
export const revokeApprovalRule = (id: string) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The permission could not be revoked.",
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (input: {
  enabled?: boolean;
  autoReview?: boolean;
  hostCommands?: HostCommandPolicy;
}) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallback: "Your approval preference could not be saved.",
  });
export const createApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallback: "The rule could not be saved.",
  });
export const setTeamApprovalSettings = (input: {
  enforceAutoReview?: boolean;
  customRulesEnabled?: boolean;
  hostCommandsCap?: HostCommandPolicy;
}) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallback: "The team setting could not be saved.",
  });
export const createTeamApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallback: "The team rule could not be saved.",
  });
export const revokeTeamApprovalRule = (id: string) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The team rule could not be removed.",
  });
export const answerPersonQuestion = (id: string, response: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallback: "Your answer could not be saved.",
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The rule could not be changed.",
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The team rule could not be changed.",
  });

const approvalsKey = ["approvals"] as const;
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: approvalsKey });

export const approvalPreferencesMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setApprovalPreferences,
    onSettled: settle(queryClient),
  });
export const createApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: revokeApprovalRule,
    onSettled: settle(queryClient),
  });
export const teamApprovalSettingsMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setTeamApprovalSettings,
    onSettled: settle(queryClient),
  });
export const createTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createTeamApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeTeamApprovalRule,
    onSettled: settle(queryClient),
  });
/**
 * An answer changes where a task the person started stands, as well as the inbox: Tasks shows it
 * working again at once, not at its next poll.
 */
const settleAnswer = (queryClient: QueryClient) => () =>
  Promise.all([
    settle(queryClient)(),
    queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  ]);
/** Allow once, always allow, deny, or "I did it myself" on one waiting action. */
export const decideApprovalMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: async (_response, { id, choice }) => {
      // The saved decision is already known. Update it before the inbox refetch so the activity
      // pill stops describing a refused action while the continuation is still settling.
      queryClient.setQueryData<ApprovalInboxData>(
        approvalInboxOptions().queryKey,
        (inbox) =>
          inbox
            ? {
                ...inbox,
                requests: inbox.requests.map((request) =>
                  request.id === id
                    ? {
                        ...request,
                        decision: choice,
                        decidedAt: new Date().toISOString(),
                        status: choice === "deny" ? "denied" : "approved",
                      }
                    : request,
                ),
              }
            : inbox,
      );
      await settleAnswer(queryClient)();
    },
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: settleAnswer(queryClient),
  });

/**
 * Whether a rule's Bot field covers this Bot, matched the way the server matches it (`policy.ts`):
 * `*` is anything, and a `*` inside a value is any run of characters.
 */
export function ruleCoversBot(pattern: string, agentId: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(agentId);
}
