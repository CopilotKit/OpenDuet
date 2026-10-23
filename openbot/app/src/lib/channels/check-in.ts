import { createContext } from "react";
import type { CheckIn } from "@openbot/shared/check-in";

/**
 * The check-in frame's reader, re-exported from the one place it is declared, as
 * `routine-firing.ts` beside it does for the firing frame: browser code keeps importing through
 * `@/`, and the path to `shared/` is written down once.
 */
export {
  type CheckIn,
  type CheckInOffer,
  OFFER_TASK_TOOL,
  readCheckIn,
} from "@openbot/shared/check-in";

/**
 * Told each time a check-in's line is drawn in the transcript. Chat provides it, to raise a browser
 * notification for one that arrives while the page is hidden; anywhere else it is null and a
 * check-in is only drawn.
 */
export const CheckInArrivalContext = createContext<
  ((checkIn: CheckIn) => void) | null
>(null);
