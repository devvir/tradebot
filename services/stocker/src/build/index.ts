/**
 * Building a partition into staging: its instruments' files written from their
 * archives, a staged month joined into one file, and the scratch a build leaves
 * cleared.
 */
export { buildBatch, wrappedFor } from './batch';
export { bundleStaged } from './bundle';
export { buildGroup } from './group';
export { dropOverlap } from './overlap';
export { PIECES, finishPiece, finishedPiece, joinPieces, keepPieces, pieceDirOf } from './pieces';
export { sweepScratch } from './scratch';
