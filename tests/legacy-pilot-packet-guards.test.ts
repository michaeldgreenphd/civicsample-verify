import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { syntheticCaseAuthorSchema } from '../src/server/admin-workflows';
import { guardActor, seedGuardDatabase, type GuardRole } from './tlv5-guard-fixture';

import { exerciseLegacyPilot } from './legacy-pilot-fixture';

type MutablePacket = {
  id: string;
  kind: string;
  packet: Record<string, unknown>;
  trialPacket: Record<string, unknown>;
};

const migration = 'migrations/0014_legacy_pilot_and_packet_guards.sql';
const j = JSON.stringify;
async function fresh() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  await seedGuardDatabase(db);
  await db.exec(await readFile(migration, 'utf8'));
  return db;
}
async function rpc(db: PGlite, role: GuardRole, sql: string, params: unknown[] = []) {
  return guardActor(db, role, () => db.query(sql, params));
}
const packet = () => ({
  id: 'SYN-800',
  kind: 'TWO_STEP',
  packet: {
    title: 'Synthetic title',
    area: 'Synthetic area',
    descriptorName: 'Synthetic descriptor',
    descriptorId: 'SYN-D800',
    scopeNote: 'Synthetic scope',
    entryTerms: ['Synthetic entry'],
    treeNumbers: [{ number: 'SYN.001', label: 'Synthetic tree' }],
    areaDefinition: 'Synthetic definition',
    source: 'Synthetic source',
    sourceVersion: 'SYN-1',
  },
  trialPacket: {
    registryId: 'SYN-NCT-0800',
    title: 'Synthetic trial',
    summary: 'Synthetic summary',
    conditions: ['Synthetic condition'],
    interventions: ['Synthetic intervention'],
    primaryOutcomes: ['Synthetic outcome'],
    studyType: 'Synthetic type',
    primaryPurpose: 'Synthetic purpose',
    phase: 'Synthetic phase',
    ageRange: 'Synthetic age',
    source: 'Synthetic source',
    sourceVersion: 'SYN-1',
  },
});

test('0014 enforces field-specific canonical limits and array caps through direct RPC', async () => {
  const db = await fresh();
  try {
    const scalarLimits = {
      packet: {
        title: 300,
        area: 100,
        descriptorName: 300,
        scopeNote: 2000,
        areaDefinition: 2000,
        source: 200,
        sourceVersion: 100,
      },
      trialPacket: {
        title: 300,
        summary: 4000,
        studyType: 200,
        primaryPurpose: 200,
        phase: 200,
        ageRange: 200,
        source: 200,
        sourceVersion: 100,
      },
    };
    for (const [section, limits] of Object.entries(scalarLimits)) {
      for (const [field, max] of Object.entries(limits)) {
        const value = packet() as MutablePacket;
        value[section as 'packet' | 'trialPacket'][field] = 'x'.repeat(max + 1);
        assert.equal(
          syntheticCaseAuthorSchema.safeParse(value).success,
          false,
          `${section}.${field}`,
        );
        await assert.rejects(
          rpc(db, 'investigator', 'select public.rpc_verify_author_case($1::jsonb)', [j(value)]),
          /canonical/,
        );
      }
    }
    for (const [section, field, max] of [
      ['packet', 'entryTerms', 200],
      ['trialPacket', 'conditions', 200],
      ['trialPacket', 'interventions', 200],
      ['trialPacket', 'primaryOutcomes', 300],
    ] as const) {
      for (const array of [['x'.repeat(max + 1)], Array(21).fill('Synthetic')]) {
        const value = packet() as MutablePacket;
        value[section as 'packet' | 'trialPacket'][field] = array;
        assert.equal(syntheticCaseAuthorSchema.safeParse(value).success, false);
        await assert.rejects(
          rpc(db, 'investigator', 'select public.rpc_verify_author_case($1::jsonb)', [j(value)]),
          /canonical/,
        );
      }
    }
    for (const treeNumbers of [
      Array(21).fill({ number: 'SYN.001', label: 'Synthetic' }),
      [{ number: 'SYN.001', label: 'x'.repeat(201) }],
      [{ number: 'incorrect', label: 'Synthetic' }],
    ]) {
      const value = packet();
      value.packet.treeNumbers = treeNumbers;
      assert.equal(syntheticCaseAuthorSchema.safeParse(value).success, false);
      await assert.rejects(
        rpc(db, 'investigator', 'select public.rpc_verify_author_case($1::jsonb)', [j(value)]),
        /canonical/,
      );
    }
    const boundary = packet() as MutablePacket;
    for (const [section, limits] of Object.entries(scalarLimits))
      for (const [field, max] of Object.entries(limits))
        boundary[section as 'packet' | 'trialPacket'][field] = 'x'.repeat(max);
    boundary.packet.entryTerms = Array(20).fill('x'.repeat(200));
    boundary.packet.treeNumbers = Array(20).fill({ number: 'SYN.001', label: 'x'.repeat(200) });
    boundary.trialPacket.conditions = Array(20).fill('x'.repeat(200));
    boundary.trialPacket.interventions = Array(20).fill('x'.repeat(200));
    boundary.trialPacket.primaryOutcomes = Array(20).fill('x'.repeat(300));
    assert.equal(syntheticCaseAuthorSchema.safeParse(boundary).success, true);
    await rpc(db, 'investigator', 'select public.rpc_verify_author_case($1::jsonb)', [j(boundary)]);
    assert.equal((await db.query('select id from public.verify_cases')).rows.length, 1);
  } finally {
    await db.close();
  }
});

test('fresh 0010 through0014 permits independent legacy pilot completion without investigator judgments', async () => {
  const db = await fresh();
  try {
    await exerciseLegacyPilot(db);
  } finally {
    await db.close();
  }
});
