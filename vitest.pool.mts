import { availableParallelism } from 'node:os';

/**
 * Under ADR-0014 several runner slots run `pnpm test` at once on the same
 * machine. Vitest's default pool spawns ~one worker per core *per slot*, so N
 * slots oversubscribe the CPU N-fold and the 5s test timeout fires on specs
 * that finish in milliseconds when run alone (#547). Cap each slot's worker
 * count to its fair share of cores; CI/single-slot leave SLOT_COUNT unset or 1
 * -> {} -> full parallelism, unchanged (ADR-0014 AK9).
 *
 * `cores` is injectable so the unit test is deterministic across machines.
 */
export function slotWorkerLimit(
  slotCount = Number(process.env.SLOT_COUNT) || 1,
  cores = availableParallelism(),
): { maxWorkers: number; minWorkers: number } | Record<string, never> {
  if (slotCount <= 1) return {};
  return { maxWorkers: Math.max(1, Math.floor(cores / slotCount)), minWorkers: 1 };
}
