/** Prepare the same allowlisted, checked packets for an investigator preview and separate AI run. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  checkAlternative,
  privateDirectory,
  readPrivatePackage,
  verifyProfilePreparation,
} from './mu81-disposable-import';
import { mu7PacketView } from '../src/lib/mu7-types';
import {
  AI_MAPPING_INPUT_FORMAT,
  parseSamplePreview,
  previewUnit,
} from '../src/lib/sample-preview';
import { MU81_REVIEWER_PROFILES } from '../src/lib/mu81-reviewer-profile';

export async function prepareSamplePreview(source: string, output: string) {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('Commit the reviewed exporter before preparing private inputs.');
  if (!isAbsolute(output)) throw new Error('Refused output.');
  privateDirectory(dirname(output));
  const files = readPrivatePackage(source);
  const alternative = 'ONE_PER_TRIAL';
  const profile = verifyProfilePreparation(files, alternative);
  if (!profile) throw new Error('A checked reviewer profile is required.');
  await checkAlternative(files, alternative); // real SQL guards in an isolated in-memory database
  const revision = MU81_REVIEWER_PROFILES[profile.profile_id];
  const bytes = files.get(
    `MU7_IMPORT_UNITS_v8_1_${alternative}_PROFILE_R${revision.revision}_PROPOSED_PRIVATE.json`,
  )!;
  const input = JSON.parse(bytes.toString('utf8'));
  const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
  const bundle = parseSamplePreview({
    format: AI_MAPPING_INPUT_FORMAT,
    guide: {
      text: files.get(revision.file)!.toString('utf8'),
      sha256: profile.rubric_sha256,
      profile_id: profile.profile_id,
    },
    source: {
      app_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sample_sha256: input.manifest_hashes.unit_list_sha256,
      prepared_import_sha256: hash(bytes),
    },
    units: input.units.map((u: { packet: Record<string, unknown> }) =>
      previewUnit(mu7PacketView(u.packet), profile.profile_id),
    ),
  });
  // A new folder only; never overwrite another candidate, private source or previous run.
  mkdirSync(output, { mode: 0o700 });
  const content = JSON.stringify(bundle, null, 2) + '\n';
  writeFileSync(join(output, 'mapping-input.json'), content, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${hash(content)}  mapping-input.json\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    join(output, 'preview.env'),
    `VERIFY_PREPARATION_PREVIEW_FILE=${join(output, 'mapping-input.json')}\nVERIFY_PREPARATION_PREVIEW_SHA256=${hash(content)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return {
    status: 'PASS',
    mappings: 100,
    areas: 56,
    conditions: 40,
    subgroupChecks: 4,
    database: 'disposable',
    remoteRequests: 0,
    studyWrites: 0,
    paidCalls: 0,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/prepare-sample-preview.ts')) {
  const args = process.argv.slice(2);
  Promise.resolve()
    .then(() => {
      if (args.length !== 4 || args[0] !== '--private-dir' || args[2] !== '--output')
        throw new Error();
      return prepareSamplePreview(args[1], args[3]);
    })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Sample preview preparation refused. Private diagnostic details suppressed; no remote request or paid call was made.',
      );
      process.exitCode = 1;
    });
}
