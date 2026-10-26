import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  formalIntakeSchema,
  intakeRequestSchema,
  type FormalIntakePlan,
} from '../lib/formal-intake';
import type { Mu7Context } from './mu7-core';
import { ServiceError } from './service';

function investigator(ctx: Mu7Context) {
  if (ctx.role !== 'INVESTIGATOR')
    throw new ServiceError(403, 'An investigator account is required.');
}
export async function readFormalIntakeFile(file: string | undefined, expected: string | undefined) {
  if (!file || !expected)
    throw new ServiceError(503, 'The private sample intake has not been connected to this server.');
  try {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error();
    const path = await realpath(file);
    if (resolve(file) !== path) throw new Error();
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      let inRepo = false;
      try {
        await access(join(dir, '.git'));
        inRepo = true;
      } catch {
        /* absent */
      }
      if (inRepo) throw new Error();
      if (dirname(dir) === dir) break;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_000_000 || (info.mode & 0o077) !== 0) throw new Error();
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error();
      return formalIntakeSchema.parse(JSON.parse(bytes.toString('utf8')));
    } finally {
      await handle.close();
    }
  } catch {
    throw new ServiceError(
      503,
      'The private sample failed its integrity check. Reconnect the verified preparation file.',
    );
  }
}
const input = () =>
  readFormalIntakeFile(
    process.env.VERIFY_FORMAL_INTAKE_FILE,
    process.env.VERIFY_FORMAL_INTAKE_SHA256,
  );
export async function formalIntakePlan(ctx: Mu7Context): Promise<FormalIntakePlan> {
  investigator(ctx);
  const plan = await input();
  const state = await ctx.withData((d) =>
    d.rpc<{ state: string }>('rpc_mu81_intake_status', {}, 'value'),
  );
  if (!state || !['EMPTY', 'OCCUPIED', 'RECORDED', 'CLOSED'].includes(state.state))
    throw new ServiceError(502, 'The database did not return a sample-intake status.');
  return {
    packageSha256: process.env.VERIFY_FORMAL_INTAKE_SHA256!,
    targetState: state.state as FormalIntakePlan['targetState'],
    mappings: 100,
    queuePositionsChecked: 200,
    guideProfile: plan.reviewer_profile.profile_id,
    reviewRemainsClosed: true,
  };
}
export async function stageFormalSample(ctx: Mu7Context, request: unknown) {
  investigator(ctx);
  const { packageSha256, attestation } = intakeRequestSchema.parse(request);
  // Read and validate again at submission: the confirmation must name these exact bytes.
  if (packageSha256 !== process.env.VERIFY_FORMAL_INTAKE_SHA256)
    throw new ServiceError(409, 'The prepared sample changed. Check the intake plan again.');
  const plan = await input();
  try {
    const result = await ctx.withData((d) =>
      d.rpc<{ state: string; mappings: number; queue_positions_checked: number }>(
        'rpc_mu81_stage_sample',
        { p: plan, p_attestation: attestation },
        'value',
      ),
    );
    if (
      !result ||
      !['RECORDED', 'ALREADY_RECORDED'].includes(result.state) ||
      result.mappings !== 100 ||
      result.queue_positions_checked !== 200
    )
      throw new Error();
    // Fixed shape only: never forward the RPC's arbitrary fields, packets or diagnostics.
    return {
      state: result.state,
      mappings: 100,
      queuePositionsChecked: 200,
      reviewRemainsClosed: true,
    };
  } catch {
    throw new ServiceError(
      409,
      'Sample intake was not confirmed. Check the connected package and empty destination, then retry the same plan. Existing records were not replaced.',
    );
  }
}
