# Approval gates

Formal activation is blocked in this build. A proposal is not an approval; approval is not a cryptographic freeze. A future activation transaction must verify all gates together and record the investigator's attestation.

| Gate               | Required evidence                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Scientific version | Explicit choice and approval of the classification version                                  |
| Sample adequacy    | Approved sample/design, coverage limitation acknowledged, target inference stated           |
| Holdout provenance | Complete versioned exclusion ledger and no overlap or duplicates                            |
| Sample provenance  | Frame/ledger/sample identifiers, case list, stratum, inclusion probability, seed and source |
| Rubric             | Approved, frozen text and matching checksum                                                 |
| Inputs             | Immutable ontology/predictions/evidence/sample/rubric hashes verified                       |
| Independent roles  | Two authorized reviewers and separate qualified adjudicator                                 |
| Investigator pilot | Signed acceptance after a successful synthetic pilot                                        |
| Security           | Actual PostgreSQL, Supabase JWT/RLS/MFA, API and browser negative tests                     |
| Analysis           | Approved frozen plan and tested export/analysis compatibility                               |
| Operations         | Hosting region, retention, backup/restore, invited access and monitoring                    |

No formal sample import, clinician invitations, production freeze or deployment is authorized by running the pilot. Module B requires its own approval process. Design v5 adds its own database-enforced sequence (docs/design_v5/APP_MAPPING_v5_1.md, section 4): pilot lock, pilot export, pilot sign-off with the signed checklist's SHA-256, activation with the adjudication scope, formal enrolment, calibration and training, import and freeze, formal opening, close, snapshot, adjudication, lock, export. The investigator's decisions of docs/design_v5/REVIEW_RUBRIC_v5_1.md section 2 precede the freeze.
