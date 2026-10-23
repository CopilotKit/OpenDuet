/**
 * The channel hello frame's reader, re-exported from the one place it is declared, as
 * `first-day.ts` beside it does for the first-day frame: browser code keeps importing through `@/`,
 * and the path to `shared/` is written down once.
 */
export {
  CHANNEL_HELLO_QUESTION,
  readChannelHello,
} from "@openbot/shared/channel-hello";
