# Verify the locked judgment history

Bundle 8.2 adds `judgment_history.csv` to exports from v8.1 designs. It contains every submitted revision, including intermediate notes, subtype observations, time spent and the database's exact UTC timestamp at microsecond precision. This is an export contract change; it does not change answers, routing, the sample, the estimator or approval gates.

Migration 0036 adds a security-invoker history view. Its records are visible only to an authenticated investigator who meets the existing access conditions, after the reference for that mode is locked. Reviewers, adjudicators, observers, low-assurance investigator sessions and locked accounts cannot read it. Anonymous and administrative service roles receive no view grant. Formal and synthetic pilot histories remain separate; training examples have no judgment history.

## Independent verification

Both the TypeScript download checker and the Python analysis independently reproduce:

1. Each revision's existing database digest from its assignment, revision, answer, reason, exact note, uncertainty, time spent and separate subtype observation.
2. Complete contiguous revision coverage for every answered assignment, matching the exported first and effective answers and the subtype-history file.
3. For FORMAL mode, the existing database snapshot serialization, row count and SHA-256 across **every** revision, sorted by unit, reviewer slot and revision. Timestamp strings retain all six fractional digits. PILOT mode has no formal snapshot; its revision digests and coverage are checked without claiming a formal snapshot comparison.

The database's hash algorithms are unchanged. Free-text notes retain their bytes, including line breaks, carriage returns, pipes and strings that look like timestamps. Fixed-code fields are validated so delimiters cannot be shifted from a note into a reason code while preserving the old concatenated digest.

To bind verification to the registered export, obtain its manifest hash separately from the investigator's database record:

```sh
node --import tsx scripts/verify-mu7-bundle.ts --bundle /absolute/private/export --expect-manifest-sha256 <registered-hash>
```

The Python analysis accepts the same optional `--expect-manifest-sha256` argument. Its run log records whether that independent anchor was supplied and whether the full judgment snapshot was verified. It remains **synthetic-only**; this work does not authorize analysis of actual responses or settle the estimator.

Without an independently obtained manifest hash, internal checks cannot authenticate a wholly replaced export, manifest and snapshot. Even anchored verification does not establish clinical correctness or verify packet text that is absent from the bundle.

## Compatibility and deployment

- Existing 7.0 and 8.1 downloads remain readable with their original checks. They do not contain full history, so their complete snapshot cannot be reconstructed offline.
- New application exports of v8.1 designs use 8.2 after migration 0036. Legacy designs continue using 7.0. The library can still build 8.1 when explicitly supplied the legacy sources without full history.
- Migration 0036 leaves stored judgments, locks, snapshots, gates and previously registered exports unchanged. Existing 8.1 registrations remain accepted.
- Apply the reviewed additive migration before deploying a build that reads the new view. This branch has not been applied to Supabase or deployed.

Validation uses disposable databases and fictional cases only. PostgreSQL integration runs the same full-history reconstruction against native timestamp precision in CI; live Supabase behavior still requires an authorized staging check.
