import { unitDisplay } from './mu7-display';
import type { Mu7UnitBlock } from './mu7-types';

/** Answer-panel context only. Do not add this to stored packets or hashed preview/AI inputs. */
export function reviewTarget(unit: Mu7UnitBlock, profileId?: string | null) {
  const display = unitDisplay(unit, profileId);
  // The packet above retains the full MeSH explanation, including the Depression exception.
  const name = display.title.replace(/ \(MeSH .+\)$/, '');
  if (unit.family === 'AREA')
    return {
      title: `Therapeutic area — ${name.replace(/^Therapeutic area:\s*/, '')}`,
      meaning:
        'Agree means the trial studies a condition that fits this area. It does not also confirm a condition group.',
    };
  if (unit.family === 'ROW')
    return {
      title: `Condition group — ${display.title.replace(/^Condition group:\s*/, '')}`,
      meaning:
        'Agree means the trial studies this condition. It does not also confirm a therapeutic area.',
    };
  if (display.polarity) {
    const excluded = /(?:^|_)REMOVE(?:_|$)/.test(unit.assignment_code);
    const group = unit.parent_row_label?.replace(/\bMellitus\b/g, 'mellitus') ?? display.title;
    return {
      title: `${excluded ? 'Exclusion' : 'Inclusion'} check — ${group}`,
      meaning: display.polarity,
    };
  }
  // Older subgroup profiles may judge a narrower claim, such as malignancy. Their assertion
  // must not be reframed as generic membership in the condition group.
  return {
    title: display.title,
    meaning: `Agree confirms the displayed statement: “${display.assertion}”.`,
  };
}
