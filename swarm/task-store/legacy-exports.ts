/**
 * Legacy exports helper — re-exports from both the JSONL and br backends
 * so the barrel index.ts can reference them without circular imports.
 */

// Types
export type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence } from '../types.js';

// JSONL backend (original)
export * as jsonlQueries from './queries.js';
export * as jsonlCommands from './commands.js';
export * as jsonlCleanup from './cleanup.js';

// br backend (Phase 1)
export * as brQueries from '../br-task-store.js';
export * as brCommands from '../br-task-store.js';
