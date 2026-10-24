# Reviewer rubric, review design v7: versions

| Version                               | File                                                          | SHA-256                                                            | Source                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| v7 as supplied (2026-10-22)           | `REVIEW_RUBRIC_v7_supplied.md` (kept verbatim)                | `615af589ee5918553fe89e4421569c6328b50c4ae2cd4e6d9ae5ef1b66586cfd` | handoff v7 package, `design_v7/REVIEW_RUBRIC_v7.md` in the package manifest                                 |
| v7 revision 1 (2026-10-23), withdrawn | none (git history of `REVIEW_RUBRIC_v7.md`, commit `85c8e27`) | `38b42ee0eca3c2dea95b60d00aaa58bf5ad75f4025f18ded774192401395760c` | engineering message v8.1, item 1; withdrawn by v8.2 pending the investigator; never approved or used        |
| 7.1 (2026-10-23), current             | `REVIEW_RUBRIC_v7.md`                                         | `9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46` | engineering message v8.3, item 1, implementing investigator decisions addendum 11, item 60 (gate G-PAIN-01) |

Version 7.1 changes section 3 of the supplied text and nothing else. The Pain row loses its qualifier, and one paragraph
follows the list of rows:

```
- - Pain (descriptive row; provisional until gate G-PAIN-01)
+ - Pain

+ Pain: the row holds trials with the MeSH heading Pain. Agree when the trial studies pain of any kind (for example acute, postoperative, procedural or chronic pain), in any population; judge whether pain is the condition studied, not how long it lasts.
+
  ## 4. Reason codes
```

Version 7.1 was made from the supplied text, whose SHA-256 is the one engineering message v8.3 names as the starting
point. Revision 1 had changed the same Pain line to `- Pain (descriptive row)`; 7.1 replaces it before any use. Its hash
stays in this table so that a copy of it can still be recognized.

No rubric version is frozen: the formal review has not been frozen or opened, and no database record holds a rubric hash
for design v7. This file is the approved source copy; delivery to reviewers is not established by this patch.
The application does not render it. In-app delivery of versioned reviewer guidance remains a formal-readiness blocker:
the source-file checksum tests do not verify what a reviewer sees. The decision record of
gate G-PAIN-01, version 3 (migration 0032), names rubric 7.1 by its SHA-256, so an approval of that gate cites this version.

Still pending and not in this repository: the Depression (OQ-03) and smoking cessation (OQ-04) policy texts, which would
make a rubric version 7.2 once the investigator approves them. Until then section 2 keeps its pending marker, and gates
G-OQ-03 and G-OQ-04 stay pending specification and hold the freeze (migration 0032).

`tests/rubric-provenance-v7.test.ts` pins these hashes and the exact difference from the supplied text; any further change
must update this table and that test together.

The decision records themselves (investigator decisions of 2026-10-23, addenda 8 and 11) stay in the private project
folder and are cited here by name only.
