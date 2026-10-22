import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DuetCard } from "@/components/duet/kit";
import { PageCard } from "@/components/duet/page-card";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { pageListQueryOptions } from "@/lib/pages/queries";
import { ScreenScroll, ScreenTitle } from "./screen";

/**
 * The Pages tab: everything the Bot made for the person, as the same cards Chat draws, the most
 * recently changed first. A card opens its page over the list.
 */
export function PagesScreen() {
  const agents = useQuery(agentListQueryOptions());
  const pages = useQuery(pageListQueryOptions());
  const name = primaryBot(agents.data)?.name;
  return (
    <ScreenScroll>
      <ScreenTitle title="Pages">
        {name ? `What ${name} made for you.` : "What your Bots made for you."}
      </ScreenTitle>
      {pages.isPending ? null : pages.error ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          Couldn't load your pages. Reload the page.
        </p>
      ) : pages.data.length === 0 ? (
        <DuetCard className="px-4 py-4">
          <p className="type-row font-semibold">Nothing here yet.</p>
          <p className="type-sub mt-0.5 text-duet-ink-2">
            Ask {name ?? "your Bot"} for prep notes, a plan, a deck or a
            dashboard. What it makes shows up here.
          </p>
        </DuetCard>
      ) : (
        <ul aria-label="Pages" className="flex flex-col gap-3">
          {pages.data.map((page) => (
            <li key={page.id}>
              <PageCard
                link={({ className, children }) => (
                  <Link
                    className={className}
                    params={{ pageId: page.id }}
                    to="/pages/$pageId"
                  >
                    {children}
                  </Link>
                )}
                page={page}
              />
            </li>
          ))}
        </ul>
      )}
    </ScreenScroll>
  );
}
