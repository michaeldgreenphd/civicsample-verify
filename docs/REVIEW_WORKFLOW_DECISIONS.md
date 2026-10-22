# Review workflow decisions — 2026-10-22

The investigator clarified the intended evaluation during the independent code audit:

- Three worked examples precede independent review. They are training/calibration records and never enter the evaluation sample or its statistics.
- The evaluation unit is an individual trial-to-condition mapping. The target is 100 such mappings across the ten conditions used in the PPR figures, not 100 trials each receiving the proposed v5 19-item questionnaire.
- Therapeutic-area mapping is a desired secondary assessment. Its unit, allocation and relation to the 100 mapping records still need specification.
- The desired evidence is the trial title and available brief summary from the registry/AACT source. Missing summaries must remain explicitly missing; no generated evidence may substitute.
- The investigator explicitly chose to show the existing assignment. This supersedes the earlier classifier-blinding instruction for the new mapping-confirmation workflow only. Reviewers assess that assignment using the evidence, with a short yes/no response and an annotation on disagreement. An insufficient-information option remains a proposed rubric detail.
- Reviewer-to-reviewer blinding, individual roles, finality, independent adjudication and private data controls remain required. Showing the existing assignment does not authorize showing another reviewer's response or unrelated classifier reasoning.
- This is a mapping-confirmation review, not an independent blinded clinical reference assessment. Its future schema/export must explicitly identify the review mode and assignment visibility, and its results must not be mixed with blinded-reference outputs. Existing v4/v5 analysis is not approved for this revised design.

The proposed v5 module does not implement this requested sampling unit. It remains synthetic-only engineering scaffolding with formal activation blocked. None of the clarified intent approves the old 100-trial sample, the supplied v5 rubric, development-linked inclusion, production import, or invitations. Do not translate 100 mappings into 100 trials or silently reuse the supplied freeze manifest.

Before a clinical release, record the exact ten-condition list against the intended figure/data revision (including resolution of the earlier Pain exclusion), define the sampling frame and negative/control coverage, and freeze the mapping-unit schema, rubric and analysis plan. Reviewing only currently positive mappings can assess the correctness of those mappings but cannot by itself establish sensitivity or specificity for all trials. Pilot usability can be tested separately with fully synthetic mappings.
