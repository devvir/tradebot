import { MongoClient } from 'mongodb';

const mongoProd = 'mongodb://readerdb:udsa09djd@localhost:27018/tradebot?authSource=admin';

const instrumentFields = [
  'totalVolume',
  'volume',
  'volume24h',
  'totalTurnover',
  'turnover',
  'turnover24h',
  'homeNotional24h',
  'foreignNotional24h',
  'prevPrice24h',
  'lowPrice',
  'lastPrice',
  'lastPriceProtected',
  'lastTickDirection',
  'lastChangePcnt',
  'bidPrice',
  'midPrice',
  'askPrice',
  'impactBidPrice',
  'impactMidPrice',
  'impactAskPrice',
  'openInterest',
  'openValue',
  'fairBasis',
  'fairPrice',
  'markPrice',
  'indicativeSettlePrice',
];

async function checkInstrumentFields() {
  const client = new MongoClient(mongoProd);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('tradebot_baseline');
    const collection = db.collection('instrument');

    const totalDocs = await collection.countDocuments();
    console.log(`\nTotal documents in instrument collection: ${totalDocs}\n`);

    const rare = [];
    const common = [];

    const LIMIT = 10000000;

    for (const field of instrumentFields) {
      const count = await collection.countDocuments({ [`data.${field}`]: { $exists: true } }, { limit: LIMIT });
      if (count < LIMIT) console.log(`Field ${field} is present in ${count} documents`);

      if (count < LIMIT) {
        rare.push(field);
      } else {
        common.push(field);
      }
    }

    console.log(`=== FIELDS THAT ARE PRESENT IN ${LIMIT}+ DOCUMENTS ===`);
    console.log(`Total: ${common.length}\n`);
    common.forEach((field) => {
      console.log(`✓ ${field}`);
    });

    console.log(`\n=== FIELDS THAT ARE PRESENT IN <${LIMIT} DOCUMENTS ===`);
    console.log(`Total: ${rare.length}\n`);
    rare.forEach((field) => {
      console.log(`✗ ${field}`);
    });
  } finally {
    await client.close();
  }
}

checkInstrumentFields().catch(console.error);
