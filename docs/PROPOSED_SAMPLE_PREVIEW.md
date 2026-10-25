# Preview the proposed 100 mappings

The investigator can inspect the complete prepared sample before opening formal review. This is a read-only view of the proposed packets, not a review campaign: it creates no assignments, judgments, approvals, freezes or exports in the study database. The existing practice campaign is untouched.

The preview uses the same packet renderer, displayed questions, disagreement meanings and exact versioned guide as the physician interface. Navigation covers 56 therapeutic-area mappings, 40 condition mappings and 4 inclusion/exclusion checks. The separate diabetes subtype question is shown only where required. A private export of the same checked material supplies the separate AI comparison; AI outputs never return through the preview or physician APIs.

## Preparing the private file

From a clean, committed checkout, use the already verified ONE_PER_TRIAL preparation package. Source and output must be absolute paths outside every Git repository; output must be a new folder. Do not copy private paths or hashes into a public PR.

```sh
node --import tsx scripts/prepare-sample-preview.ts \
  --private-dir "$PRIVATE_PREPARATION_DIR" \
  --output "$NEW_PRIVATE_PREVIEW_DIR"
```

This first runs the existing full import/probability validation in a disposable in-memory database. It then writes owner-only `mapping-input.json`, its checksum and `preview.env`. The input contains actual registry evidence, so all three files stay private. The input bytes and rubric checksum are fixed for both preview and AI use. This does not select or freeze a sample.

## Viewing

Supply `VERIFY_PREPARATION_PREVIEW_FILE` and `VERIFY_PREPARATION_PREVIEW_SHA256` from that private environment file to the server at runtime, never at build time or through a `NEXT_PUBLIC_` variable. Sign in as an investigator, open **Mapping units**, and choose **Preview all 100 mappings**. Use the selector or Previous/Next. The reviewer guide remains available alongside the preview. There is no Save or Submit action.

Every preview request checks the role before touching the file. Supabase investigators must complete MFA; practice observers, reviewers, adjudicators and anonymous users are refused. Errors suppress paths and packet content. Responses are private and not cached. The file must be owner-only, outside Git, non-symlinked and match the pinned checksum; modified guide text is refused independently. Nothing is packaged into the browser build or public deployment artifacts.

The file-backed path can be used in a local investigator preview immediately. Hosting it requires an explicitly prepared private runtime file and deployment configuration; applying SQL migrations alone does not connect it. Hosted role verification and a real study import remain separate work. There is no claim that formal review or a paid AI run is enabled by this preview.
