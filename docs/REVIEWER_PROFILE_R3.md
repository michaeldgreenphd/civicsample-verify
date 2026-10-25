# Revised reviewer guide and private sample preparation

The reviewer guide describes all ten therapeutic areas using their displayed MeSH parent headings. It removes the additional narrowed definitions previously proposed for the three added areas. Reviewers still judge clinical fit and can disagree; the separate cancer, Depression and smoking-cessation policies remain. Fictional answer keys dependent on the withdrawn definitions are not included. The three existing worked examples remain separate from the review queue.

## Version and compatibility

The opt-in `mu81-plain-language-r3` profile binds the exact bytes of `docs/reviewer/REVIEWER_GUIDE_v81_r3.md`. Migration 0037 permits an active investigator with MFA to bind it only after recording a v8.1 design and before importing any units or training, assigning queues, or recording review activity. It uses the same lifecycle lock as imports and phase transitions. The binding cannot be edited or deleted. Existing databases without this binding retain their earlier clinical wording and reason meanings.

The guide uses a uniform MeSH-parent scope for all ten areas. It does not change the classifications, selected trials, allocation, nominal inclusion probabilities or historical exclusions. The source files and prior proposal versions remain intact.

Two neoplasm subgroup packet statements change under the new profile. An inclusion assertion no longer asserts verified malignancy. The exclusion assertion explicitly describes the study's cyst, hamartoma and precancerous-condition list. A benign-neoplasm disagreement is unavailable for inclusion under the revised target; nonmalignant neoplasm studied is available for exclusion. Historical rows keep their earlier meaning. Cannot-tell submissions require an explanation under the new profile.

The profile creates no gate approval. Sample freeze, formal opening and estimator approval remain separate. Formal operations remain unavailable through the web application in this increment.

## Application

Reviewers and adjudicators receive only the safe profile identifier, guide checksum, design identifier, binding checksum and guide text. The source attestation and investigator identity are not returned. The guide has its own tab alongside Practice cases and Worked examples; switching tabs preserves unfinished answers. Readable labels replace internal codes in the interface. Historical subgroup questions continue to ask about the original displayed assertion.

A new, empty local synthetic database can use **Start practice with the revised guide**. This option does not appear for the existing hosted practice database. It records a synthetic design and binds the guide in one local transaction. Its imports adjust only the synthetic neoplasm packet wording. This does not upgrade or rewrite an existing campaign.

## Export contract

Profile-bound exports use bundle 8.3. They include `reviewer_guide.md`, its exact checksum, safe profile metadata, the complete judgment history, subtype observations and the existing probability artifacts when applicable. Formal freezes bind the profile digest. Registration and the independent download/analysis checks refuse a missing or mismatched guide, incompatible bundle versions and profile-specific reasons on the wrong assignment. Unbound 7.0, 8.1 and 8.2 bundles keep their earlier contracts.

The analysis remains a synthetic engineering harness. Its real-study refusal is unchanged; this increment does not approve an estimator or validate clinical performance.

## Private preparation

The preparation tool reads a checksummed private package outside every repository and creates a new owner-only directory. It refuses to overwrite an existing directory. It does not redraw, choose a scientific alternative, import to a service, approve a gate or freeze a sample.

```sh
node --import tsx scripts/prepare-reviewer-profile.ts \
  /absolute/private/source /absolute/private/new-output ONE_PER_TRIAL
npm run mu81:offline-import-check -- \
  --private-dir /absolute/private/new-output --alternative ONE_PER_TRIAL
```

The first command rewrites only the two intended packet statements and their dependent inventories, import checksum and candidate manifest. The second runs the actual migration chain and import/probability-binding functions in a disposable in-memory database. Its public output contains only aggregate results. It requires 100 units and 200 queue positions, verifies the original unit-list, assignment-set, design-row and queue hashes, and checks that no gate approval, queue assignment, judgment, freeze, reference lock or export was created.

Live PostgreSQL/Supabase checks and an approved deployment plan remain required before applying this migration to an operational project. No staging or production data is modified by the preparation tools.
