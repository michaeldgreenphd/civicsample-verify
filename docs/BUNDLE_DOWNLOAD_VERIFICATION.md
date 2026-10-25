# Verify a downloaded review bundle

The offline checker accepts application-written bundle formats 7.0 and 8.1, including synthetic PILOT exports. It reads local files only and cannot approve gates, alter the database or run analysis.

Keep downloaded bundles outside the public repository. Run:

```sh
node --import tsx scripts/verify-mu7-bundle.ts --bundle /absolute/private/export --expect-manifest-sha256 <registered-manifest-hash>
```

Obtain the expected manifest hash separately from the investigator's registered export record. Do not substitute the hash supplied inside the downloaded folder. `registrationVerified: true` means that the supplied expected hash matches and all file checks passed; it does not mean the tool contacted the database or independently authenticated whoever supplied that hash. Without the option, the tool checks internal consistency and reports `registrationVerified: false` even for an otherwise valid bundle.

The checker verifies:

- Exact versioned file inventory, each SHA-256, CSV columns, row widths and row counts. The new subtype file is required for 8.1; old 7.0 files retain their contract.
- For formal 8.1 ONE_PER_TRIAL exports, complete probability coverage, canonical decimal rows, the unchanged source-file digest, exact source/canonical probability equality, and metadata/binding agreement with the frozen digest.
- PILOT and ALLOW exports carry no probability binding. Old designs cannot be relabeled as bundle 8.1, and new designs cannot use bundle 7.0.
- Malformed JSON/CSV/UTF-8 and symlink inputs are refused. It reads only fixed contract filenames, never arbitrary paths named by a manifest. Errors contain fixed filenames and categories, not data rows or local paths.

Exit status is 0 for successful verification, 1 for an invalid bundle, and 2 for invalid command arguments. A requested registered-hash check without its value fails; it is never silently skipped. The output is one JSON result. Existing standard status text remains in the output; arbitrary status text from untrusted files is not echoed.

This checks download integrity and probability provenance. It does not validate clinical judgments, choose an estimator, verify packet text absent from the bundle, or reproduce the full judgment snapshot. The analysis validator performs separate semantic checks and remains synthetic-only. A successful download check is not permission to start formal review.

## Verification scope

Regression tests include application-written v7 pilot and v8.1 pilot/formal exports for both overlap alternatives; actual 100-unit/200-judgment SQL lifecycle fixtures; exact high-precision decimals; malformed/truncated input; missing/extra files; changed source probabilities; changed frozen metadata; symlinks; and independently supplied registered hashes. All inputs are fictional. No Supabase request, deployment or operational-record mutation is needed.
