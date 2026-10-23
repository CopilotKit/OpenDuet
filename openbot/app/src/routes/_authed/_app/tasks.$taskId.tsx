import { createFileRoute } from "@tanstack/react-router";
import { useCloseSheet } from "@/components/duet/page-sheet";
import { TaskSheet } from "@/components/duet/task-sheet";

/**
 * One task, open over the Tasks list: its card in Chat and its row in Tasks both land here, and so
 * does a `/tasks/<id>` link on its own. Closing goes back to wherever it was opened from.
 */
export const Route = createFileRoute("/_authed/_app/tasks/$taskId")({
  component: TaskRoute,
});

function TaskRoute() {
  const { taskId } = Route.useParams();
  const navigate = Route.useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/tasks" }));
  return <TaskSheet key={taskId} onClose={close} taskId={taskId} />;
}
