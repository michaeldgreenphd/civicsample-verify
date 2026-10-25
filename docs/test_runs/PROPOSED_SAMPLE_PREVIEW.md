# Proposed sample preview — engineering verification

The new investigator-only view reads a separately checked private preparation file and presents all 100 mappings using the existing physician packet component. It cannot record a judgment or alter a campaign. The prepared file also supplies an independently reviewed AI runner, submitted separately so its workflow can target the default branch without waiting for the app stack.

Executed in the combined engineering checkout before extracting the standalone AI files:

| Command/check                                                                       | Observed result                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VERIFY_ANALYSIS_PYTHON=/private/tmp/verify-analysis-venv/bin/python npm run check` | PASS: 426 tests, 388 passed, zero failed, 37 skipped, one pre-existing TODO; fixture and v4/v5/v7 leakage scans zero violations                        |
| `npm run build`                                                                     | PASS: seven deployment manifests, 40 SQL inputs, no runtime/private files                                                                              |
| `npm run test:e2e:production`                                                       | PASS: 16 scenarios, including the new 100-item preview, desktop/mobile layout, accessibility, guide navigation and closing during an in-flight request |
| `node --import tsx --test tests/sample-preview.test.ts`                             | PASS: three integrity/access tests                                                                                                                     |
| Independent code review                                                             | Two concrete findings fixed: cancel pending loads on close/unmount; omit unrendered intervention descriptions from AI requests                         |

The combined count includes the standalone AI test wrapper, whose 20 provider/store tests are entirely mocked. Those files are in the separate AI workflow PR. Native PostgreSQL and live staging cases skipped by the existing suite were not executed locally. Hosted Supabase access, a private runtime file on Render, remote AI-store persistence and actual model calls remain untested in this change.

The first build correctly rejected Git metadata detected by file tracing after the outside-Git check was added. `.git` is now explicitly excluded from the deployment package; the strict deployment allowlist remains unchanged, and the subsequent build passed.

All committed examples and browser evidence are synthetic. Real proposal identifiers, registry text, manifests, private fingerprints and credentials are excluded from this report. Existing practice records, gate approvals and clinician access were not changed.
