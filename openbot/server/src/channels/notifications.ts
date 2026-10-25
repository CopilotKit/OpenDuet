import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { CHANNEL_ACTIVITY_TOPIC, type ChannelActivityEvent } from "./events";

/** Leave room for event metadata and at least one ordinary recipient; measure the rest below. */
export const MAX_CHANNEL_EVENT_TEXT_BYTES = 4_096;
const MAX_NOTIFY_BYTES = 7_999;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * NOTIFY limits the complete JSON payload, not its text fields or character count. Partition the
 * recipients, retaining the same event for each member. All batches commit with the row mutation;
 * the hub delivers by memberIds, so each member still hears the change exactly once.
 */
export async function announceChannelActivity(
  transaction: Transaction,
  event: ChannelActivityEvent,
): Promise<void> {
  const baseBytes = Buffer.byteLength(
    JSON.stringify({ ...event, memberIds: [] }),
    "utf8",
  );
  const send = (memberIds: string[]) =>
    transaction.execute(
      sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify({ ...event, memberIds })})`,
    );
  let members: string[] = [];
  let bytes = baseBytes;
  for (const memberId of event.memberIds) {
    const memberBytes = Buffer.byteLength(JSON.stringify(memberId), "utf8");
    // Generated IDs are short, but database text columns do not enforce that convention. Fail
    // explicitly if a single recipient cannot fit; never skip that person or keep flushing forever.
    if (baseBytes + memberBytes > MAX_NOTIFY_BYTES) {
      throw new RangeError("Channel notification cannot fit one recipient.");
    }
    if (bytes + memberBytes + (members.length > 0 ? 1 : 0) > MAX_NOTIFY_BYTES) {
      await send(members);
      members = [];
      bytes = baseBytes;
    }
    bytes += memberBytes + (members.length > 0 ? 1 : 0);
    members.push(memberId);
  }
  if (members.length > 0) await send(members);
}
