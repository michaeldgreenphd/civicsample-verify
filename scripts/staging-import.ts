import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  ImportValidationError,
  readVerifiedPrivateCsv,
  validateDevelopment,
  validateHeldout,
  validatePredictions,
  validateModuleB,
} from '../src/lib/staging-import';

// Read-only preflight, deliberately without a DB client, token, activation, freeze or import action.
// Use: node --import tsx scripts/staging-import.ts --environment staging --kind development
//      --file /private/path.csv --sha256 <investigator-supplied-digest> --expected-rows <approved-count>
const names = [
  'environment',
  'kind',
  'file',
  'sha256',
  'expected-rows',
  'weight-column',
  'development-file',
  'development-sha256',
  'development-rows',
  'sample-file',
  'sample-sha256',
  'sample-rows',
  'sample-weight-column',
  'tier1-version',
  'condition-rows',
  'trial-rows',
];
async function main() {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])),
      strict: true,
      allowPositionals: false,
    });
    const get = (key: string): string => {
      const value = values[key];
      if (!value || typeof value !== 'string')
        throw new ImportValidationError('REQUIRED_ARGUMENT_MISSING');
      return value;
    };
    const number = (key: string) => {
      const value = get(key);
      if (!/^\d+$/.test(value)) throw new ImportValidationError('COUNT_ARGUMENT_INVALID');
      return Number(value);
    };
    if (get('environment') !== 'staging') throw new ImportValidationError('STAGING_ONLY');
    const repositoryRoot = resolve(__dirname, '..');
    const read = (fileKey: string, hashKey: string) =>
      readVerifiedPrivateCsv({ file: get(fileKey), expectedSha256: get(hashKey), repositoryRoot });
    const file = await read('file', 'sha256');
    const kind = get('kind');
    const expectedRows = number('expected-rows');
    if (kind === 'development') validateDevelopment(file, expectedRows);
    else if (kind === 'heldout' || kind === 'predictions') {
      const development = validateDevelopment(
        await read('development-file', 'development-sha256'),
        number('development-rows'),
      );
      if (kind === 'heldout')
        validateHeldout(file, { expectedRows, weightColumn: get('weight-column'), development });
      else {
        const sample = validateHeldout(await read('sample-file', 'sample-sha256'), {
          expectedRows: number('sample-rows'),
          weightColumn: get('sample-weight-column'),
          development,
        });
        const tier1Version = get('tier1-version');
        if (tier1Version !== 'v1.1' && tier1Version !== 'v1.2')
          throw new ImportValidationError('TIER_VERSION_REQUIRED');
        validatePredictions(file, {
          expectedRows,
          sample,
          tier1Version,
          sampleWeightColumn: get('sample-weight-column'),
        });
      }
    } else if (kind === 'module-b')
      validateModuleB(file, {
        expectedRows,
        expectedConditionRows: number('condition-rows'),
        expectedTrialRows: number('trial-rows'),
        weightColumn: get('weight-column'),
      });
    else throw new ImportValidationError('IMPORT_KIND_INVALID');
    console.log(
      JSON.stringify({
        status: 'PASS',
        mode: 'READ_ONLY_PREFLIGHT',
        environment: 'STAGING',
        kind,
        recordsValidated: file.rows.length,
        hashesVerified: true,
        databaseDryRun: 'NOT_RUN',
        databaseWrites: 0,
        approvalsChanged: false,
      }),
    );
  } catch (error) {
    const code = error instanceof ImportValidationError ? error.code : 'PREFLIGHT_FAILED';
    console.error(
      JSON.stringify({
        status: 'FAIL',
        mode: 'READ_ONLY_PREFLIGHT',
        code,
        databaseWrites: 0,
        approvalsChanged: false,
      }),
    );
    process.exitCode = 1;
  }
}
void main();
