import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  CURRENT_SLIDE_LAYOUT,
  type SlideLayoutVersion,
} from "@openbot/shared/slide-fit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useConversationSend } from "@/components/channels/conversation-send";
import { NewTaskSheet } from "@/components/shell/new-task-sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  checkPageMutationOptions,
  deletePageMutationOptions,
} from "@/lib/pages/mutations";
import {
  blocksOf,
  type PageSlide,
  pageQueryOptions,
  slidesOf,
} from "@/lib/pages/queries";
import { pageThemeStyle } from "@/lib/pages/theme";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { searchText } from "@/lib/search-text";
import { startTaskMutationOptions } from "@/lib/tasks/mutations";
import { cn } from "@/lib/utils";
import { DuetIcon } from "./icons";
import { PageCardFace } from "./page-card";
import { FADE_MS, useSheetMorph } from "./page-morph";
import { type OnListItem, PageBlocks, SlideCard } from "./page-view";

/*
 * A page the Bot made, opened: a large card on the frosted veil, × at its top left and the title
 * across its header. Under that, the day and when it last changed, then the page itself: a page
 * scrolls, and a deck shows one 16:9 slide at a time.
 *
 * Two places open it. Chat draws it over the conversation (`PageSheetHost`, below), so a row worth
 * a closer look can be sent as the person's own words. The Make tab draws it over the grid, from
 * the `/make/$pageId` route, where there is no conversation and the rows are still. Either way the
 * address bar says `/make/<id>`, so the link works on its own.
 *
 * Opened from a card, the card grows into it and closing shrinks it back (page-morph.tsx). Opened
 * any other way, or with reduced motion, it fades.
 */

/** How far a finger has to travel across a slide, in pixels, to turn it. */
const SWIPE_TO_TURN = 48;

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** "Thursday, October 22 · Updated 9:41 AM". */
export function dateLine(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return `${dateFormat.format(at)} · Updated ${timeFormat.format(at)}`;
}

/** What a tap on a row worth a closer look sends, in the person's words. */
export function tellMeMore(text: string): string {
  return `Tell me more about ${text}`;
}

export function PageSheet({
  pageId,
  onClose,
  onListItem,
}: {
  pageId: string;
  onClose: () => void;
  /** Absent where there is no conversation to send to: the rows are drawn still. */
  onListItem?: OnListItem | undefined;
}) {
  const page = useQuery(pageQueryOptions(pageId));
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  const agents = useQuery({
    ...agentListQueryOptions(),
    enabled: Boolean(page.data?.botId),
  });
  const bot = agents.data?.find((bot) => bot.id === page.data?.botId);
  const check = useMutation(checkPageMutationOptions(queryClient, pageId));
  const remove = useMutation(deletePageMutationOptions(queryClient, pageId));
  const start = useMutation(startTaskMutationOptions(queryClient));
  const [actions, setActions] = useState(false);
  const [revise, setRevise] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const openTask = (id: string) => {
    if (router)
      void router.navigate({ to: "/tasks/$taskId", params: { taskId: id } });
    else onClose();
  };
  const popup = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPreference();
  const morph = useSheetMorph(pageId, onClose, (summary, size) => (
    <PageCardFace page={summary} size={size} />
  ));
  const title = page.data?.title ?? "";
  const checklistRevision = page.data?.checklistRevision ?? "";
  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next) morph.close();
      }}
      open
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-modal="true"
          className={cn(
            "duet-face group fixed inset-0 z-50 flex flex-col bg-duet-surface text-duet-ink outline-none",
            // The veil fades in and out with reduced motion too: a fade is the reduced transition.
            "transition-opacity duration-[var(--duet-dur-swap)] data-ending-style:opacity-0 data-starting-style:opacity-0",
            morph.fading && "opacity-0",
          )}
          data-closing={morph.fading || undefined}
          // The sheet takes focus, not ×, so a stray Enter does not close what was just opened.
          initialFocus={popup}
          ref={popup}
          style={{
            ...pageThemeStyle(page.data?.theme),
            ...(morph.fading ? { transitionDuration: `${FADE_MS}ms` } : {}),
          }}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col px-3 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),10px)]">
            <div
              className={cn(
                // A size container, so the header below can ask how much room it has.
                "@container flex min-h-0 flex-1 flex-col overflow-hidden motion-reduce:transition-none",
                // Morphing, the card fades in under the stand-in as it leaves, on the morph's own
                // short hand-over (page-morph.tsx), not a token; otherwise it rises like a sheet.
                morph.morphing
                  ? "transition-opacity duration-150 ease-out"
                  : "transition-transform duration-[var(--duet-dur-sheet)] motion-safe:group-data-starting-style:translate-y-6",
                morph.hidden && "opacity-0",
              )}
              data-morph-hidden={morph.hidden || undefined}
              ref={morph.sheetRef}
            >
              {/*
               * THE TITLE GETS A ROW OF ITS OWN WHEN THE TEXT IS LARGE. Back and "…" are 44px each
               * in rem, so at 200% text they took 176px of a 342px row between them, and the title
               * was squeezed into a column a few letters wide. It broke anywhere to fit, one syllable
               * per line ("Prep / note / s: / Hea / rth"). Below 20rem of room, which is 320px at the
               * default size and so no phone at it, the title moves under the two discs and takes the
               * whole width. It breaks only between words, and a title longer than two lines ends in
               * an ellipsis, with the whole of it still the dialog's name.
               */}
              <header className="relative grid min-h-14 shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 py-1">
                <button
                  aria-label="Back"
                  className="col-start-1 row-start-1 grid size-11 place-items-center rounded-full text-duet-ink outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:bg-duet-tile"
                  onClick={morph.close}
                  type="button"
                >
                  <DuetIcon name="chevronLeft" size={22} stroke={2.1} />
                </button>
                <DialogPrimitive.Title className="type-row col-start-2 row-start-1 line-clamp-2 min-w-0 justify-self-center text-balance rounded-[1.25rem] bg-duet-card px-4 py-2 text-center font-semibold [overflow-wrap:break-word] @max-[20rem]:col-span-3 @max-[20rem]:col-start-1 @max-[20rem]:row-start-2">
                  {title}
                </DialogPrimitive.Title>
                <button
                  aria-label="Page actions"
                  aria-expanded={actions}
                  className="col-start-3 row-start-1 grid size-11 place-items-center rounded-full bg-duet-card text-duet-ink"
                  onClick={() => setActions(!actions)}
                  type="button"
                >
                  …
                </button>
                {/*
                 * Grows out of "…" from its corner and shrinks back into it: in at the swap duration
                 * from 97%, out at the tap one to 99%, so it is seen going without being waited on.
                 * With reduced motion it only fades.
                 */}
                <AnimatePresence>
                  {actions ? (
                    <motion.div
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      className="absolute top-full right-0 z-20 flex min-w-48 origin-top-right flex-col rounded-2xl bg-duet-card p-2 shadow-duet-raised"
                      data-page-actions=""
                      exit={
                        reduced
                          ? {
                              opacity: 0,
                              transition: { duration: DURATION.tap },
                            }
                          : {
                              opacity: 0,
                              scale: 0.99,
                              transition: {
                                duration: DURATION.tap,
                                ease: EASE_OUT,
                              },
                            }
                      }
                      initial={
                        reduced
                          ? { opacity: 0 }
                          : { opacity: 0, scale: 0.97, y: -4 }
                      }
                      transition={{ duration: DURATION.swap, ease: EASE_OUT }}
                    >
                      <button
                        className="min-h-11 rounded-xl px-3 text-left transition-colors hover:bg-duet-tile"
                        type="button"
                        onClick={async () => {
                          setActionError("");
                          try {
                            await navigator.clipboard.writeText(
                              new URL(
                                `/make/${encodeURIComponent(pageId)}`,
                                window.location.origin,
                              ).href,
                            );
                            setNotice("Link copied");
                            setActions(false);
                          } catch {
                            setActionError(
                              "Couldn't copy the link. Try again.",
                            );
                          }
                        }}
                      >
                        Share
                      </button>
                      <button
                        className="min-h-11 rounded-xl px-3 text-left transition-colors hover:bg-duet-tile disabled:opacity-50"
                        disabled={!bot}
                        type="button"
                        onClick={() => {
                          setRevise(true);
                          setActions(false);
                        }}
                      >
                        Revise
                      </button>
                      <button
                        className="min-h-11 rounded-xl px-3 text-left transition-colors hover:bg-duet-tile disabled:opacity-50"
                        disabled={!page.data?.botId || start.isPending}
                        type="button"
                        onClick={() => {
                          if (!page.data?.botId) return;
                          start.mutate(
                            {
                              botId: page.data.botId,
                              instruction: `Read saved page ${pageId} with read_page, then carry out the plan in “${page.data.title}”. Ask before any external action that needs approval.`,
                            },
                            { onSuccess: (task) => openTask(task.id) },
                          );
                        }}
                      >
                        Turn into a task
                      </button>
                      <button
                        className="min-h-11 rounded-xl px-3 text-left text-duet-red transition-colors hover:bg-duet-tile disabled:opacity-50"
                        disabled={remove.isPending}
                        type="button"
                        onClick={() =>
                          remove.mutate(undefined, { onSuccess: onClose })
                        }
                      >
                        Delete
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-10">
                {notice ? (
                  <p
                    className="type-label mb-3 text-duet-green animate-in fade-in duration-[var(--duet-dur-swap)]"
                    role="status"
                  >
                    {notice}
                  </p>
                ) : null}
                {actionError || check.error || remove.error || start.error ? (
                  <p className="type-label mb-3 text-duet-red" role="alert">
                    {actionError ||
                      check.error?.message ||
                      remove.error?.message ||
                      start.error?.message}
                  </p>
                ) : null}
                {page.error ? (
                  <p className="type-label mb-3 text-duet-red" role="alert">
                    {page.data
                      ? "Couldn't refresh this page. Showing the saved version."
                      : "Couldn't open this page. Try again."}
                  </p>
                ) : null}
                {check.error || page.error ? (
                  <button
                    className="type-label mb-3 min-h-11 rounded-xl bg-duet-card px-3 disabled:opacity-50"
                    type="button"
                    disabled={page.isFetching}
                    onClick={async () => {
                      const refreshed = await page.refetch();
                      if (!refreshed.isError) check.reset();
                    }}
                  >
                    Refresh page
                  </button>
                ) : null}
                {page.data ? (
                  <>
                    <p className="type-label mb-4 font-medium text-duet-ink-3">
                      {dateLine(page.data.updatedAt)}
                    </p>
                    {page.data.kind === "slides" ? (
                      <SlideDeck
                        onListItem={onListItem}
                        slides={slidesOf(page.data)}
                        layoutVersion={
                          "slides" in page.data.content
                            ? (page.data.content.layoutVersion ?? 1)
                            : CURRENT_SLIDE_LAYOUT
                        }
                        onCheck={(slide, block, item, checked) =>
                          check.mutate({
                            slide,
                            block,
                            item,
                            checked,
                            expectedChecklistRevision: checklistRevision,
                          })
                        }
                      />
                    ) : (
                      <PageBlocks
                        blocks={blocksOf(page.data)}
                        onCheck={(block, item, checked) =>
                          check.mutate({
                            block,
                            item,
                            checked,
                            expectedChecklistRevision: checklistRevision,
                          })
                        }
                        {...(onListItem ? { onListItem } : {})}
                      />
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
          {revise && bot ? (
            <NewTaskSheet
              bot={bot}
              onClose={() => setRevise(false)}
              onAdded={(where, task) => {
                setRevise(false);
                if (where === "active" && task) openTask(task.id);
                else setNotice("Revision saved for Up next");
              }}
              question="What should change?"
              instructionPrefix={`Read saved page ${pageId} with read_page before revising it. Save changes with make_page using the same page id.`}
              starter={`Revise “${title}”: …`}
            />
          ) : null}
          {morph.ghost}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A deck, one slide at a time: the arrow keys, a swipe, or the buttons under it turn the slide, and
 * the counter says where you are. The slides sit side by side and slide across; with reduced motion
 * they change in place.
 */
export function SlideDeck({
  slides,
  layoutVersion = CURRENT_SLIDE_LAYOUT,
  onListItem,
  onCheck,
}: {
  slides: readonly PageSlide[];
  layoutVersion?: SlideLayoutVersion;
  onCheck?:
    | ((slide: number, block: number, item: string, checked: boolean) => void)
    | undefined;
  onListItem?: OnListItem | undefined;
}) {
  const [selectedIndex, setIndex] = useState(0);
  const count = slides.length;
  const lastIndex = Math.max(0, count - 1);
  const index = Math.min(selectedIndex, lastIndex);
  // Commit the clamped selection so a later revision cannot restore a removed slide.
  if (selectedIndex !== index) setIndex(index);
  const go = (step: number) =>
    setIndex((current) => Math.min(lastIndex, Math.max(0, current + step)));
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey) return;
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable='true']")
      )
        return;
      // A focused rich block (or its content) owns its native horizontal scrolling.
      for (
        let element = target;
        element instanceof Element;
        element = element.parentElement
      ) {
        if (element.scrollWidth <= element.clientWidth) continue;
        const overflow = getComputedStyle(element).overflowX;
        if (overflow === "auto" || overflow === "scroll") return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goRef.current(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goRef.current(-1);
      }
    };
    /*
     * In the capture phase: the dialog stops a key's propagation inside it, so a listener waiting
     * for it to bubble up to the document never hears it.
     */
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_TO_TURN || Math.abs(dx) < Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  };

  if (count === 0) return null;
  return (
    <section aria-roledescription="carousel" aria-label="Slides">
      <div
        className="-mx-3 touch-pan-y overflow-hidden"
        onPointerCancel={() => {
          swipe.current = null;
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <div
          className="flex transition-transform duration-[var(--duet-dur-enter)] motion-reduce:transition-none"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {slides.map((slide, at) => (
            // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA carousel's slide is a group, not a form's fieldset.
            <div
              aria-hidden={at !== index}
              aria-label={`Slide ${at + 1} of ${count}`}
              aria-roledescription="slide"
              className="w-full shrink-0 px-3 pt-1 pb-4"
              inert={at !== index}
              // biome-ignore lint/suspicious/noArrayIndexKey: a deck's slides are fixed in order.
              key={at}
              role="group"
            >
              <SlideCard
                slide={slide}
                layoutVersion={layoutVersion}
                onCheck={
                  onCheck
                    ? (block, item, checked) =>
                        onCheck(at, block, item, checked)
                    : undefined
                }
                {...(onListItem ? { onListItem } : {})}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-5">
        <SlideButton
          disabled={index === 0}
          icon="chevronLeft"
          label="Previous slide"
          onClick={() => go(-1)}
        />
        <p
          aria-live="polite"
          className="type-label min-w-12 text-center font-semibold text-duet-ink-2 tabular-nums"
        >
          <span aria-hidden>
            {index + 1} / {count}
          </span>
          <span className="sr-only">
            Slide {index + 1} of {count}
          </span>
        </p>
        <SlideButton
          disabled={index === count - 1}
          icon="chevronRight"
          label="Next slide"
          onClick={() => go(1)}
        />
      </div>
    </section>
  );
}

function SlideButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: "chevronLeft" | "chevronRight";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="grid size-11 place-items-center rounded-full bg-duet-tile text-duet-ink outline-none transition-[opacity,transform] focus-visible:ring-3 focus-visible:ring-duet-violet/40 enabled:active:scale-95 disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <DuetIcon name={icon} size={20} stroke={2.2} />
    </button>
  );
}

/**
 * Closes a sheet back to wherever it was opened from. Opened by a tap, that is one step back in
 * history; opened from a link with nothing behind it, `fallback` says where to land.
 */
export function useCloseSheet(fallback: () => void): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return () => {
    if (canGoBack) router.history.back();
    else fallback();
  };
}

/**
 * Chat's half: draws the page named by the conversation's `?page=` over it, inside the conversation,
 * so a row in it can be sent as the person's own words. The card puts it there, masked as
 * `/make/<id>` in the address bar (see page-card-tool.tsx).
 *
 * Draws nothing outside a router. A conversation rendered on its own, as tests do, has no address
 * to read a page from.
 */
export function PageSheetHost() {
  const router = useRouter({ warn: false });
  return router ? <SearchedPageSheet /> : null;
}

function SearchedPageSheet() {
  const pageId = useRouterState({
    select: (state) =>
      searchText((state.location.search as Record<string, unknown>).page) ||
      null,
  });
  const navigate = useNavigate();
  const conversation = useConversationSend();
  const close = useCloseSheet(
    () =>
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          page: undefined,
        }),
        replace: true,
      }),
  );
  if (!pageId) return null;
  return (
    <PageSheet
      key={pageId}
      onClose={close}
      onListItem={
        conversation
          ? (text) => {
              // Closed once it went, so the answer is what they see next.
              if (conversation.send(tellMeMore(text))) close();
            }
          : undefined
      }
      pageId={pageId}
    />
  );
}
