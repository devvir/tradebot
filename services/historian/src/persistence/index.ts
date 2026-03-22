export type { HistoryState } from './state.js';
export type { SubTablePersist, PersistenceService, WriteResult } from './service.js';

export { createPersistenceService } from './service.js';
export { buildSubTableId, makeInitialState, loadAllStates, saveState } from './state.js';
export { verifyFirstTimestamps } from './verify.js';
export { upsertDocuments } from './writer.js';
