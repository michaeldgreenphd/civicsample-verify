// Checks a downloaded bundle 7.0 folder (manifest.json and the four CSV files) on its own:
//
//   node --import tsx scripts/verify-mu7-bundle.ts --bundle /abs/folder [--expect-manifest-sha256 <hash>]
//
// Every file's SHA-256 must equal the manifest, every CSV must carry exactly the contract's columns
// in order and the manifest's row count, and no column may carry walkthrough or model content. With
// --expect-manifest-sha256 (the hash the database registered, from the investigator console or the
// read-only inspection) the manifest itself must match it. Prints one JSON line; exit 1 on failure.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MU7_EXPORT_COLUMNS,
  MU7_FORBIDDEN_COLUMNS,
  type Mu7ExportRole,
} from '../src/lib/mu7-export';

/** CSV records (quoted fields may hold line breaks), header first. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += c;
  }
  if (field || record.length) records.push([...record, field]);
  return records;
}

export function verifyMu7Bundle(dir: string, expectManifestSha?: string) {
  const problems: string[] = [];
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, problems: ['manifest.json is missing'] };
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    bundle_format_version: string;
    mode: string;
    status: string;
    files: Record<string, string>;
    row_counts: Record<string, number>;
  };
  if (manifest.bundle_format_version !== '7.0') problems.push('bundle_format_version is not 7.0');
  if (expectManifestSha && sha(manifestBytes) !== expectManifestSha)
    problems.push('manifest.json differs from the registered manifest hash');
  if (manifest.mode === 'PILOT' && !/^SYNTHETIC PILOT/.test(manifest.status))
    problems.push('a PILOT bundle must be marked SYNTHETIC PILOT');
  const rows: Record<string, number> = {};
  for (const role of Object.keys(MU7_EXPORT_COLUMNS) as Mu7ExportRole[]) {
    const name = `${role}.csv`;
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const bytes = readFileSync(path);
    if (sha(bytes) !== manifest.files?.[name])
      problems.push(`${name}: SHA-256 differs from the manifest`);
    const records = csvRecords(bytes.toString('utf8'));
    const header = records[0] ?? [];
    if (header.join(',') !== MU7_EXPORT_COLUMNS[role].join(','))
      problems.push(`${name}: columns differ from the bundle 7.0 contract`);
    if (header.some((c) => MU7_FORBIDDEN_COLUMNS.test(c)))
      problems.push(`${name}: a forbidden column`);
    rows[name] = records.length - 1;
    if (rows[name] !== manifest.row_counts?.[name])
      problems.push(`${name}: row count differs from the manifest`);
  }
  return {
    ok: problems.length === 0,
    mode: manifest.mode,
    status: manifest.status,
    manifestSha256: sha(manifestBytes),
    rows,
    problems,
  };
}

if (process.argv[1]?.endsWith('verify-mu7-bundle.ts')) {
  const at = (n: string) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const dir = at('--bundle');
  if (!dir) {
    console.log(JSON.stringify({ ok: false, problems: ['pass --bundle /abs/folder'] }));
    process.exit(2);
  }
  const result = verifyMu7Bundle(dir, at('--expect-manifest-sha256'));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
