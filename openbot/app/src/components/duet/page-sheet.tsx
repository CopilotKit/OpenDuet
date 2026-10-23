import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import {
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useConversationSend } from "@/components/channels/conversation-send";
import {
  blocksOf,
  type PageSlide,
  pageQueryOptions,
  slidesOf,
} from "@/lib/pages/queries";
import { searchText } from "@/lib/search-text";
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
  const popup = useRef<HTMLDivElement>(null);
  const morph = useSheetMorph(pageId, onClose, (summary, size) => (
    <PageCardFace page={summary} size={size} />
  ));
  const title = page.data?.title ?? "";
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
            "duet-veil duet-face group fixed inset-0 z-50 flex flex-col text-duet-ink outline-none",
            // The veil fades in and out with reduced motion too: a fade is the reduced transition.
            "transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0",
            morph.fading && "opacity-0",
          )}
          data-closing={morph.fading || undefined}
          // The sheet takes focus, not ×, so a stray Enter does not close what was just opened.
          initialFocus={popup}
          ref={popup}
          style={
            morph.fading ? { transitionDuration: `${FADE_MS}ms` } : undefined
          }
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col px-2.5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),10px)]">
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-duet-card shadow-duet-raised motion-reduce:transition-none",
                morph.morphing
                  ? "transition-opacity duration-150 ease-out"
                  : "transition-transform duration-300 ease-out motion-safe:group-data-starting-style:translate-y-6",
                morph.hidden && "opacity-0",
              )}
              data-morph-hidden={morph.hidden || undefined}
              ref={morph.sheetRef}
            >
              <header className="grid h-14 shrink-0 grid-cols-[44px_1fr_44px] items-center px-2">
                <button
                  aria-label="Close"
                  className="grid size-11 place-items-center rounded-full text-duet-ink outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:bg-duet-tile"
                  onClick={morph.close}
                  type="button"
                >
                  <DuetIcon name="x" size={22} stroke={2.1} />
                </button>
                <DialogPrimitive.Title className="type-row truncate px-1 text-center font-semibold">
                  {title}
                </DialogPrimitive.Title>
                <span aria-hidden />
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-10">
                {page.isPending ? null : page.error ? (
                  <p className="type-sub text-duet-red" role="alert">
                    Couldn't open this page. Close it and try again.
                  </p>
                ) : (
                  <>
                    <p className="type-label mb-4 font-medium text-duet-ink-3">
                      {dateLine(page.data.updatedAt)}
                    </p>
                    {page.data.kind === "slides" ? (
                      <SlideDeck
                        onListItem={onListItem}
                        slides={slidesOf(page.data)}
                      />
                    ) : (
                      <PageBlocks
                        blocks={blocksOf(page.data)}
                        {...(onListItem ? { onListItem } : {})}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
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
  onListItem,
}: {
  slides: readonly PageSlide[];
  onListItem?: OnListItem | undefined;
}) {
  const [index, setIndex] = useState(0);
  const count = slides.length;
  const go = (step: number) =>
    setIndex((current) => Math.min(count - 1, Math.max(0, current + step)));
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable='true']")
      )
        return;
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
          className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
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
