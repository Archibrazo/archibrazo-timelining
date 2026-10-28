import { backfillEntrySource } from '../../src/services/entrySourceBackfill';
import { createNeo4jDriver } from './env';

async function main(): Promise<void> {
  const driver = await createNeo4jDriver();
  const session = driver.session({ database: 'neo4j' });

  try {
    const { missing, remaining } = await backfillEntrySource(session);

    console.log('\nEntry source backfill');
    console.log('────────────────────────────────────────────');
    if (missing === 0) {
      console.log('Nothing to backfill — every entry already has a source.');
    } else {
      console.log(`Set source and topic on ${missing - remaining} of ${missing} entries.`);
    }
    console.log('────────────────────────────────────────────');

    if (remaining > 0) {
      process.exitCode = 1;
      console.error(`${remaining} entries still have no source. Run the backfill again.`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
