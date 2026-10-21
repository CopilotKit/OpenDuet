import type { ChannelSummary } from "./queries";

/**
 * The person's one ongoing conversation with a Bot: the most recently used channel that has only
 * that Bot in it and can still reply.
 *
 * Channels are not idempotent (every "new conversation" makes another), so "the" conversation is
 * whichever one was used last. A group that includes the Bot is a different conversation.
 */
export function ongoingChannel(
  channels: readonly ChannelSummary[] | undefined,
  botId: string,
): ChannelSummary | undefined {
  let found: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (!channel.active) continue;
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== botId)
      continue;
    if (!found || lastUsed(channel) > lastUsed(found)) found = channel;
  }
  return found;
}

function lastUsed(channel: ChannelSummary): string {
  return channel.lastMessageAt ?? channel.createdAt;
}
