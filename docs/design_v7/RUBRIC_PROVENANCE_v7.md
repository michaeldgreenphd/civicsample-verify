# Reviewer rubric, review design v7: versions

| Version                     | File                                           | SHA-256                                                            | Source                                                                                               |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| v7 as supplied (2026-10-22) | `REVIEW_RUBRIC_v7_supplied.md` (kept verbatim) | `615af589ee5918553fe89e4421569c6328b50c4ae2cd4e6d9ae5ef1b66586cfd` | handoff v7 package, `design_v7/REVIEW_RUBRIC_v7.md` in the package manifest                     |
| v7 revision 1 (2026-10-23)  | `REVIEW_RUBRIC_v7.md`                          | `38b42ee0eca3c2dea95b60d00aaa58bf5ad75f4025f18ded774192401395760c` | engineering message v8.1, item 1, implementing investigator decision addendum 8, item 40 (G-PAIN-01) |

Revision 1 changes one line in section 3 and nothing else:

```
- Pain (descriptive row; provisional until gate G-PAIN-01)
+ Pain (descriptive row)
```

No rubric version was frozen: the formal review has not been frozen or opened, and no database record holds a rubric hash for design v7. The supplied text stays in the repository so either version can be checked against its hash. `tests/rubric-provenance-v7.test.ts` pins both hashes and the single-line difference; any further change must update this table and that test together.

The decision record itself (investigator decisions of 2026-10-23, addendum 8) stays in the private project folder and is cited here by name only.
