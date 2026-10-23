import { createFileRoute } from "@tanstack/react-router";
import { ChannelScreen } from "@/components/shell/channel-screen";

/** One of the person's channels, opened from the drawer: its thread under its header. */
export const Route = createFileRoute("/_authed/_app/channels/$channelId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  return <ChannelScreen channelId={channelId} key={channelId} />;
}
