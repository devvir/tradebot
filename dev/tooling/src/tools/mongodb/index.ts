import { connectMongo } from '../../shared/connections/mongodb';
import { section, spacer } from '../../shared/ui/logger';
import { startREPL } from './repl';

interface QueryOptions {
  list?: boolean;
  collection?: string;
}

export async function run(_queryArg?: string, options: QueryOptions = {}): Promise<void> {
  section('MongoDB Tool');
  spacer();

  const { client, db } = await connectMongo();
  spacer();

  if (options.list) {
    section('Collections');

    const collections = await db.listCollections().toArray();

    console.log(`\nCollections (${collections.length}):`);
    collections.forEach((col, idx) => console.log(`  ${idx + 1}. ${col.name}`));

    spacer();
    section('Collection Stats');

    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      console.log(`${col.name}: ${count} documents`);
    }

    spacer();
    return;
  }

  startREPL(db, client, options.collection);
}
