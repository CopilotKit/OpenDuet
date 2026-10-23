import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TasksScreen } from "@/components/shell/tasks-screen";

/** Tasks: what needs the person, their tasks, their Bots' suggestions and work. A task opens over it. */
export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksRoute,
});

function TasksRoute() {
  return (
    <>
      <TasksScreen />
      <Outlet />
    </>
  );
}
