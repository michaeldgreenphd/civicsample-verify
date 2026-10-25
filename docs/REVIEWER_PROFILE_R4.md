# Reviewer guide revision 4

The investigator requested the section heading “Different things you are judging” in place of “Understand the question on the screen”. [Guide revision 4](reviewer/REVIEWER_GUIDE_v81_r4.md) changes only that heading and the revision label; all clinical instructions, definitions and policies are identical to revision 3. This wording acceptance is not a scientific gate, sample, estimator or freeze approval.

The original revision 3 file and migration 0037 stay byte-identical. Additive migration 0038 accepts either exact profile/checksum pair before review setup and keeps the existing immutable binding and lifecycle restrictions. It never updates a bound guide, packet, response, queue, gate or approval. The server, export writer and both offline verifiers choose the exact guide belonging to the recorded profile. New local preparation defaults to revision 4.

An existing practice design cannot acquire this profile after units, training or assignments exist. In particular, applying migrations to the existing hosted v7 practice database does not convert that campaign or display this new guide there. A fresh hosted v8.1 setup needs its own reviewed path.

| Revision | Profile                  | SHA-256                                                            |
| -------- | ------------------------ | ------------------------------------------------------------------ |
| 3        | `mu81-plain-language-r3` | `1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284` |
| 4        | `mu81-plain-language-r4` | `1eee3cdcae8f9c097a119255cbd410524f2d2ad08a24df3f02de38a1c096c88a` |

Regression coverage verifies the two-line guide diff, exact preservation of an answered and locked revision 3 pilot and its export across migration 0038, refusal of mixed profile/checksum pairs and unauthorized binding, and both guide revisions in Python. The browser checks the new heading and preserves unsaved answers while switching to the guide, at desktop and mobile sizes.

See the accompanying test-run record for executed commands and limitations. No remote migration, deployment, import, account change or scientific approval is part of this change.
