import { createFileRoute } from "@tanstack/react-router";
import { useCloseSheet } from "@/components/duet/page-sheet";
import { QuestionSheet } from "@/components/duet/question-sheet";

/**
 * A question a Bot asked outside any task, open over the Tasks list to answer: its row under Needs
 * input lands here. Closing goes back to wherever it was opened from.
 */
export const Route = createFileRoute(
  "/_authed/_app/tasks/questions/$questionId",
)({
  component: QuestionRoute,
});

function QuestionRoute() {
  const { questionId } = Route.useParams();
  const navigate = Route.useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/tasks" }));
  return (
    <QuestionSheet key={questionId} onClose={close} questionId={questionId} />
  );
}
