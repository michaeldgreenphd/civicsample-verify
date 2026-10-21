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

No formal sample import, clinician invitations, production freeze or deployment is authorized by running the pilot. Module B requires its own approval process.
