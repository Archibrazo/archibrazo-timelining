// Needs the test Neo4j from test/test-env (pnpm test starts it).
import { Session } from 'neo4j-driver';
import { closeDriver, getDriver, initDriver } from '../../src/lib/db/neo4j';
import { FullEntryInputData } from '../../src/lib/db/models/entry';
import { createEntry, readEntry } from '../../src/services/entryService';
import { backfillEntrySource } from '../../src/services/entrySourceBackfill';

jest.setTimeout(30000);

// Synthetic ids, far from real Telegram ones, so cleanup can't touch real data.
const CHAT_ID = -990001;
const MESSAGE_ID = 990001;
const LEGACY_MESSAGE_ID = 990002;
const ORPHAN_MESSAGE_ID = 990003;
const HANDLE = 'entry_source_test';

const forumEntry: FullEntryInputData = {
  entry: { updateId: 990001, messageId: MESSAGE_ID, date: '2026-10-28T12:00:00.000Z' },
  participant: { handle: HANDLE },
  chat: { id: CHAT_ID, title: 'Entry source test', type: 'supergroup', isForum: true, topic: '_botDecidir' },
  textContent: { text: 'A decision to record.' },
  entities: [],
  photos: [],
  videos: [],
};

async function cleanup(session: Session): Promise<void> {
  await session.run(
    `MATCH (e:Entry) WHERE e.messageId IN $ids DETACH DELETE e`,
    { ids: [MESSAGE_ID, LEGACY_MESSAGE_ID, ORPHAN_MESSAGE_ID] }
  );
  await session.run(`MATCH (c:TelegramChat {id: $id}) DETACH DELETE c`, { id: CHAT_ID });
  await session.run(`MATCH (t:TextContent {text: $text}) DETACH DELETE t`, { text: forumEntry.textContent?.text });
  await session.run(`MATCH (p:Participant {handle: $handle}) DETACH DELETE p`, { handle: HANDLE });
}

describe('Entry source and topic', () => {
  let session: Session;

  beforeAll(async () => {
    await initDriver();
    session = getDriver().session();
    await cleanup(session);
  });

  afterAll(async () => {
    await cleanup(session);
    await session.close();
    await closeDriver();
  });

  it('writes source telegram and the chat topic on a new entry', async () => {
    const id = await createEntry(forumEntry);
    const entry = await readEntry(id);

    expect(entry.entry.source).toBe('telegram');
    expect(entry.entry.topic).toBe('_botDecidir');
    expect(entry.chat.topic).toBe('_botDecidir');
  });

  it('backfills entries written before sources existed', async () => {
    await session.run(
      `
      MATCH (c:TelegramChat {id: $chatId})
      CREATE (:Entry {id: randomUUID(), messageId: $legacy, date: datetime()})-[:FROM_CHAT]->(c)
      CREATE (:Entry {id: randomUUID(), messageId: $orphan, date: datetime()})
      `,
      { chatId: CHAT_ID, legacy: LEGACY_MESSAGE_ID, orphan: ORPHAN_MESSAGE_ID }
    );

    const result = await backfillEntrySource(session);
    expect(result.missing).toBeGreaterThanOrEqual(2);
    expect(result.remaining).toBe(0);

    const rows = await session.run(
      `
      MATCH (e:Entry) WHERE e.messageId IN [$legacy, $orphan]
      RETURN e.messageId AS messageId, e.source AS source, e.topic AS topic
      ORDER BY messageId
      `,
      { legacy: LEGACY_MESSAGE_ID, orphan: ORPHAN_MESSAGE_ID }
    );
    const backfilled = rows.records.map((r) => ({
      messageId: Number(r.get('messageId')),
      source: r.get('source'),
      topic: r.get('topic'),
    }));

    expect(backfilled).toEqual([
      { messageId: LEGACY_MESSAGE_ID, source: 'telegram', topic: '_botDecidir' },
      { messageId: ORPHAN_MESSAGE_ID, source: 'telegram', topic: null },
    ]);
  });

  it('does nothing on a second run', async () => {
    const result = await backfillEntrySource(session);
    expect(result).toEqual({ missing: 0, remaining: 0 });
  });
});
