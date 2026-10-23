import type { ChannelSummary } from "./queries";

/** How far back to look for the conversation before deciding there is none: four pages of 50. */
export const ONGOING_SEARCH_LIMIT = 200;

/**
 * The person's one ongoing conversation with a Bot: the most recently used channel that has only
 * that Bot in it and can still reply.
 *
 * Channels are not idempotent (every "new conversation" makes another), so "the" conversation is
 * whichever one was used last. A group that includes the Bot is a different conversation, and so is
 * a task's: a task works in a conversation of its own with the same Bot, usually the one used last,
 * and Chat must not turn into it. So is one of the person's OpenDuet channels, for the same reason:
 * the channel they talked in last must not become Everything.
 */
export function ongoingChannel(
  channels: readonly ChannelSummary[] | undefined,
  botId: string,
): ChannelSummary | undefined {
  let found: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (!channel.active || channel.taskId || channel.openduetChannel) continue;
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== botId)
      continue;
    if (!found || lastUsed(channel) > lastUsed(found)) found = channel;
  }
  return found;
}

function lastUsed(channel: ChannelSummary): string {
  return channel.lastMessageAt ?? channel.createdAt;
}
