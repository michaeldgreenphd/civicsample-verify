'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Mu7Packet } from '../lib/mu7-types';
import { MU81_SUBTYPE_TEXT } from '../lib/mu7-types';
import type { PreviewUnit, SamplePreviewIndex } from '../lib/sample-preview';
import { reasonLabel } from '../lib/mu7-display';
import { ReviewGuide } from './practice-sections';
import { ReviewTarget } from './review-target';
import styles from './sample-preview.module.css';

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The proposed sample could not be loaded.');
  return data as T;
}
export function ProposedSamplePreview({
  renderPacket,
}: {
  renderPacket: (packet: Mu7Packet, profileId: string) => ReactNode;
}) {
  const [index, setIndex] = useState<SamplePreviewIndex | null>(null);
  const [unit, setUnit] = useState<PreviewUnit | null>(null);
  const [position, setPosition] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load(next: number) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setUnit(null);
    try {
      const list =
        index ?? (await read<SamplePreviewIndex>('/api/mu7/admin/preview', request.signal));
      const detail = await read<PreviewUnit>(`/api/mu7/admin/preview/${next}`, request.signal);
      if (request.signal.aborted) return;
      setIndex(list);
      setUnit(detail);
      setPosition(next);
    } catch (e) {
      if (!request.signal.aborted) setError((e as Error).message);
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className={`panel ${styles.preview}`} aria-labelledby="proposed-preview-heading">
      <div className="panel-body">
        <p className="section-label">Investigator preview</p>
        <h2 id="proposed-preview-heading">The proposed 100 mappings</h2>
        <p>
          Inspect the prepared trial evidence and the questions reviewers will see. This preview is
          read-only; it records no answers and does not open formal review.
        </p>
        {!index && (
          <button className="button secondary" disabled={busy} onClick={() => void load(1)}>
            {busy ? 'Loading preview…' : 'Preview all 100 mappings'}
          </button>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {index && (
          <>
            <div className={styles.toolbar}>
              <p className={styles.count}>
                56 therapeutic areas · 40 conditions · 4 inclusion checks
              </p>
              <button
                className="button secondary"
                aria-expanded={showGuide}
                onClick={() => setShowGuide(!showGuide)}
              >
                {showGuide ? 'Return to mappings' : 'Read the reviewer guide'}
              </button>
              <button
                className="button ghost"
                onClick={() => {
                  controller.current?.abort();
                  setIndex(null);
                  setUnit(null);
                  setError('');
                  setBusy(false);
                  setShowGuide(false);
                }}
              >
                Close preview
              </button>
            </div>
            {showGuide ? (
              <ReviewGuide text={index.guide.text} />
            ) : (
              <>
                <nav className={styles.navigation} aria-label="Proposed mapping navigation">
                  <button
                    className="button secondary"
                    disabled={busy || position === 1}
                    onClick={() => void load(position - 1)}
                  >
                    Previous
                  </button>
                  <label className={styles.selector}>
                    Mapping
                    <select
                      aria-label="Choose a proposed mapping"
                      value={position}
                      disabled={busy}
                      onChange={(event) => void load(Number(event.target.value))}
                    >
                      {index.units.map((u) => (
                        <option key={u.position} value={u.position}>
                          {u.position}. {u.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button secondary"
                    disabled={busy || position === 100}
                    onClick={() => void load(position + 1)}
                  >
                    Next
                  </button>
                </nav>
                <p role="status">
                  {busy
                    ? 'Loading mapping…'
                    : `Mapping ${position} of 100 · Proposed, not open for review`}
                </p>
                {unit && (
                  <div key={unit.unit_id}>
                    {renderPacket(unit.packet, index.guide.profile_id)}
                    <section className={styles.answers} aria-label="Answer choices preview">
                      <h3>How reviewers will answer</h3>
                      <p>These choices are shown for inspection only.</p>
                      <ReviewTarget
                        unit={unit.packet.unit}
                        profileId={index.guide.profile_id}
                        id="mu7-preview-target"
                      />
                      <dl>
                        {unit.answer_options.map((a) => (
                          <div key={a.code}>
                            <dt>{a.label}</dt>
                            <dd>{a.meaning}</dd>
                          </div>
                        ))}
                      </dl>
                      <details>
                        <summary>Reasons available for Disagree</summary>
                        <ul>
                          {unit.reason_codes.map((r) => (
                            <li key={r.code}>
                              <strong>{reasonLabel(r.code, index.guide.profile_id)}.</strong>{' '}
                              {r.meaning}
                            </li>
                          ))}
                        </ul>
                      </details>
                      {unit.subtype_required && (
                        <div className={styles.subtype}>
                          <h4>
                            Does the registry text state that the trial studies type 2 diabetes?
                          </h4>
                          <p>Required separately from the membership answer; not adjudicated.</p>
                          <ul>
                            {Object.values(MU81_SUBTYPE_TEXT).map((label) => (
                              <li key={label}>{label}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p>
                        Reviewers can also record uncertainty and a note. No investigator judgment
                        is collected here.
                      </p>
                    </section>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
