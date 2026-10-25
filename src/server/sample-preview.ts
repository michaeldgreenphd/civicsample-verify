import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseSamplePreview, type SamplePreviewIndex } from '../lib/sample-preview';
import { HttpError } from '../lib/auth';
import type { Actor } from '../lib/types';

export function requirePreviewInvestigator(actor: Actor & { practiceReadOnly?: boolean }) {
  if (actor.role !== 'INVESTIGATOR' || actor.practiceReadOnly)
    throw new HttpError(403, 'The proposed sample preview requires an investigator account.');
}
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Separate, read-only preparation file. Never connects to or imports into a review database. */
export async function readSamplePreviewFile(
  file: string | undefined,
  expected: string | undefined,
) {
  if (!file || !expected)
    throw new HttpError(
      503,
      'The proposed sample preview has not been connected to this server yet.',
    );
  try {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error();
    const path = await realpath(file);
    if (resolve(file) !== path) throw new Error();
    for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
      let inRepo = false;
      try {
        await access(join(ancestor, '.git'));
        inRepo = true;
      } catch {
        /* absent */
      }
      if (inRepo) throw new Error();
      if (ancestor === dirname(ancestor)) break;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 12_000_000 || (info.mode & 0o077) !== 0) throw new Error();
      const bytes = await handle.readFile();
      if (sha(bytes) !== expected) throw new Error();
      const bundle = parseSamplePreview(JSON.parse(bytes.toString('utf8')));
      if (sha(bundle.guide.text) !== bundle.guide.sha256) throw new Error();
      return bundle;
    } finally {
      await handle.close();
    }
  } catch {
    // Paths, packets, digests and parser errors are private. No underlying exception is logged.
    throw new HttpError(
      503,
      'The proposed sample preview failed its integrity check. Ask the investigator to reconnect the verified package.',
    );
  }
}

export async function getSamplePreview(
  actor: Actor & { practiceReadOnly?: boolean },
  position?: number,
) {
  requirePreviewInvestigator(actor); // before file inspection for every role
  if (position !== undefined && (!Number.isInteger(position) || position < 1 || position > 100))
    throw new HttpError(404, 'Preview page not found.');
  const bundle = await readSamplePreviewFile(
    process.env.VERIFY_PREPARATION_PREVIEW_FILE,
    process.env.VERIFY_PREPARATION_PREVIEW_SHA256,
  );
  if (position !== undefined) return bundle.units[position - 1];
  const index: SamplePreviewIndex = {
    status: 'PROPOSED_PREVIEW',
    guide: bundle.guide,
    units: bundle.units.map((u, i) => ({
      position: i + 1,
      title: u.display.title,
      family: u.packet.unit.family,
      trialTitle: u.packet.trial.brief_title,
    })),
  };
  return index;
}
