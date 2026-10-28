'use client';
import { useState } from 'react';
import {
  RELEASE_ACTIONS,
  releaseBlocker,
  releaseStatusSchema,
  type ReleaseAction,
  type ReleaseStatus,
} from '../lib/formal-release';
import styles from './formal-release.module.css';

async function request(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? 'The request was not confirmed. Refresh before trying again.');
  return value;
}

export function FormalRelease({ onRecorded }: { onRecorded: () => Promise<unknown> }) {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [action, setAction] = useState<ReleaseAction>('record-descriptive-plan');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [attestation, setAttestation] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reviewers, setReviewers] = useState(['', '']);
  const [qualifications, setQualifications] = useState(['', '']);
  const [pilot, setPilot] = useState('');
  const [bundle, setBundle] = useState<{
    manifestSha256: string;
    files: { name: string; rows: number }[];
  } | null>(null);

  async function refresh() {
    setBusy(true);
    setMessage('');
    setStatus(null);
    setConfirmed(false);
    try {
      setStatus(releaseStatusSchema.parse(await request('/api/mu7/admin/release')));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Release status could not be checked.');
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    if (!status) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await request('/api/mu7/admin/release', {
        action,
        stateSha256: status.state_sha256,
        attestation,
        confirm: confirmed,
        ...(action === 'accept-pilot' ? { pilotExportId: pilot } : {}),
        ...(action === 'assign-reviewers' ? { reviewerIds: reviewers, qualifications } : {}),
      });
      setStatus(releaseStatusSchema.parse(next));
      setAttestation('');
      setMessage(`${RELEASE_ACTIONS[action].label}: recorded.`);
      try {
        await onRecorded();
      } catch {
        setMessage('The action was recorded. Reload the page to update the rest of the workspace.');
      }
    } catch (e) {
      setStatus(null);
      setMessage(
        e instanceof Error
          ? e.message
          : 'The action was not confirmed. Refresh before trying again.',
      );
    } finally {
      setConfirmed(false);
      setBusy(false);
    }
  }
  async function exportBundle(register: boolean) {
    setBusy(true);
    setMessage('');
    try {
      if (register) {
        await request('/api/mu7/admin/action', { action: 'register-formal-export' });
        setStatus(releaseStatusSchema.parse(await request('/api/mu7/admin/release')));
        setMessage('The formal export is registered. Keep its manifest with the downloaded files.');
      } else setBundle(await request('/api/mu7/admin/export/FORMAL'));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The locked export could not be verified.');
    } finally {
      setBusy(false);
    }
  }
  const blocker = status ? releaseBlocker(status, action) : 'Check release status first.';
  const selectionMissing =
    action === 'accept-pilot'
      ? !status?.pilot_exports.some((e) => e.id === pilot)
      : action === 'assign-reviewers'
        ? reviewers.some((r) => !r || !status?.reviewers.some((u) => u.id === r)) ||
          reviewers[0] === reviewers[1] ||
          qualifications.some((q) => q.trim().length < 20)
        : false;
  return (
    <section className={`panel ${styles.panel}`} aria-labelledby="release-heading">
      <h2 id="release-heading">Prepare and open clinical review</h2>
      <p>
        Each step records a separate investigator action. Checking status changes nothing. Formal
        review stays closed until you explicitly open it.
      </p>
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
      >
        {busy ? 'Working…' : 'Check release status'}
      </button>
      {status && (
        <>
          <dl className={styles.status} aria-label="Release status">
            <div>
              <dt>Review phase</dt>
              <dd>
                {
                  {
                    NOT_SIGNED_OFF: 'Rehearsal not accepted',
                    SIGNED_OFF: 'Ready for remaining preparation',
                    OPEN: 'Open',
                    CLOSED_COMPLETE: 'Closed after both finished',
                    CLOSED_INCOMPLETE: 'Closed incomplete',
                  }[status.phase]
                }
              </dd>
            </div>
            <div>
              <dt>Mappings / assignments</dt>
              <dd>
                {status.formal_units} / {status.assignments}
              </dd>
            </div>
            <div>
              <dt>Worked examples</dt>
              <dd>{status.training_units} of 3</dd>
            </div>
            <div>
              <dt>Sample freeze</dt>
              <dd>{status.frozen ? 'Frozen' : 'Not frozen'}</dd>
            </div>
            {status.completion.map((c) => (
              <div key={c.reviewer_slot}>
                <dt>Reviewer {c.reviewer_slot}</dt>
                <dd>
                  {c.finished ? 'Finished and locked' : `${c.answered} of ${c.assigned} saved`}
                </dd>
              </div>
            ))}
          </dl>
          <label className={styles.field} htmlFor="release-step">
            Choose a step
          </label>
          <select
            id="release-step"
            value={action}
            disabled={busy}
            onChange={(e) => {
              setAction(e.target.value as ReleaseAction);
              setConfirmed(false);
              setAttestation('');
              setMessage('');
            }}
          >
            {(Object.entries(RELEASE_ACTIONS) as [ReleaseAction, { label: string }][]).map(
              ([key, v]) => (
                <option key={key} value={key}>
                  {v.label}
                </option>
              ),
            )}
          </select>
          <p id="release-description">{RELEASE_ACTIONS[action].description}</p>
          {action === 'record-descriptive-plan' && (
            <details className={styles.details}>
              <summary>What the initial report includes</summary>
              <p>
                Final independent answers, reviewer agreement and unweighted kappa for area and
                condition-row mappings separately. Confirmed, not confirmed and unresolved outcomes
                use all reviewed mappings in that family as their denominator. Individual categories
                and subgroup checks have counts only.
              </p>
              <p>
                Two Cannot tell answers still go to adjudication and remain separately flagged.
                Matching Cannot tell answers count as reviewer agreement, not clinical confirmation.
                Weights, confidence intervals and estimates for the wider trial population are
                deferred.
              </p>
            </details>
          )}
          {blocker ? (
            <p className={styles.blocker} role="status">
              {blocker}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void record();
              }}
            >
              {action === 'accept-pilot' && (
                <label className={styles.field}>
                  Registered rehearsal export
                  <select
                    required
                    value={pilot}
                    onChange={(e) => {
                      setPilot(e.target.value);
                      setConfirmed(false);
                    }}
                    disabled={busy}
                  >
                    <option value="">Choose the export whose rehearsal you verified</option>
                    {status.pilot_exports.map((e, i) => (
                      <option key={e.id} value={e.id}>
                        Export {i + 1} · {e.manifest.slice(0, 12)}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    Confirm the reviewed build, role isolation, save/finish flow, adjudication,
                    export, mobile layout, and recovery checks in the rehearsal checklist.
                  </span>
                </label>
              )}
              {action === 'assign-reviewers' &&
                [0, 1].map((i) => (
                  <fieldset key={i} className={styles.reviewer}>
                    <legend>Reviewer {i + 1}</legend>
                    <label className={styles.field}>
                      Account
                      <select
                        required
                        value={reviewers[i]}
                        disabled={busy}
                        onChange={(e) => {
                          setReviewers((old) => old.map((v, n) => (n === i ? e.target.value : v)));
                          setConfirmed(false);
                        }}
                      >
                        <option value="">Choose a clinical reviewer</option>
                        {status.reviewers.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.field}>
                      Clinical qualifications and role confirmation
                      <textarea
                        required
                        minLength={20}
                        maxLength={2000}
                        rows={2}
                        value={qualifications[i]}
                        disabled={busy}
                        onChange={(e) => {
                          setQualifications((old) =>
                            old.map((v, n) => (n === i ? e.target.value : v)),
                          );
                          setConfirmed(false);
                        }}
                      />
                    </label>
                  </fieldset>
                ))}
              <label className={styles.field} htmlFor="release-attestation">
                Why you authorize this step
              </label>
              <textarea
                id="release-attestation"
                aria-describedby="release-description"
                required
                minLength={20}
                maxLength={2000}
                rows={3}
                value={attestation}
                disabled={busy}
                onChange={(e) => {
                  setAttestation(e.target.value);
                  setConfirmed(false);
                }}
              />
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>I reviewed this step and authorize it for this workspace.</span>
              </label>
              <button
                type="submit"
                className="button"
                disabled={busy || !confirmed || attestation.trim().length < 20 || selectionMissing}
              >
                {RELEASE_ACTIONS[action].label}
              </button>
            </form>
          )}
          {status.reference_locked && (
            <div className={styles.exports}>
              <h3>Locked study export</h3>
              <p>
                Download the complete bundle and its manifest. The report describes this reviewed
                sample; it does not estimate the wider trial population.
              </p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void exportBundle(false)}
              >
                Build formal export
              </button>
              {bundle && (
                <>
                  <p className={styles.hash}>Manifest: {bundle.manifestSha256}</p>
                  <ul>
                    <li>
                      <a href="/api/mu7/admin/export/FORMAL/manifest.json">manifest.json</a>
                    </li>
                    {bundle.files.map((f) => (
                      <li key={f.name}>
                        <a href={`/api/mu7/admin/export/FORMAL/${f.name}`}>{f.name}</a> ({f.rows}{' '}
                        rows)
                      </li>
                    ))}
                  </ul>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void exportBundle(true)}
                  >
                    Register formal export
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      {message && (
        <p role="status" className={styles.message}>
          {message}
        </p>
      )}
    </section>
  );
}
