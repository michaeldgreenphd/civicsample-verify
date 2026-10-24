'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import styles from './practice-sections.module.css';

/** Keep both panels mounted: consulting an example must not erase an unfinished answer. */
export function PracticeSections({
  workLabel,
  description,
  exampleCount,
  progress,
  children,
  examples,
}: {
  workLabel: string;
  description: string;
  exampleCount: number;
  progress?: { answered: number; total: number };
  children: ReactNode;
  examples: ReactNode;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = [workLabel, 'Worked examples'];
  function activate(index: number) {
    setActive(index);
    tabs.current[index]?.focus();
  }
  return (
    <div className={styles.workspace}>
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Synthetic practice · outside the study results</p>
          <h2>Your practice workspace</h2>
          <p className={styles.description}>{description}</p>
        </div>
        {progress && (
          <div className={styles.progress}>
            <span>
              <strong>{progress.answered}</strong> / {progress.total} answered
            </span>
            <progress
              aria-label="Your practice progress"
              value={progress.answered}
              max={Math.max(1, progress.total)}
            />
          </div>
        )}
      </header>
      <div className={styles.tabs} role="tablist" aria-label="Practice workspace">
        {labels.map((label, i) => (
          <button
            key={label}
            ref={(node) => {
              tabs.current[i] = node;
            }}
            id={`${id}-tab-${i}`}
            type="button"
            role="tab"
            aria-selected={active === i}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 1
                    : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                      ? 1 - i
                      : null;
              if (next !== null) {
                event.preventDefault();
                activate(next);
              }
            }}
          >
            {label}
            {i === 1 && (
              <span className={styles.count} aria-hidden="true">
                {exampleCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-0`}
        aria-labelledby={`${id}-tab-0`}
        tabIndex={0}
        hidden={active !== 0}
      >
        {children}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-1`}
        aria-labelledby={`${id}-tab-1`}
        tabIndex={0}
        hidden={active !== 1}
      >
        <div className={styles.examplesIntro}>
          <div>
            <h3>See how an answer becomes a recorded decision</h3>
            <p>
              Read the evidence, compare the illustrative answers, then see the outcome. These
              examples are read-only and separate from your practice answers.
            </p>
          </div>
          <button type="button" className="button secondary" onClick={() => activate(0)}>
            Back to {workLabel.toLowerCase()}
          </button>
        </div>
        {exampleCount ? (
          examples
        ) : (
          <div className="panel empty-state">
            The investigator has not added the worked examples yet. You can return to your workspace
            in the meantime.
          </div>
        )}
      </div>
    </div>
  );
}
