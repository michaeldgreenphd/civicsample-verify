'use client';
import { useEffect, useState } from 'react';
import type { PracticeObserverWorkspace } from '@/lib/practice-observer';
import { Training } from './mu7-workspace';
import { PracticeSections } from './practice-sections';
export function PracticeObserverPanel() {
  const [workspace, setWorkspace] = useState<PracticeObserverWorkspace | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/practice-observer', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            'Practice information could not be loaded. Refresh or contact the investigator.',
          );
        const w = await r.json();
        if (active) setWorkspace(w);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section aria-label="View-only practice">
      <h2>View-only practice</h2>
      <p>
        You can view completion progress and the worked examples. Review answers and administrative
        controls are unavailable to this account.
      </p>
      {error && <p role="alert">{error}</p>}
      {!workspace && !error && <p>Loading practice information…</p>}
      {workspace && (
        <PracticeSections
          workLabel="Progress"
          description="View practice completion and revisit the read-only examples."
          exampleCount={workspace.training.length}
          examples={<Training training={workspace.training} />}
        >
          <p>
            {workspace.pilotUnits} synthetic units ·{' '}
            {workspace.locked ? 'Practice reference locked' : 'Practice in progress'}
          </p>
          <section className="panel" aria-label="Reviewer progress">
            <div className="panel-body">
              {workspace.completion.length ? (
                workspace.completion.map((r) => (
                  <p key={r.reviewerSlot}>
                    Reviewer {r.reviewerSlot}: {r.answered} of {r.assigned} answered
                  </p>
                ))
              ) : (
                <p>No practice assignments yet.</p>
              )}
              <p className="muted">Refresh this page to update the counts.</p>
            </div>
          </section>
        </PracticeSections>
      )}
    </section>
  );
}
