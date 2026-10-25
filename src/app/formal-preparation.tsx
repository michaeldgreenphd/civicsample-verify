import type { Mu7InvestigatorWorkspace } from '../lib/mu7-types';
import { formalPreparation } from '../lib/formal-preparation';
import styles from './formal-preparation.module.css';

export function FormalPreparation({ workspace }: { workspace: Mu7InvestigatorWorkspace }) {
  const report = formalPreparation(workspace);
  function download() {
    const text = JSON.stringify({ ...report, generated_at: new Date().toISOString() }, null, 2);
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'formal-review-preparation-status.json';
    link.click();
    // Allow the browser to consume the URL before releasing its storage.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className={`panel ${styles.panel}`} aria-labelledby="formal-preparation-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Investigator workspace</p>
          <h2 id="formal-preparation-heading">Preparing formal review</h2>
          <p className={styles.intro}>
            Recorded progress and the steps still ahead. This checklist does not approve the study
            or open it to reviewers.
          </p>
        </div>
        <button type="button" className="button secondary" onClick={download}>
          Download preparation status
        </button>
      </div>
      <dl className={styles.list}>
        {report.checks.map((check) => (
          <div key={check.id} className={styles.item}>
            <dt>{check.label}</dt>
            <dd>
              <span className={styles.status} data-state={check.state}>
                {check.status}
              </span>
              <p>{check.detail}</p>
            </dd>
          </div>
        ))}
      </dl>
      <p className={styles.footer}>
        Based on this workspace only. The download contains status and version information, with no
        trial packets, passwords or reviewer answers.
      </p>
    </section>
  );
}
