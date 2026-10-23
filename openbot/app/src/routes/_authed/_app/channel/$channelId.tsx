import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ScreenNotice } from "@/components/shell/chat-screen";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";

/**
 * A conversation other than Chat's one thread, opened from the menu or from a link on another page.
 *
 * Drawn the way Chat is: in the phone column under the floating header with the tab bar at its foot
 * (`tabForPath` counts it as Chat), and the same chat in its shell form, so its margins, its composer
 * and the orb's status line are Chat's. Above it sits what it is about, in the words the menu listed
 * it by.
 *
 * OpenBot's own bar for a conversation, with its name, the Bot's computer and the Bot's settings, is
 * not drawn: Chat has none, and the Bot's page has both.
 */
export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const channel = useQuery(channelQueryOptions(channelId));
  // The roster the menu draws from; its summary is the line the person just tapped.
  const roster = useInfiniteQuery(channelListQueryOptions());

  useMarkOpenChannelRead(channelId);

  // Nothing while the channel loads: a placeholder inside a local round trip is a flicker.
  if (channel.isPending) return null;
  if (channel.error || !channel.data)
    return (
      <ScreenNotice alert>
        Couldn't load this conversation. Reload the page.
      </ScreenNotice>
    );

  const runtimeAgentId =
    channel.data.agentIds.length === 1 ? channel.data.agentIds[0] : undefined;
  // Two or more Bots is a group conversation, with its own shared transcript. Every link to a
  // channel lands here, so this is the one redirect they all need.
  if (!runtimeAgentId)
    return <Navigate params={{ channelId }} replace to="/group/$channelId" />;

  const listed = roster.data?.find((row) => row.id === channelId);
  return (
    // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
    <ChannelChat
      channel={channel.data}
      inShell
      key={channel.data.id}
      runtimeAgentId={runtimeAgentId}
      topic={listed?.summary || channel.data.name}
    />
  );
}
