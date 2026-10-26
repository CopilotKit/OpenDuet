/**
 * The morning brief's frame and reader, re-exported from the one place they are declared, as
 * `routine-firing.ts` beside it does for the firing frame: browser code keeps importing through
 * `@/`, and the path to `shared/` is written down once.
 */
export {
  frameMorningBrief,
  localDateOf,
  MORNING_BRIEF_TOOL,
  readMorningBrief,
} from "@openbot/shared/morning-brief";
