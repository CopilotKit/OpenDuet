import { IconPencil } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ChannelGlyph } from "@/components/duet/channel-look";
import { TypingDots } from "@/components/duet/kit";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import {
  archiveDuetChannelMutationOptions,
  keepDuetChannelMutationOptions,
} from "@/lib/duet-channels/mutations";
import type { DuetChannel } from "@/lib/duet-channels/queries";
import { useDuetChannels } from "@/lib/duet-channels/use-channel";
import { queryClient } from "@/query-client";
import { ScreenNotice } from "./chat-screen";
import { ChannelSheet } from "./channel-sheet";

/**
 * One channel, opened from the drawer: its own thread with the Bot, drawn by the same chat Chat
 * uses, under a header with its icon on its colour, its name and its purpose, and an edit entry that
 * opens the New channel sheet on it.
 *
 * Everything is not a channel, so its id here goes to Chat; a conversation with several Bots goes to
 * its group page. A conversation nobody dressed is kept as a channel when it is opened, so talking
 * in it never moves Everything.
 */
export function ChannelScreen({ channelId }: { channelId: string }) {
  const { bot, agents, list } = useDuetChannels();
  const conversation = useQuery(channelQueryOptions(channelId));
  const record = list.data?.channels.find(
    (channel) => channel.id === channelId,
  );
  useMarkOpenChannelRead(channelId);
  useKeepAsChannel(record);

  // Nothing while the first answers load: a placeholder inside a local round trip is a flicker.
  if (agents.isPending || list.isPending || conversation.isPending) return null;
  if (!bot || list.error || conversation.error || !conversation.data)
    return (
      <ScreenNotice alert>
        Couldn't load this channel. Reload the page.
      </ScreenNotice>
    );
  if (list.data?.everythingId === channelId) return <Navigate replace to="/" />;
  const [runtimeAgentId, ...others] = conversation.data.agentIds;
  if (!runtimeAgentId || others.length > 0)
    return <Navigate params={{ channelId }} replace to="/group/$channelId" />;
  if (!record)
    return <ScreenNotice alert>Couldn't find this channel.</ScreenNotice>;
  return (
    <ChannelChat
      channel={conversation.data}
      inShell
      key={conversation.data.id}
      lead={
        <ChannelHeader botId={bot.id} botName={bot.name} channel={record} />
      }
      runtimeAgentId={runtimeAgentId}
    />
  );
}

/** Opened, a conversation with no look of its own takes the default it was drawn with. */
function useKeepAsChannel(record: DuetChannel | undefined) {
  const keep = useMutation(keepDuetChannelMutationOptions(queryClient));
  const kept = useRef<string | null>(null);
  const keepMutate = keep.mutate;
  useEffect(() => {
    if (!record || record.dressed || kept.current === record.id) return;
    kept.current = record.id;
    keepMutate(record.id);
  }, [record, keepMutate]);
}

/**
 * The channel at the top of its thread: its icon in its colour, its name and its purpose, with Edit
 * beside them.
 * While the Bot writes its hello, the typing dots stand under it.
 */
function ChannelHeader({
  channel,
  botId,
  botName,
}: {
  channel: DuetChannel;
  botId: string;
  botName: string;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const roster = useInfiniteQuery(channelListQueryOptions());
  const live = roster.data?.find((row) => row.id === channel.id);
  const unarchive = useMutation(archiveDuetChannelMutationOptions(queryClient));
  // The hello is a turn no browser streams: the roster's working dot is how it shows.
  const greeting = (live?.busy ?? false) && !live?.lastMessageAt;
  return (
    <div className="flex flex-col gap-3 pb-2">
      <header className="flex items-start gap-3 px-1">
        <ChannelGlyph
          className="mt-0.5"
          colour={channel.colour}
          icon={channel.icon}
          size={30}
          stroke={1.8}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <h1 className="type-title truncate font-semibold text-duet-ink">
            {channel.name}
          </h1>
          {channel.purpose ? (
            <p className="type-sub line-clamp-2 text-duet-ink-2">
              {channel.purpose}
            </p>
          ) : null}
        </div>
        <button
          aria-label="Edit channel"
          className="duet-glass grid size-10 shrink-0 place-items-center rounded-full text-duet-ink shadow-duet-glass transition-transform focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
          onClick={() => setEditing(true)}
          type="button"
        >
          <IconPencil size={18} stroke={2} />
        </button>
      </header>
      {channel.archivedAt ? (
        <div className="flex items-center justify-between gap-3 rounded-[16px] bg-duet-tile px-4 py-2.5">
          <p className="type-sub text-duet-ink-2">This channel is archived.</p>
          <button
            className="type-label shrink-0 rounded-full px-3 py-1.5 font-semibold text-duet-ink outline-none shadow-[inset_0_0_0_1px_var(--duet-hair)] transition-colors hover:bg-duet-card focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
            disabled={unarchive.isPending}
            onClick={() =>
              unarchive.mutate({ id: channel.id, archived: false })
            }
            type="button"
          >
            Unarchive
          </button>
        </div>
      ) : null}
      {greeting ? <TypingDots label={`${botName} is writing`} /> : null}
      {editing ? (
        <ChannelSheet
          botId={botId}
          channel={channel}
          onArchived={(saved) => {
            setEditing(false);
            // Put away, it leaves for Everything; the drawer lists it under Archived.
            if (saved.archivedAt) void navigate({ to: "/" });
          }}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
