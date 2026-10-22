import { createFileRoute } from "@tanstack/react-router";
import { TasksScreen } from "@/components/shell/tasks-screen";

/** Tasks: what needs the person, what their Bots suggest, and the work under way. */
export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksScreen,
});
