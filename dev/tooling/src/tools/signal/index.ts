import { connectMongo } from '../../shared/connections/mongodb';
import { success, error, section, spacer, warn } from '../../shared/ui/logger';

interface SignalOptions {
  latest?: boolean;
  symbol?: string;
}

interface Signal {
  timestamp?: Date | string;
  symbol?: string;
  type?: string;
  direction?: string;
  strength?: number;
  price?: number;
  reason?: string;
}

export async function run(options: SignalOptions = {}): Promise<void> {
  section('Signal Service Tool');
  spacer();

  const { client, db } = await connectMongo();

  try {
    spacer();

    const signalsCollection = db.collection('signals');

    const query: Record<string, any> = {};
    if (options.symbol) query.symbol = options.symbol;

    let signals: Signal[];

    if (options.latest) {
      signals = (await signalsCollection
        .find(query)
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray()) as Signal[];
    } else {
      signals = (await signalsCollection.find(query).limit(50).toArray()) as Signal[];
    }

    if (signals.length === 0) {
      warn('No signals found');
      await client.close();
      return;
    }

    section(`Signals (${signals.length})${options.symbol ? ` - ${options.symbol}` : ''}`);
    spacer();

    signals.forEach((signal, idx) => {
      const timestamp =
        signal.timestamp instanceof Date ? signal.timestamp.toISOString() : signal.timestamp;

      console.log(`${idx + 1}. [${timestamp}] ${signal.symbol || 'N/A'} - ${signal.type || 'SIGNAL'}`);

      if (signal.direction) console.log(`   Direction: ${signal.direction}`);
      if (signal.strength !== undefined) console.log(`   Strength: ${signal.strength}%`);
      if (signal.price !== undefined) console.log(`   Price: ${signal.price}`);
      if (signal.reason) console.log(`   Reason: ${signal.reason}`);
      console.log();
    });

    section('Summary');

    const symbolCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};

    signals.forEach(sig => {
      const symbol = sig.symbol || 'unknown';
      const type = sig.type || 'unknown';
      symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    console.log('\nBy Symbol:');
    Object.entries(symbolCounts).forEach(([s, c]) => console.log(`  ${s}: ${c}`));

    console.log('\nBy Type:');
    Object.entries(typeCounts).forEach(([t, c]) => console.log(`  ${t}: ${c}`));

    spacer();
    success(`Total: ${signals.length} signals`);

    await client.close();
  } catch (err) {
    error(`Failed to fetch signals: ${(err as Error).message}`);
    throw err;
  }
}
