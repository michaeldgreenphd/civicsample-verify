import { z } from 'zod';
import { PostgrestClient } from '../lib/postgrest';
import { HttpError } from '../lib/auth';
import type { PracticeObserverWorkspace } from '../lib/practice-observer';
import { readTraining, type Mu7Data } from './mu7-core';
import { supabaseRuntime, type SessionActor } from './session';
const responseSchema = z
  .object({
    pilotUnits: z.number().int().nonnegative(),
    locked: z.boolean(),
    completion: z.array(
      z
        .object({
          reviewer_slot: z.number().int(),
          assigned: z.number().int().nonnegative(),
          answered: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    training: z.array(
      z
        .object({ training_unit_id: z.string(), packet: z.record(z.string(), z.unknown()) })
        .strict(),
    ),
  })
  .strict();
export async function getPracticeObserverWorkspace(
  actor: SessionActor,
): Promise<PracticeObserverWorkspace> {
  if (!actor.accessToken || actor.role !== 'INVESTIGATOR' || actor.practiceReadOnly !== true)
    throw new HttpError(403, 'View-only practice access required.');
  const c = new PostgrestClient(supabaseRuntime().config, actor.accessToken, () => null);
  const result = responseSchema.parse(await c.rpc('rpc_practice_observer_workspace', {}));
  // Use the same allowlisted teaching-packet DTO as the reviewer screen.
  const training = await readTraining({
    select: async () => result.training,
    rpc: async () => {
      throw new Error('No writes in observer projection');
    },
  } as Mu7Data);
  return {
    pilotUnits: result.pilotUnits,
    locked: result.locked,
    completion: result.completion.map((r) => ({
      reviewerSlot: r.reviewer_slot,
      assigned: r.assigned,
      answered: r.answered,
    })),
    training,
  };
}
