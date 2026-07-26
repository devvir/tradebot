/**
 * The only surface this submodule exposes:
 *   - `nextTask()`     — orchestration's sole public verb for getting work
 *   - `releaseTask(t)` — return a task to the pool on failure (e.g. read error);
 *                        the bucket reappears in `pending` on the next refresh
 *   - the `Task` type, for typed references on pipeline items
 *
 * Anything else lives behind one of the internal modules (progress,
 * manager, task) and can be redesigned without affecting the rest of
 * the service.
 */

export { nextTask, releaseTask } from './manager';
export { Task } from './task';
export type { StopSignal } from './task';
