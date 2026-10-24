import { MU7_ANSWERS, MU7_ANSWER_TEXT, type Mu7Family } from '@/lib/mu7-types';
import styles from './practice-sections.module.css';

// Operational guidance only; this is not the formal scientific rubric or a gate approval.
export const PRACTICE_GUIDE_VERSION = 'practice-guide-1.0';
export const MAPPING_FAMILY_LABELS: Record<Mu7Family, string> = {
  AREA: 'Therapeutic area',
  ROW: 'Condition row',
  SG: 'Subgroup decision',
};

export function Mu7ReviewGuide({
  audience,
}: {
  audience: 'reviewer' | 'adjudicator' | 'investigator';
}) {
  return (
    <article className={styles.guide} aria-label="Synthetic practice review guide">
      <header>
        <p className={styles.eyebrow}>Practice instructions</p>
        <h3>Save an answer, then move to the next unit</h3>
        <p>
          Each unit asks about one trial and one displayed assignment. Use the trial evidence to
          make your own judgment.
        </p>
      </header>
      <ol className={styles.guideSteps}>
        <li>
          <strong>Read the assignment and evidence.</strong> Check the title, summary and any other
          evidence provided. A missing field is marked as missing.
        </li>
        <li>
          <strong>Choose your answer.</strong> If you disagree, choose a reason and add a short
          note. You can also flag uncertainty about your answer.
        </li>
        <li>
          <strong>Press Save answer.</strong> Wait for “Answer saved.” before moving on. An error
          message means the save was not confirmed. Selecting an answer alone does not save it.
        </li>
        <li>
          <strong>Return to check your recorded answer.</strong> While editing is allowed, use Save
          revision to record a change. Earlier saved answers remain in the history.
        </li>
      </ol>
      <p className={styles.guideNote}>
        Switching between the practice tabs keeps your unfinished answer on this page. Save before
        selecting another unit, reloading or closing the page.
      </p>
      {audience === 'adjudicator' && (
        <p className={styles.guideNote}>
          As adjudicator, you resolve only the units routed to you. Read both recorded judgments,
          select your decision and its basis, add your rationale, then save the adjudication. You do
          not enter a third independent reviewer answer.
        </p>
      )}
      {audience === 'investigator' && (
        <p className={styles.guideNote}>
          These answer instructions are for reviewers. Your investigator account manages practice
          and cannot enter or edit a reviewer judgment.
        </p>
      )}
      <div className={styles.guideColumns}>
        <section aria-label="Answer choices">
          <h4>Three answer choices</h4>
          <dl>
            {MU7_ANSWERS.map((answer) => (
              <div key={answer}>
                <dt>{MU7_ANSWER_TEXT[answer].label}</dt>
                <dd>{MU7_ANSWER_TEXT[answer].meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label="Types of assignment">
          <h4>What is being assessed?</h4>
          <dl>
            <div>
              <dt>{MAPPING_FAMILY_LABELS.AREA}</dt>
              <dd>A broad clinical category, such as Cardiovascular.</dd>
            </div>
            <div>
              <dt>{MAPPING_FAMILY_LABELS.ROW}</dt>
              <dd>A specific condition grouping, such as Hypertension.</dd>
            </div>
            <div>
              <dt>{MAPPING_FAMILY_LABELS.SG}</dt>
              <dd>
                A displayed decision to keep or remove a subgroup within a condition row. Assess
                that decision in the context of its parent row.
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <section className={styles.guideFooter}>
        <h4>Practice and examples stay separate</h4>
        <p>
          Practice answers are excluded from study results. Worked examples are read-only and do not
          count toward your queue. Make your own answers independently; send questions to the
          investigator rather than discussing individual units with the other reviewer.
        </p>
        <p>
          This guide explains the practice interface. The scientific rubric for formal review is
          still being finalized and will be provided before that review opens.
        </p>
        <p className={styles.guideVersion}>Guide version: {PRACTICE_GUIDE_VERSION}</p>
      </section>
    </article>
  );
}
