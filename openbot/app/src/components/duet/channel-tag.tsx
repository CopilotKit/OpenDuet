import { useChannelOf } from "@/lib/duet-channels/use-channel";
import { ChannelTag } from "./channel-look";

/**
 * The tag for the channel something was asked for in, looked up by its id: a dot in the channel's
 * colour and its name. Tasks rows, Chat's task cards, the task report and Up next all draw this.
 * Nothing for Everything, a channel since deleted, or before the channels are read.
 */
export function ChannelTagOf({
  channelId,
  className,
}: {
  channelId: string | null | undefined;
  className?: string;
}) {
  const channel = useChannelOf(channelId);
  return channel ? (
    <span className={className ? `flex ${className}` : "flex"}>
      <ChannelTag channel={channel} />
    </span>
  ) : null;
}
