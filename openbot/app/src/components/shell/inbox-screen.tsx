import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApprovalCard, PillButton } from "@/components/approvals/approval-card";
import { DuetCard, Rule, Tile } from "@/components/duet/kit";
import { clockTime } from "@/lib/approval-view";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
  type PersonQuestion,
  waitingOnYou,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { ScreenScroll, ScreenTitle } from "./screen";

/**
 * The Inbox tab: what is waiting on the person. The actions a Bot paused for an answer and the
 * questions it asked, newest first, each answered right here. The same requests the conversation
 * draws inline, so a decision made in either place is the one decision.
 */
export function InboxScreen() {
  const inbox = useQuery(approvalInboxOptions());
  const agents = useQuery(agentListQueryOptions());
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const { requests, questions, count } = waitingOnYou(inbox.data);
  const items = [
    ...requests.map((request) => ({
      at: request.createdAt,
      key: `request:${request.id}`,
      node: (
        <ApprovalCard
          botName={botName(request.action.botId)}
          busy={decision.isPending && decision.variables?.id === request.id}
          error={
            decision.variables?.id === request.id
              ? (decision.error?.message ?? null)
              : null
          }
          onDecide={(choice) => decision.mutate({ id: request.id, choice })}
          request={request}
        />
      ),
    })),
    ...questions.map((question) => ({
      at: question.createdAt,
      key: `question:${question.id}`,
      node: (
        <QuestionCard
          botName={botName(question.botId)}
          busy={answer.isPending && answer.variables?.id === question.id}
          error={
            answer.variables?.id === question.id
              ? (answer.error?.message ?? null)
              : null
          }
          onAnswer={(response) => answer.mutate({ id: question.id, response })}
          question={question}
        />
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <ScreenScroll>
      <ScreenTitle title="Inbox">What is waiting on you.</ScreenTitle>
      {inbox.isPending ? null : !inbox.data ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          Couldn't load what is waiting on you. Reload the page.
        </p>
      ) : count === 0 ? (
        <DuetCard className="flex items-center gap-[13px] px-4 py-4">
          <Tile icon="checkCircle" tone="green" />
          <p className="type-row font-semibold">
            Nothing has needed you today.
          </p>
        </DuetCard>
      ) : (
        <ul aria-label="Waiting on you" className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.key}>{item.node}</li>
          ))}
        </ul>
      )}
    </ScreenScroll>
  );
}

/** A question a Bot asked mid-run. The run resumes with the answer. */
function QuestionCard({
  question,
  botName,
  busy,
  error,
  onAnswer,
}: {
  question: PersonQuestion;
  botName: string;
  busy: boolean;
  error: string | null;
  onAnswer: (response: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <DuetCard raised>
      <div className="flex min-h-[54px] items-center gap-2.5 px-4 py-2.5">
        <Tile icon="question" size={32} />
        <p className="type-row min-w-0 flex-1 font-semibold">{botName} asks</p>
        <span className="type-label shrink-0 font-medium text-duet-ink-3">
          {clockTime(question.createdAt)}
        </span>
      </div>
      <Rule />
      <p className="type-row whitespace-pre-wrap px-4 pt-3 leading-6 [overflow-wrap:anywhere]">
        {question.question}
      </p>
      {question.why ? (
        <p className="type-label px-4 pt-1 text-duet-ink-2">{question.why}</p>
      ) : null}
      <form
        className="flex flex-col gap-2 px-4 pt-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) onAnswer(draft);
        }}
      >
        <textarea
          aria-label="Your answer"
          className="type-sub min-h-20 w-full resize-none rounded-2xl bg-duet-tile px-3 py-2.5 text-duet-ink outline-none placeholder:text-duet-ink-3 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Your answer"
          value={draft}
        />
        {error ? (
          <p className="type-label text-duet-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex">
          <PillButton disabled={busy || !draft.trim()} primary type="submit">
            Send answer
          </PillButton>
        </div>
      </form>
    </DuetCard>
  );
}
