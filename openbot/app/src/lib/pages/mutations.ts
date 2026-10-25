import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type PageRecord, pageKeys, pageRecordSchema } from "./queries";

export type ChecklistChange = {
  block: number;
  slide?: number;
  item: string;
  checked: boolean;
  /** Captured from the rendered page, never replaced with a newer cached revision. */
  expectedChecklistRevision: string;
};
export const checkPageMutationOptions = (
  queryClient: QueryClient,
  id: string,
) =>
  mutationOptions({
    // Whole-page responses must settle before another check or deletion starts.
    scope: { id: `page:${id}` },
    // A conflict needs a refreshed view and a new click, never an automatic replay of stale intent.
    retry: false,
    mutationFn: async (change: ChecklistChange) =>
      pageRecordSchema.parse(
        await client<unknown>(
          `/api/openduet/pages/${encodeURIComponent(id)}/checklist`,
          "page",
          {
            method: "PATCH",
            body: change,
            fallback: "Couldn't save that check. Try again.",
          },
        ),
      ),
    onSuccess: async (page) => {
      // Include reads started while saving: their older snapshots must not replace this response.
      await queryClient.cancelQueries({
        queryKey: pageKeys.detail(id),
        exact: true,
      });
      // A newer read may already have finished while this mutation response was in flight.
      queryClient.setQueryData<PageRecord>(pageKeys.detail(id), (current) =>
        current && Date.parse(current.updatedAt) > Date.parse(page.updatedAt)
          ? current
          : page,
      );
      await queryClient.invalidateQueries({ queryKey: pageKeys.list });
    },
  });
export const deletePageMutationOptions = (
  queryClient: QueryClient,
  id: string,
) =>
  mutationOptions({
    // Remove the cache after earlier checklist success handlers have finished writing it.
    scope: { id: `page:${id}` },
    mutationFn: () =>
      client(`/api/openduet/pages/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't delete this page. Try again.",
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: pageKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: pageKeys.list });
    },
  });
