import type { Db } from '@devvir/service-kit';

export const upsertDocuments = async (
  db: Db,
  collectionName: string,
  idFields: string[] | null,
  documents: Record<string, unknown>[]
): Promise<void> => {
  const collection = db.collection(collectionName);

  if (idFields === null) {
    // No unique key — insert only. _seq is the dedup mechanism.
    if (documents.length > 0) {
      await collection.insertMany(documents as never[], { ordered: false });
    }

    return;
  }

  await Promise.all(
    documents.map((doc) => {
      const id =
        idFields.length === 1
          ? doc[idFields[0]]
          : idFields.map((f) => doc[f]).join(':');
      const docWithId = { ...doc, _id: id };

      return collection.replaceOne({ _id: id as never }, docWithId as never, { upsert: true });
    })
  );
};
