import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { SortOrder } from "@/lib/tasks/groups";
import { cn } from "@/lib/utils";
import { NewTaskSheet } from "./new-task-sheet";
import { ScreenScroll } from "./screen";
import { ActiveView } from "./tasks-active";
import { UpNextView } from "./tasks-up-next";

/** Which list Tasks shows: what is under way, or what nobody has started yet. */
export type TasksView = "active" | "up_next";

/** Which list was open last, kept in this browser between visits. */
export const TASKS_VIEW_STORAGE_KEY = "openduet.tasks-view";

/** The list left open last time. A key never written, or storage this browser refuses, is Active. */
function rememberedView(): TasksView {
  try {
    return window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY) === "up_next"
      ? "up_next"
      : "active";
  } catch {
    return "active";
  }
}

function rememberView(view: TasksView): void {
  try {
    window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be unavailable or full. The list still switches; it just opens on Active next time.
  }
}

/**
 * The Tasks tab, as two lists under one switch. Active holds what is under way and what needs the
 * person, grouped by what each thing needs. Up next holds what nobody has started: OpenDuet's
 * suggestions and the tasks the person asked to add. The switch stays at the top while the list
 * scrolls, with sort and search beside it, and the + at the foot adds a task.
 */
export function TasksScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const [view, setView] = useState<TasksView>(rememberedView);
  const [order, setOrder] = useState<SortOrder>("newest");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const show = (next: TasksView) => {
    setView(next);
    rememberView(next);
  };
  // Nothing while the Bots load: both lists name one, and a placeholder here is a flicker.
  if (agents.isPending) return null;
  return (
    <ScreenScroll
      overlay={
        bot ? (
          /*
           * IN PIXELS, NOT REM, LIKE THE SPACER AT THE FOOT OF THE LIST. It is an icon, and an icon
           * does not get bigger when the person's text does. In rem it was 112px across at 200% text,
           * and it sat over the first row's title and status. The spacer below is sized from it, so
           * the last row can always scroll clear of it.
           */
          <button
            aria-label="Add a task"
            className="absolute right-[16px] bottom-[calc(var(--duet-tab-space,0px)+14px)] z-20 grid size-[56px] place-items-center rounded-full bg-duet-black text-duet-on-black shadow-duet-raised transition-[filter,transform] hover:brightness-125 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
            onClick={() => setAdding(true)}
            type="button"
          >
            <DuetIcon name="plus" size={26} stroke={2.4} />
          </button>
        ) : null
      }
    >
      <TasksSwitch
        onClose={() => {
          setSearching(false);
          setQuery("");
        }}
        onOrder={() =>
          setOrder((current) => (current === "newest" ? "oldest" : "newest"))
        }
        onQuery={setQuery}
        onSearch={() => setSearching(true)}
        onView={show}
        order={order}
        query={query}
        searching={searching}
        view={view}
      />
      {agents.data ? null : (
        <p className="type-sub mb-3 px-1 text-duet-red" role="alert">
          Couldn't load your Bots. Reload the page.
        </p>
      )}
      <div
        aria-labelledby={`tasks-tab-${view}`}
        id="tasks-panel"
        role="tabpanel"
      >
        {view === "active" ? (
          <ActiveView
            agents={agents.data}
            bot={bot}
            order={order}
            query={query}
          />
        ) : (
          <UpNextView
            agents={agents.data}
            bot={bot}
            order={order}
            query={query}
          />
        )}
      </div>
      {/*
       * Room for the last row to scroll clear of the +: its 56px and its 14px lift, less the 32px the
       * list already ends with, and a little air. Pixels, as the button is.
       */}
      {bot ? <div aria-hidden className="h-[64px]" /> : null}
      {adding && bot ? (
        <NewTaskSheet
          bot={bot}
          onAdded={(where) => {
            setAdding(false);
            show(where);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </ScreenScroll>
  );
}

/**
 * Active and Up next as two large words, the one showing in ink and the other grey, with sort and
 * search on the right. It sticks under the header while the list scrolls: 80px from the top of the
 * screen, just under the discs, which is -20px here, since a sticky box is held inside the list's
 * 100px top padding.
 * Search opens a field under it that narrows both lists by title.
 *
 * IT WRAPS RATHER THAN RUNS OFF THE SCREEN. The two words are display size and follow the person's
 * text size; at 200% they are wider than a phone, and the row used to keep them on one line and push
 * sort and search past the right edge, where search could not be reached at all. Now the words wrap
 * onto a second line when they must, and sort and search drop under them, kept at the right.
 */
function TasksSwitch({
  view,
  onView,
  order,
  onOrder,
  searching,
  onSearch,
  query,
  onQuery,
  onClose,
}: {
  view: TasksView;
  onView: (view: TasksView) => void;
  order: SortOrder;
  onOrder: () => void;
  searching: boolean;
  onSearch: () => void;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const sortLabel =
    order === "newest" ? "Sort: newest first" : "Sort: oldest first";
  return (
    <div
      className={cn(
        "sticky top-[-20px] z-30 -mx-4 mb-3 bg-duet-surface px-5 pt-1 pb-2",
        // Solid up to the header's discs, and a short fade under it, so rows don't show through.
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-[14px] before:bg-duet-surface before:content-['']",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-[linear-gradient(var(--duet-surface),transparent)] after:content-['']",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          aria-label="Tasks"
          className="flex min-w-0 flex-wrap items-baseline gap-x-4"
          role="tablist"
        >
          <SwitchTab id="active" onView={onView} view={view}>
            Active
          </SwitchTab>
          <SwitchTab id="up_next" onView={onView} view={view}>
            Up next
          </SwitchTab>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <IconButton icon="sort" label={sortLabel} onClick={onOrder} />
          <IconButton
            expanded={searching}
            icon="search"
            label="Search tasks"
            onClick={() => {
              if (searching) {
                field.current?.focus();
                return;
              }
              onSearch();
            }}
          />
        </div>
      </div>
      {searching ? (
        // Fades in under the switch as it opens, with a short drop that reduced motion leaves out.
        <div className="duet-glass mt-2.5 flex h-11 items-center gap-2 rounded-full pr-1 pl-4 shadow-duet-glass animate-in fade-in duration-[var(--duet-dur-swap)] ease-[var(--duet-ease-out)] motion-safe:slide-in-from-top-1">
          <DuetIcon className="text-duet-ink-3" name="search" size={18} />
          <input
            aria-label="Search tasks"
            // biome-ignore lint/a11y/noAutofocus: opened by the search button, so focus belongs here.
            autoFocus
            className="type-sub min-w-0 flex-1 bg-transparent text-duet-ink outline-none placeholder:text-duet-ink-3"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder="Search tasks"
            ref={field}
            type="search"
            value={query}
          />
          <button
            aria-label="Close search"
            className="grid size-9 shrink-0 place-items-center rounded-full text-duet-ink-2 transition-colors hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
            onClick={onClose}
            type="button"
          >
            <DuetIcon name="x" size={18} stroke={2.2} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SwitchTab({
  id,
  view,
  onView,
  children,
}: {
  id: TasksView;
  view: TasksView;
  onView: (view: TasksView) => void;
  children: ReactNode;
}) {
  const on = id === view;
  return (
    <button
      aria-controls="tasks-panel"
      aria-selected={on}
      className={cn(
        "type-big rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
        on ? "text-duet-ink" : "text-duet-ink-3 hover:text-duet-ink-2",
      )}
      id={`tasks-tab-${id}`}
      onClick={() => onView(id)}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  expanded,
}: {
  icon: DuetIconName;
  label: string;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      // 44px, the smallest tap target (parity-spec 2.11), and in pixels: an icon, like the +.
      className="duet-glass grid size-[44px] place-items-center rounded-full text-duet-ink shadow-duet-glass transition-transform focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
      onClick={onClick}
      title={label}
      type="button"
    >
      <DuetIcon name={icon} size={19} stroke={2} />
    </button>
  );
}
