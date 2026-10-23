import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type SetupChecklist, setupKeys } from "./queries";

/**
 * "Check again": the server asks Intelligence and the model provider again, then answers the
 * checklist, which replaces the one on screen. Asking them is the server's job, and it holds the
 * keys; the browser only says when.
 */
export function recheckSetupMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<SetupChecklist> =>
      client("/api/openduet/setup/check", "checklist", {
        method: "POST",
        fallback: "Couldn't check your setup.",
      }),
    onSuccess: (checklist) =>
      queryClient.setQueryData(setupKeys.checklist(), checklist),
  });
}
