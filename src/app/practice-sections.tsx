'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { parseReviewerGuide } from '@/lib/mu7-display';
import styles from './practice-sections.module.css';

/** Keep both panels mounted: consulting an example must not erase an unfinished answer. */
export function PracticeSections({
  workLabel,
  description,
  exampleCount,
  progress,
  children,
  examples,
  guide,
  reviewMode = false,
}: {
  workLabel: string;
  description: string;
  exampleCount: number;
  progress?: { answered: number; total: number };
  children: ReactNode;
  examples: ReactNode;
  guide?: ReactNode;
  reviewMode?: boolean;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = [workLabel, 'Worked examples', ...(guide ? ['Review guide'] : [])];
  function activate(index: number) {
    setActive(index);
    tabs.current[index]?.focus();
  }
  return (
    <div className={styles.workspace}>
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>
            {reviewMode
              ? 'Clinical classification review'
              : 'Synthetic practice · outside the study results'}
          </p>
          <h2>{reviewMode ? 'Your review workspace' : 'Your practice workspace'}</h2>
          <p className={styles.description}>{description}</p>
        </div>
        {progress && (
          <div className={styles.progress}>
            <span>
              <strong>{progress.answered}</strong> / {progress.total} answered
            </span>
            <progress
              aria-label={reviewMode ? 'Your review progress' : 'Your practice progress'}
              value={progress.answered}
              max={Math.max(1, progress.total)}
            />
          </div>
        )}
      </header>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={reviewMode ? 'Review workspace' : 'Practice workspace'}
      >
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
                    ? labels.length - 1
                    : event.key === 'ArrowRight'
                      ? (i + 1) % labels.length
                      : event.key === 'ArrowLeft'
                        ? (i + labels.length - 1) % labels.length
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
              examples are read-only and separate from your {reviewMode ? 'review' : 'practice'}{' '}
              answers.
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
      {guide && (
        <div
          role="tabpanel"
          id={`${id}-panel-2`}
          aria-labelledby={`${id}-tab-2`}
          tabIndex={0}
          hidden={active !== 2}
        >
          <div className={styles.guideIntro}>
            <p className="muted">
              Consult these instructions at any time. Your unfinished answer stays in place when you
              return.
            </p>
            <button type="button" className="button secondary" onClick={() => activate(0)}>
              Back to {workLabel.toLowerCase()}
            </button>
          </div>
          {guide}
        </div>
      )}
    </div>
  );
}

function guideText(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

/** React text nodes escape every source string. The guide cannot create HTML or links. */
export function ReviewGuide({ text }: { text: string }) {
  return (
    <article className={styles.guide} aria-label="Review instructions">
      {parseReviewerGuide(text).map((block, i) => {
        if (block.kind === 'heading') {
          const Heading = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
          return <Heading key={i}>{guideText(block.text)}</Heading>;
        }
        if (block.kind === 'paragraph') return <p key={i}>{guideText(block.text)}</p>;
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={i}>
              {block.items.map((item, n) => (
                <li key={n}>{guideText(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <div
            className={styles.guideTable}
            key={i}
            // A focusable overflow region lets keyboard users read wide tables on narrow screens.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={`Review guide table ${i + 1}`}
          >
            <table>
              <thead>
                <tr>
                  {block.headings.map((heading, n) => (
                    <th key={n} scope="col">
                      {guideText(heading)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, n) => (
                  <tr key={n}>
                    {row.map((cell, c) => (
                      <td key={c}>{guideText(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </article>
  );
}
