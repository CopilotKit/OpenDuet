/**
 * The first-day frame's reader, re-exported from the one place it is declared, as
 * `routine-firing.ts` beside it does for the firing frame: browser code keeps importing through
 * `@/`, and the path to `shared/` is written down once.
 */
export {
  type FirstDayGreeting,
  firstDayGreeting,
  frameFirstDay,
  readFirstDay,
} from "@openbot/shared/first-day";
