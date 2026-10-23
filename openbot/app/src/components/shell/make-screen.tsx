import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { DuetCard } from "@/components/duet/kit";
import { PageCard, previewKind } from "@/components/duet/page-card";
import { TaskStatusPill } from "@/components/duet/task-card";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type PageSummary, pageListQueryOptions } from "@/lib/pages/queries";
import { type TaskRecord, taskListQueryOptions } from "@/lib/tasks/queries";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { NewTaskSheet } from "./new-task-sheet";
import { ScreenScroll, ScreenTitle } from "./screen";

/*
 * The Make tab: everything the Bot made for the person, as thumbnails two to a row, the most
 * recently changed first, with chips to show one kind. The + fans out what it can make. Picking one
 * opens Tasks' + sheet with a starter line ("Make a deck about …"), and Start now starts a task
 * whose Bot makes it with `make_page`. While that task works, a card for it leads the grid, and the
 * grid reads again every few seconds until what it made arrives.
 */

/** What the + offers, top to bottom, each with the line the sheet opens with. */
export const MAKE_KINDS: readonly {
  id: "page" | "deck" | "dashboard" | "doc";
  label: string;
  icon: DuetIconName;
  starter: string;
}[] = [
  { id: "page", label: "Page", icon: "layout", starter: "Make a page about …" },
  { id: "deck", label: "Deck", icon: "deck", starter: "Make a deck about …" },
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    starter: "Make a dashboard of …",
  },
  { id: "doc", label: "Doc", icon: "page", starter: "Write a doc about …" },
];
export type MakeKind = (typeof MAKE_KINDS)[number];

/** The chips over the grid: everything, or one kind. A doc is a page, so Pages holds both. */
export type MakeFilter = "all" | ReturnType<typeof previewKind>;
export const MAKE_FILTERS: readonly { id: MakeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "page", label: "Pages" },
  { id: "slides", label: "Decks" },
  { id: "dashboard", label: "Dashboards" },
];

/** The pages a chip shows, in the order given. */
export function filterPages(
  pages: readonly PageSummary[],
  filter: MakeFilter,
): PageSummary[] {
  return filter === "all"
    ? [...pages]
    : pages.filter((page) => previewKind(page) === filter);
}

/** How often the grid reads again while something started here is being made. */
const MAKING_POLL_MS = 3_000;
/** The gap between the + options as they fan out, nearest the + first. */
const FAN_STAGGER_S = 0.045;

/** A task started here, and the pages there were when it started. */
type Started = { id: string; label: string; known: ReadonlySet<string> };

/**
 * The tasks started here that have not made their thing yet. One is done once a page arrives that
 * was not there when it started, each new page counting for one task, the oldest first, or once the
 * task stops: finished, or marked done.
 */
export function stillBeingMade(
  started: readonly Started[],
  pages: readonly PageSummary[] | undefined,
  tasks: readonly TaskRecord[] | undefined,
): Started[] {
  const claimed = new Set<string>();
  const arrived = new Set<string>();
  for (const entry of [...started].reverse()) {
    const fresh = pages?.find(
      (page) => !entry.known.has(page.id) && !claimed.has(page.id),
    );
    if (!fresh) continue;
    claimed.add(fresh.id);
    arrived.add(entry.id);
  }
  return started.filter((entry) => {
    if (arrived.has(entry.id)) return false;
    const task = tasks?.find((candidate) => candidate.id === entry.id);
    // Not read yet means just started. Stopped to ask the person something is still under way.
    return !task || task.status === "working" || task.status === "needs_input";
  });
}

export function MakeScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const name = bot?.name;
  const [filter, setFilter] = useState<MakeFilter>("all");
  const [fanned, setFanned] = useState(false);
  const [kind, setKind] = useState<MakeKind | null>(null);
  /** Tasks started from this screen, newest first, drawn as cards until what they made arrives. */
  const [started, setStarted] = useState<Started[]>([]);
  const [saved, setSaved] = useState(false);
  const tasks = useQuery({
    ...taskListQueryOptions(),
    enabled: started.length > 0,
  });
  const pages = useQuery({
    ...pageListQueryOptions(),
    refetchInterval: (query) =>
      stillBeingMade(started, query.state.data, tasks.data).length > 0
        ? MAKING_POLL_MS
        : false,
  });
  const making = stillBeingMade(started, pages.data, tasks.data);
  const reduced = useReducedMotionPreference();

  // Nothing while the Bots load: the title and the + both name one, and a placeholder is a flicker.
  if (agents.isPending) return null;
  const shown = pages.data ? filterPages(pages.data, filter) : [];
  return (
    <ScreenScroll
      overlay={
        bot ? (
          <MakeFan
            fanned={fanned}
            onPick={(picked) => {
              setFanned(false);
              setSaved(false);
              setKind(picked);
            }}
            onToggle={setFanned}
          />
        ) : null
      }
    >
      <ScreenTitle title="Make">
        {name ? `What ${name} made for you.` : "What your Bots made for you."}
      </ScreenTitle>
      {saved ? (
        <p className="type-sub mb-3 px-1 text-duet-ink-2" role="status">
          Saved for Up next on Tasks.
        </p>
      ) : null}
      {pages.isPending ? null : pages.error ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          Couldn't load what was made. Reload the page.
        </p>
      ) : pages.data.length === 0 && making.length === 0 ? (
        <DuetCard className="px-4 py-4">
          <p className="type-row font-semibold">Nothing made yet.</p>
          <p className="type-sub mt-0.5 text-duet-ink-2">
            Tap + and pick a page, deck, dashboard or doc. What{" "}
            {name ?? "your Bot"} makes shows up here.
          </p>
        </DuetCard>
      ) : (
        <>
          <MakeFilters current={filter} onPick={setFilter} />
          {shown.length === 0 && making.length === 0 ? (
            <p className="type-sub px-1 pt-2 text-duet-ink-2">
              No{" "}
              {MAKE_FILTERS.find(
                (entry) => entry.id === filter,
              )?.label.toLowerCase()}{" "}
              yet. Tap + to make one.
            </p>
          ) : (
            <ul aria-label="Made for you" className="grid grid-cols-2 gap-3">
              {making.map((entry) => (
                <motion.li key={entry.id} layout={!reduced}>
                  <MakingCard
                    label={entry.label}
                    task={tasks.data?.find((task) => task.id === entry.id)}
                    taskId={entry.id}
                  />
                </motion.li>
              ))}
              {shown.map((page) => (
                <motion.li key={page.id} layout={!reduced}>
                  <PageCard
                    link={({ className, children }) => (
                      <Link
                        className={className}
                        params={{ pageId: page.id }}
                        to="/make/$pageId"
                      >
                        {children}
                      </Link>
                    )}
                    page={page}
                    size="grid"
                  />
                </motion.li>
              ))}
            </ul>
          )}
        </>
      )}
      {/* Room for the last row to scroll clear of the +. */}
      {bot ? <div aria-hidden className="h-16" /> : null}
      {kind && bot ? (
        <NewTaskSheet
          bot={bot}
          onAdded={(where, task) => {
            setKind(null);
            if (where === "up_next" || !task) {
              setSaved(true);
              return;
            }
            setStarted((current) => [
              {
                id: task.id,
                label: kind.label.toLowerCase(),
                known: new Set((pages.data ?? []).map((page) => page.id)),
              },
              ...current,
            ]);
          }}
          onClose={() => setKind(null)}
          question={`What should ${bot.name} make?`}
          starter={kind.starter}
        />
      ) : null}
    </ScreenScroll>
  );
}

/** All, Pages, Decks, Dashboards; the one showing in ink. */
function MakeFilters({
  current,
  onPick,
}: {
  current: MakeFilter;
  onPick: (filter: MakeFilter) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle chips, not a form's fieldset.
    <div
      aria-label="Show"
      className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
      role="group"
    >
      {MAKE_FILTERS.map((entry) => {
        const on = entry.id === current;
        return (
          <button
            aria-pressed={on}
            className={cn(
              "type-label flex h-9 shrink-0 items-center rounded-full px-3.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
              on
                ? "bg-duet-black text-duet-on-black"
                : "bg-duet-card text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile",
            )}
            key={entry.id}
            onClick={() => onPick(entry.id)}
            type="button"
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A task started here that has not made its thing yet: the thumbnail's place, shimmering, and the
 * task's title and where it stands. It opens the task, where the person can follow it or steer it.
 */
function MakingCard({
  taskId,
  task,
  label,
}: {
  taskId: string;
  task: TaskRecord | undefined;
  label: string;
}) {
  return (
    <Link
      className="group block w-full rounded-[20px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
      params={{ taskId }}
      to="/tasks/$taskId"
    >
      <DuetCard className="rounded-[20px] transition-transform duration-150 motion-safe:group-active:scale-[0.985]">
        <div
          aria-hidden
          className="relative grid place-items-center overflow-hidden bg-duet-tile"
          style={{ height: 116 }}
        >
          <span className="duet-making absolute inset-0" />
          <span className="relative grid size-10 place-items-center rounded-full bg-duet-card text-duet-violet shadow-duet-card">
            <DuetIcon name="sparkle" size={20} stroke={1.9} />
          </span>
        </div>
        <div className="min-h-[64px] px-3 pt-2.5 pb-3">
          <p className="line-clamp-2 font-semibold text-[15px] text-duet-ink leading-[19px] tracking-[-0.01em]">
            {task?.title ?? `Making your ${label}`}
          </p>
          <span className="mt-1 flex">
            {task ? (
              <TaskStatusPill
                status={
                  task.status === "needs_input" ? "needs_input" : "working"
                }
              />
            ) : (
              <span className="type-label text-duet-ink-3">Starting…</span>
            )}
          </span>
        </div>
      </DuetCard>
    </Link>
  );
}

/**
 * The + and what it fans out: Page, Deck, Dashboard and Doc as pills stacked over it, the nearest
 * first, a beat apart. The + turns into × while they are out, and a tap anywhere else, or Escape,
 * folds them away. With reduced motion they fade in place.
 */
function MakeFan({
  fanned,
  onToggle,
  onPick,
}: {
  fanned: boolean;
  onToggle: (fanned: boolean) => void;
  onPick: (kind: MakeKind) => void;
}) {
  const reduced = useReducedMotionPreference();
  useEffect(() => {
    if (!fanned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onToggle(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fanned, onToggle]);
  const last = MAKE_KINDS.length - 1;
  return (
    <>
      <AnimatePresence>
        {fanned ? (
          <motion.button
            animate={{ opacity: 1 }}
            aria-label="Close"
            className="absolute inset-0 z-20 cursor-default bg-duet-surface/70 backdrop-blur-[3px]"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key="scrim"
            onClick={() => onToggle(false)}
            tabIndex={-1}
            transition={{ duration: 0.18 }}
            type="button"
          />
        ) : null}
      </AnimatePresence>
      <ul
        aria-label="What to make"
        className="pointer-events-none absolute right-4 bottom-[calc(var(--duet-tab-space,0px)+82px)] z-30 flex flex-col items-end gap-2.5"
        hidden={!fanned}
        id="make-kinds"
      >
        <AnimatePresence>
          {fanned
            ? MAKE_KINDS.map((kind, index) => {
                // Nearest the + goes first, so the stack unfolds upward from it.
                const order = last - index;
                return (
                  <motion.li
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className="pointer-events-auto"
                    exit={
                      reduced
                        ? { opacity: 0 }
                        : { opacity: 0, y: 10, scale: 0.92 }
                    }
                    initial={
                      reduced
                        ? { opacity: 0 }
                        : { opacity: 0, y: 14, scale: 0.92 }
                    }
                    key={kind.id}
                    transition={
                      reduced
                        ? { duration: 0.12 }
                        : {
                            type: "spring",
                            stiffness: 520,
                            damping: 34,
                            delay: order * FAN_STAGGER_S,
                          }
                    }
                  >
                    <button
                      aria-label={`Make a ${kind.label.toLowerCase()}`}
                      className="duet-glass type-row flex h-12 items-center gap-2.5 rounded-full py-1.5 pr-5 pl-1.5 font-semibold text-duet-ink shadow-duet-glass transition-transform focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
                      data-kind={kind.id}
                      onClick={() => onPick(kind)}
                      type="button"
                    >
                      <span className="grid size-9 place-items-center rounded-full bg-duet-card text-duet-ink shadow-duet-card">
                        <DuetIcon name={kind.icon} size={19} stroke={1.9} />
                      </span>
                      {kind.label}
                    </button>
                  </motion.li>
                );
              })
            : null}
        </AnimatePresence>
      </ul>
      <button
        aria-controls="make-kinds"
        aria-expanded={fanned}
        aria-label={fanned ? "Close" : "Make something"}
        className="absolute right-4 bottom-[calc(var(--duet-tab-space,0px)+14px)] z-30 grid size-14 place-items-center rounded-full bg-duet-black text-duet-on-black shadow-duet-raised transition-[filter,transform] hover:brightness-125 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
        onClick={() => onToggle(!fanned)}
        type="button"
      >
        <span
          className={cn(
            "transition-transform duration-200 ease-out motion-reduce:transition-none",
            fanned && "rotate-45",
          )}
        >
          <DuetIcon name="plus" size={26} stroke={2.4} />
        </span>
      </button>
    </>
  );
}
