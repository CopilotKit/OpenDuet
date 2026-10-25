import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  isRedirect,
  Link,
  redirect,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DuetIcon } from "@/components/duet/icons";
import { useServerWork } from "@/components/shell/chat-presence";
import { MoreDisc } from "@/components/shell/header";
import { usePageChrome } from "@/components/shell/page-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  conversationTitle,
  firstMessageQueryOptions,
  NEW_CONVERSATION,
} from "@/lib/channels/conversation-title";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { tryClient } from "@/lib/client";

/**
 * A conversation other than Chat's one thread, opened from the menu or from a link on another page.
 *
 * A page pushed over the app (parity-spec 2.9): the back disc, what the conversation is about in the
 * title pill with what the Bot is doing under it, the "…" disc for the conversation's Bot and its
 * computer, and no menu, avatar or tab bar. The chat under it is Chat's own, in its shell form and in
 * Chat's column, so the bubbles, the glass reply box and its margins match; the reply box sits at the
 * foot of the screen with nothing under it.
 */
export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  /*
   * Before anything draws: a conversation with two or more Bots is a group, with its own shared
   * transcript, so it goes there without this page's chrome flashing first. And a conversation that
   * no longer exists is told apart from one that failed to load, since only the second is worth a
   * reload.
   */
  loader: async ({ context, params }) => {
    try {
      const channel = await context.queryClient.ensureQueryData(
        channelQueryOptions(params.channelId),
      );
      if (channel.agentIds.length !== 1)
        throw redirect({
          to: "/group/$channelId",
          params: { channelId: params.channelId },
          replace: true,
        });
      return { gone: false };
    } catch (error) {
      if (isRedirect(error)) throw error;
      const probe = await tryClient(`/api/channels/${params.channelId}`).catch(
        () => null,
      );
      return { gone: probe?.status === 404 };
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { gone } = Route.useLoaderData();
  const channel = useQuery(channelQueryOptions(channelId));
  // The roster the menu draws from, as it stands: never paged further to find this one.
  const roster = useInfiniteQuery(channelListQueryOptions());
  const agentId = channel.data?.agentIds[0];

  useMarkOpenChannelRead(channelId);

  const listed = roster.data?.find((row) => row.id === channelId);
  const threadId = channel.data?.threadId;
  const first = useQuery({
    ...firstMessageQueryOptions(
      threadId ?? "",
      agentId ?? "",
      Boolean(listed?.lastMessageAt ?? channel.data?.lastMessageAt),
    ),
    enabled: Boolean(threadId && agentId && !listed?.summary),
  });
  /*
   * The summary, else what the person first asked: what the conversation is about, which stays put
   * as it goes on. Held for the visit once known, so the pill does not re-title itself with every
   * message. Not in the menu's first page: named plainly rather than paging the menu to find it.
   */
  const summary = listed?.summary;
  const title = useHeldTitle(
    channelId,
    !channel.data || roster.isPending || (!summary && !first.isFetched)
      ? null
      : !listed && !summary && !first.data
        ? "Conversation"
        : conversationTitle({
            summary,
            firstMessage: first.data,
            lastMessage: listed?.lastMessage,
          }),
    Boolean(summary || first.data),
  );
  // The server's own work in this conversation, such as the run after Allow once.
  const serverWork = useServerWork(listed?.busy === true, threadId);
  const actions = useMemo(
    () => (agentId ? <ConversationMore agentId={agentId} /> : undefined),
    [agentId],
  );
  usePageChrome({ title, column: "phone", status: true, serverWork, actions });

  // Nothing while the channel loads: a placeholder inside a local round trip is a flicker.
  if (channel.isPending) return null;
  if (channel.error || !channel.data || !agentId)
    return (
      <PageNotice alert={!gone}>
        {gone
          ? "This conversation is gone."
          : "Couldn't load this conversation. Reload the page."}
      </PageNotice>
    );

  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {/* Remount on channel changes so CopilotKit agent/thread state cannot leak between channels. */}
      <ChannelChat
        channel={channel.data}
        inShell
        key={channel.data.id}
        runtimeAgentId={agentId}
      />
    </>
  );
}

/**
 * The first summary or first-message title this channel visit found, kept for the rest of it. A
 * fallback stays provisional so a recovering history read can still name the conversation.
 */
function useHeldTitle(
  channelId: string,
  title: string | null,
  resolved: boolean,
): string | null {
  const [held, setHeld] = useState<{ channelId: string; title: string | null }>(
    {
      channelId,
      title: null,
    },
  );
  // Parameter-only navigation preserves this component, but starts a new conversation visit.
  if (held.channelId !== channelId) {
    setHeld({ channelId, title: null });
    return title;
  }
  if (
    resolved &&
    held.title === null &&
    title !== null &&
    title !== NEW_CONVERSATION
  )
    setHeld({ channelId, title });
  return held.title ?? title;
}

/** A sentence where the conversation would be, under the page's chrome. */
function PageNotice({ children, alert }: { children: string; alert: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 pt-[88px] text-center">
      <p
        className={
          alert ? "type-sub text-duet-red" : "type-sub text-duet-ink-2"
        }
        role={alert ? "alert" : undefined}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * The "…" disc: the conversation's Bot, and the Bot's computer, which OpenBot's own bar for a
 * conversation used to hold. The computer opens in a sheet over the conversation.
 */
function ConversationMore({ agentId }: { agentId: string }) {
  const [watching, setWatching] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<MoreDisc />} />
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          <DropdownMenuItem
            className="type-sub min-h-11"
            render={<Link params={{ agentId }} to="/bots/$agentId" />}
          >
            Bot settings
          </DropdownMenuItem>
          <DropdownMenuItem
            className="type-sub min-h-11"
            onClick={() => setWatching(true)}
          >
            Computer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/*
       * A page-sheet (parity-spec 2.9): it rises over the conversation with a 38px top radius, and
       * its close is a 44px disc in its own top bar.
       */}
      <Sheet onOpenChange={setWatching} open={watching}>
        <SheetContent
          className="duet-face max-h-[92svh] gap-0 overflow-y-auto rounded-t-[38px] border-0 bg-duet-surface text-duet-ink"
          showCloseButton={false}
          side="bottom"
        >
          <SheetHeader className="flex-row items-center justify-between px-4 pt-4 pb-0">
            <SheetTitle className="type-body font-semibold text-duet-ink">
              Computer
            </SheetTitle>
            <SheetClose
              render={
                <button
                  aria-label="Close"
                  className="duet-glass grid size-11 place-items-center rounded-full text-duet-ink shadow-duet-glass"
                  type="button"
                />
              }
            >
              <DuetIcon name="x" size={18} />
            </SheetClose>
          </SheetHeader>
          {watching ? <ComputerViewPanel agentId={agentId} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
