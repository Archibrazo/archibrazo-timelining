import type { Session } from 'neo4j-driver';

export interface EntrySourceBackfillResult {
  /** Entries that had no source before this run. */
  missing: number;
  /** Entries still without a source after this run. */
  remaining: number;
}

/**
 * Sets `source` and `topic` on entries written before entries had them.
 * Every such entry came from Telegram, so its topic is its chat's topic.
 * Safe to run more than once: entries that already have a source are skipped.
 */
export async function backfillEntrySource(session: Session): Promise<EntrySourceBackfillResult> {
  const countMissing = async (): Promise<number> => {
    const result = await session.run(
      `
      MATCH (e:Entry)
      WHERE e.source IS NULL
      RETURN count(e) AS missing
      `
    );
    return result.records[0].get('missing').toNumber();
  };

  const missing = await countMissing();

  if (missing > 0) {
    await session.run(
      `
      MATCH (e:Entry)
      WHERE e.source IS NULL
      CALL {
        WITH e
        OPTIONAL MATCH (e)-[:FROM_CHAT]->(c:TelegramChat)
        WITH e, head(collect(c.topic)) AS topic
        SET e.source = 'telegram', e.topic = topic
      } IN TRANSACTIONS OF 1000 ROWS
      `
    );
  }

  return { missing, remaining: await countMissing() };
}
