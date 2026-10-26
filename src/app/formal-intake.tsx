'use client';
import { useState } from 'react';
import type { FormalIntakePlan } from '../lib/formal-intake';
import styles from './formal-intake.module.css';

export function FormalSampleIntake({ onRecorded }: { onRecorded: () => Promise<unknown> }) {
  const [plan, setPlan] = useState<FormalIntakePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [attestation, setAttestation] = useState('');
  const [message, setMessage] = useState('');
  async function act(load: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/mu7/admin/intake', {
        method: load ? 'POST' : 'GET',
        cache: 'no-store',
        ...(load
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ packageSha256: plan?.packageSha256, attestation }),
            }
          : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Sample intake could not be checked.');
      if (load) {
        setMessage(
          'The 100 mappings are recorded. Review remains closed; no reviewer queue or approval was created.',
        );
        setPlan(null);
        setAttestation('');
        try {
          await onRecorded();
        } catch {
          setMessage(
            'The 100 mappings are recorded and review remains closed. Refresh the page to update the preparation status.',
          );
        }
      } else setPlan(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Sample intake could not be checked.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`panel ${styles.panel}`} aria-labelledby="sample-intake-heading">
      <h2 id="sample-intake-heading">Connect the prepared sample</h2>
      <p>
        Check the private package before loading its 100 mappings into a new review workspace. This
        records the packets and guide, while keeping clinical review closed.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => {
          setPlan(null);
          void act(false);
        }}
      >
        {busy ? 'Checking…' : 'Check prepared sample'}
      </button>
      {plan && (
        <div>
          <p>
            100 mappings · 200 planned queue positions · guide{' '}
            {plan.guideProfile.endsWith('-r4') ? 'revision 4' : 'revision 3'}
          </p>
          {plan.targetState === 'CLOSED' ? (
            <p>The sample has already progressed beyond preparation. Intake is closed.</p>
          ) : plan.targetState === 'OCCUPIED' ? (
            <p>
              This workspace already contains a design. Use a separate empty destination; the
              practice records cannot be replaced here.
            </p>
          ) : (
            <>
              <p>
                {plan.targetState === 'RECORDED'
                  ? 'An intake receipt already exists. Repeating the identical package verifies that receipt without adding records.'
                  : 'The destination is empty. Loading saves all 100 mappings together or none of them.'}
              </p>
              <label htmlFor="intake-attestation">
                Record your authorization to load these packets for preparation
              </label>
              <textarea
                id="intake-attestation"
                value={attestation}
                onChange={(e) => setAttestation(e.target.value)}
                minLength={20}
                maxLength={2000}
                rows={3}
              />
              <p>
                Loading does not approve a scientific decision, freeze the sample or allow reviewers
                to answer.
              </p>
              <button
                type="button"
                className="button"
                disabled={busy || attestation.trim().length < 20}
                onClick={() => void act(true)}
              >
                Load 100 mappings for preparation
              </button>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
