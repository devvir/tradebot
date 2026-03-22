import readline from 'node:readline';
import { Db, MongoClient } from 'mongodb';
import { info, success, warn, error, spacer } from '../../shared/ui/logger';

export function startREPL(db: Db, client: MongoClient, collectionName?: string): void {
  info('Enter MongoDB queries (JSON format) or collection commands');
  console.log('  :collections          - List all collections');
  console.log('  :find <collection>    - Find first 10 documents');
  console.log('  :count <collection>   - Count documents');
  console.log('  :stats <collection>   - Collection statistics');
  console.log('  :exit                 - Exit');
  spacer();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (! trimmed) return;

    if (trimmed.startsWith(':')) {
      await handleCommand(db, client, rl, trimmed);
    } else if (collectionName) {
      try {
        const query = JSON.parse(trimmed);
        const docs = await db.collection(collectionName).find(query).limit(20).toArray();
        console.log(`Found ${docs.length} documents:\n`, JSON.stringify(docs, null, 2));
      } catch (err) {
        error(`Error: ${(err as Error).message}`);
      }
    } else {
      warn('Specify collection with --collection flag or use :find command');
    }
  });

  rl.on('close', async () => {
    await client.close();
    success('Disconnected');
  });
}

async function handleCommand(db: Db, _client: MongoClient, rl: readline.Interface, input: string): Promise<void> {
  const [cmd, ...args] = input.split(/\s+/);

  switch (cmd) {
    case ':collections': {
      const collections = await db.listCollections().toArray();
      console.log(`Found ${collections.length} collections:`);
      collections.forEach((col, idx) => console.log(`  ${idx + 1}. ${col.name}`));
      break;
    }

    case ':find': {
      const name = args[0];
      if (! name) { warn('Usage: :find <collection>'); break; }
      try {
        const docs = await db.collection(name).find().limit(10).toArray();
        console.log(`Found ${docs.length} documents in ${name}:\n`, JSON.stringify(docs, null, 2));
      } catch (err) {
        error(`Error: ${(err as Error).message}`);
      }
      break;
    }

    case ':count': {
      const name = args[0];
      if (! name) { warn('Usage: :count <collection>'); break; }
      try {
        const count = await db.collection(name).countDocuments();
        info(`${name}: ${count} documents`);
      } catch (err) {
        error(`Error: ${(err as Error).message}`);
      }
      break;
    }

    case ':stats': {
      const name = args[0];
      if (! name) { warn('Usage: :stats <collection>'); break; }
      try {
        const count = await db.collection(name).countDocuments();
        const stats = await (db.collection(name) as any).stats();
        info(`${name}:`);
        console.log(`  Documents: ${count}`);
        console.log(`  Avg Size: ${Math.round((stats as any).avgObjSize)} bytes`);
        console.log(`  Total Size: ${Math.round((stats as any).size / 1024)} KB`);
      } catch (err) {
        error(`Error: ${(err as Error).message}`);
      }
      break;
    }

    case ':exit':
    case ':quit':
      rl.close();
      break;

    default:
      warn(`Unknown command: ${cmd}`);
  }
}
