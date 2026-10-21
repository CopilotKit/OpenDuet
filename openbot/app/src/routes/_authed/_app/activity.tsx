import { createFileRoute } from "@tanstack/react-router";
import { ActivityScreen } from "@/components/shell/activity-screen";

/** Activity: what the product's own Bot did, and what it does next. */
export const Route = createFileRoute("/_authed/_app/activity")({
  component: ActivityScreen,
});
