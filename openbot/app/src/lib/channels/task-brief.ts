/**
 * The task frame's reader, re-exported from the one place it is declared, as `check-in.ts` beside it
 * does for the check-in frame: browser code keeps importing through `@/`, and the path to `shared/`
 * is written down once.
 */
export { readTaskBrief, START_TASK_TOOL } from "@openbot/shared/task-brief";
