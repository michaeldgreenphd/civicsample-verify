import { readFileSync } from 'node:fs';
import {
  previewUnit,
  AI_MAPPING_INPUT_FORMAT,
  type SamplePreviewBundle,
} from '../src/lib/sample-preview';
import {
  MU81_REVIEWER_GUIDE_SHA256,
  MU81_REVIEWER_PROFILE_ID,
} from '../src/lib/mu81-reviewer-profile';

export function syntheticSamplePreview(): SamplePreviewBundle {
  return {
    format: AI_MAPPING_INPUT_FORMAT,
    guide: {
      text: readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r4.md', 'utf8'),
      sha256: MU81_REVIEWER_GUIDE_SHA256,
      profile_id: MU81_REVIEWER_PROFILE_ID,
    },
    source: {
      app_commit: 'a'.repeat(40),
      sample_sha256: 'b'.repeat(64),
      prepared_import_sha256: 'c'.repeat(64),
    },
    units: Array.from({ length: 100 }, (_, i) =>
      previewUnit(
        {
          unit: {
            unit_id: `SYN-PREVIEW-${i + 1}`,
            mode: 'FORMAL',
            family: i < 56 ? 'AREA' : i < 96 ? 'ROW' : 'SG',
            category: 'SYNTHETIC',
            unit_role: i < 96 ? 'PRIMARY' : 'SUBGROUP',
            mapping_code: 'SYNTHETIC',
            mapping_label: `Fictional mapping ${i + 1}`,
            assignment_code: i < 96 ? 'IN_AREA' : 'D4A_KEEP_UNRESOLVED_PARENT_ONLY',
            assignment_status: 'ASSIGNED',
            display_text: 'Fictional classification for an engineering test',
          },
          trial: {
            nct_id: `SYN-NCT-PREVIEW-${i + 1}`,
            brief_title: `Fictional trial ${i + 1}`,
            brief_summary: 'Synthetic evidence only; not a study record.',
          },
          notices: ['Synthetic test fixture'],
        },
        MU81_REVIEWER_PROFILE_ID,
      ),
    ),
  };
}
