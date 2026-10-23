'use client';

// Mapping-confirmation workspace: the reviewer sees the existing assignment under review together
// with the source evidence and answers Yes/No (or the proposed Insufficient information), the
// adjudicator resolves disagreements after both finals, and the investigator runs the synthetic
// campaign. Every rule the screens express is enforced again by the database.
import { useCallback, useEffect, useState } from 'react';
import {
  MC_ANSWERS,
  MC_ANSWER_LABELS,
  MC_ADJUDICATION_STATUSES,
  type McAdjudicationInput,
  type McAdjudicatorCase,
  type McAdjudicatorWorkspace,
  type McAdminAction,
  type McAnswer,
  type McBundle,
  type McCaseView,
  type McInvestigatorWorkspace,
  type McReviewerCase,
  type McReviewerWorkspace,
  type McTrainingExample,
  type McWorkspace,
} from '@/lib/mapconf-types';
import type { Actor } from '@/lib/types';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string' ? body.error : 'The request could not be completed.',
    );
  return body as T;
}
const readable = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
const CATEGORY: Record<McCaseView['recordCategory'], string> = {
  SYNTHETIC_PILOT: 'Synthetic pilot',
  TRAINING_EXAMPLE: 'Training example',
  EVALUATION: 'Evaluation',
};

export function McPanel({ user }: { user: Actor }) {
  const [workspace, setWorkspace] = useState<McWorkspace | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<McWorkspace>('/api/mc/workspace');
    setWorkspace(next);
    return next;
  }, []);
  useEffect(() => {
    api<McWorkspace>('/api/mc/workspace')
      .then((next) => setWorkspace(next))
      .catch((e) => setError(e.message));
  }, []);
  if (error)
    return (
      <div className="notice error" role="alert">
        {error}
      </div>
    );
  if (!workspace)
    return (
      <div className="loading">
        <span className="loading-dot" />
        Loading the mapping-confirmation workspace…
      </div>
    );
  if (workspace.kind === 'investigator')
    return <McInvestigator workspace={workspace} onRefresh={refresh} />;
  if (workspace.kind === 'adjudicator')
    return (
      <McAdjudicator
        workspace={workspace}
        selected={selected}
        onSelect={setSelected}
        onRefresh={refresh}
      />
    );
  return (
    <McReviewer
      workspace={workspace}
      selected={selected}
      onSelect={setSelected}
      onRefresh={refresh}
      user={user}
    />
  );
}

function Banner() {
  return (
    <div className="notice warning">
      <strong>Mapping confirmation, synthetic pilot</strong>Each item is one trial-to-condition
      mapping. The existing assignment is shown by investigator decision; this is a mapping
      confirmation, not a blinded clinical reference assessment. The condition list and rubric are
      proposed, and synthetic records never enter any statistic.
    </div>
  );
}

function Evidence({ c, ids = false }: { c: McCaseView; ids?: boolean }) {
  const [open, setOpen] = useState(false);
  const e = c.evidence;
  // Test ids mark the mapping in the main pane only; training walkthroughs reuse this component.
  const tid = (name: string) => (ids ? name : undefined);
  return (
    <section className="panel" aria-label="Mapping under review">
      <div className="panel-header">
        <span className="section-label">Mapping under review</span>
        <span className="muted">
          {CATEGORY[c.recordCategory]} · {c.caseId}
        </span>
      </div>
      <div className="panel-body">
        <div className="context-grid">
          <div>
            <span className="form-label">Condition</span>
            <strong data-testid={tid('mc-condition')}>{c.conditionLabel}</strong>{' '}
            <span className="mono muted">{c.conditionCode}</span>
          </div>
          <div>
            <span className="form-label">Existing assignment</span>
            <strong data-testid={tid('mc-assignment')}>
              {c.assignment.assigned
                ? 'Assigned to this condition'
                : 'Not assigned to this condition'}
            </strong>
            <div className="muted">
              Source {c.assignment.assignment_source} · version {c.assignment.assignment_version}
            </div>
          </div>
          <div>
            <span className="form-label">Trial reference</span>
            <span className="mono">{c.trialRef}</span>
          </div>
          <div>
            <span className="form-label">Evidence source</span>
            <span>
              {e.source.system} {e.source.version} · fields {e.source.fields.join(', ')}
            </span>
          </div>
        </div>
        <div className="section-divider" />
        <span className="form-label">Trial title</span>
        <p data-testid={tid('mc-title')}>{e.brief_title}</p>
        <span className="form-label">Brief summary</span>
        {e.brief_summary.present ? (
          <p data-testid={tid('mc-summary')}>{e.brief_summary.text}</p>
        ) : (
          <p className="notice" data-testid={tid('mc-summary-missing')}>
            No brief summary exists in the source record. Nothing has been generated in its place.
          </p>
        )}
        {e.detailed_description && (
          <details open={open} onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
            <summary>
              Detailed description (source field {e.detailed_description.source_field}; scientific
              inclusion pending)
            </summary>
            {e.detailed_description.present ? (
              <p>{e.detailed_description.text}</p>
            ) : (
              <p className="muted">The source record has no detailed description.</p>
            )}
          </details>
        )}
        <p className="privacy-note">
          Evidence hash <span className="mono">{c.evidenceSha256.slice(0, 12)}…</span> · version{' '}
          {c.evidenceVersion} · assignment hash{' '}
          <span className="mono">{c.assignmentSha256.slice(0, 12)}…</span>
        </p>
      </div>
    </section>
  );
}

function Training({ training }: { training: McTrainingExample[] }) {
  if (!training.length) return null;
  return (
    <section className="panel" aria-label="Training examples">
      <div className="panel-header">
        <span className="section-label">
          Training examples (synthetic walkthroughs; never scored)
        </span>
      </div>
      <div className="panel-body">
        {training.map((t) => (
          <details key={t.caseId}>
            <summary>
              {t.caseId}: {t.walkthrough.purpose}
            </summary>
            {t.case ? <Evidence c={t.case} /> : <p className="muted">Not imported.</p>}
            <p>
              <strong>Scripted reviewer 1:</strong>{' '}
              {MC_ANSWER_LABELS[t.walkthrough.reviewer1.answer]} —{' '}
              {t.walkthrough.reviewer1.annotation}
            </p>
            <p>
              <strong>Scripted reviewer 2:</strong>{' '}
              {MC_ANSWER_LABELS[t.walkthrough.reviewer2.answer]} —{' '}
              {t.walkthrough.reviewer2.annotation}
            </p>
            {t.walkthrough.adjudication && (
              <p>
                <strong>Scripted adjudication:</strong>{' '}
                {readable(t.walkthrough.adjudication.status)}
                {t.walkthrough.adjudication.decision
                  ? ` (${t.walkthrough.adjudication.decision})`
                  : ''}{' '}
                — {t.walkthrough.adjudication.rationale}
              </p>
            )}
            <p className="muted">{t.walkthrough.discussion}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
function McReviewer({
  workspace,
  selected,
  onSelect,
  onRefresh,
  user,
}: {
  workspace: McReviewerWorkspace;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => Promise<McWorkspace>;
  user: Actor;
}) {
  const [detail, setDetail] = useState<McReviewerCase | null>(null);
  const [answer, setAnswer] = useState<McAnswer | ''>('');
  const [annotation, setAnnotation] = useState('');
  const [error, setError] = useState('');
  const [started, setStarted] = useState(0);
  useEffect(() => {
    if (!selected) return;
    api<McReviewerCase>(`/api/mc/assignments/${selected}`)
      .then((next) => {
        setDetail(next);
        setAnswer('');
        setAnnotation('');
        setStarted(Date.now());
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [selected]);
  const shown = selected && detail?.assignmentId === selected ? detail : null;
  async function submit() {
    if (!shown || !answer) return;
    const detail = shown;
    try {
      const next = await api<McReviewerCase>(`/api/mc/assignments/${detail.assignmentId}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          answer,
          annotation: annotation.trim() || undefined,
          displayedAssignmentSha256: detail.case.assignmentSha256,
          displayedEvidenceSha256: detail.case.evidenceSha256,
          displayedEvidenceVersion: detail.case.evidenceVersion,
          rubricVersion: detail.campaign.rubricVersion,
          rubricSha256: detail.campaign.rubricSha256,
          secondsOnCase: Math.max(0, Math.round((Date.now() - started) / 1000)),
        }),
      });
      setDetail(next);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="workspace-grid">
      <aside className="panel" aria-label="Mapping queue">
        <div className="panel-header">
          <span className="section-label">Your mappings</span>
          <span className="muted">{user.displayName}</span>
        </div>
        <ul className="queue-list">
          {workspace.queue.map((q) => (
            <li key={q.assignmentId}>
              <button
                className={`queue-item${selected === q.assignmentId ? ' active' : ''}`}
                onClick={() => onSelect(q.assignmentId)}
                aria-label={`${q.caseId}: ${q.conditionLabel}`}
              >
                <span className="queue-top">
                  <span className="mono">{q.caseId}</span>
                  <span className="queue-meta">{q.submitted ? 'Submitted' : 'Open'}</span>
                </span>
                <span className="queue-copy">
                  {q.conditionLabel} · {q.briefTitle}
                </span>
              </button>
            </li>
          ))}
          {!workspace.queue.length && <li className="muted">No mappings are assigned to you.</li>}
        </ul>
        <p className="privacy-note">
          You never see another reviewer’s answer. Submitted answers are final.
        </p>
      </aside>
      <div>
        <Banner />
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {shown ? (
          <>
            <Evidence c={shown.case} ids />
            <section className="panel" aria-label="Your answer">
              <div className="panel-header">
                <span className="section-label">Is the existing assignment appropriate?</span>
                <span className="muted">
                  Rubric {shown.campaign.rubricVersion} · {shown.campaign.rubricSha256.slice(0, 12)}
                  …
                </span>
              </div>
              <div className="panel-body">
                {shown.ownResponse ? (
                  <div className="notice" data-testid="mc-own-response">
                    <strong>Your final answer:</strong> {MC_ANSWER_LABELS[shown.ownResponse.answer]}
                    {shown.ownResponse.annotation ? ` — ${shown.ownResponse.annotation}` : ''}
                    {shown.ownResponse.rubricAdditionProposed &&
                      ' (recorded as a proposed rubric addition, not an approval)'}
                  </div>
                ) : shown.submissionsOpen ? (
                  <>
                    <fieldset className="field">
                      <legend className="form-label">Answer</legend>
                      {MC_ANSWERS.map((a) => (
                        <label key={a} style={{ display: 'block' }}>
                          <input
                            type="radio"
                            name="mc-answer"
                            value={a}
                            checked={answer === a}
                            onChange={() => setAnswer(a)}
                          />{' '}
                          {MC_ANSWER_LABELS[a]}
                        </label>
                      ))}
                    </fieldset>
                    <label className="field">
                      <span className="form-label">
                        Annotation {answer && answer !== 'YES' ? '(required)' : '(optional)'}
                      </span>
                      <textarea
                        value={annotation}
                        onChange={(e) => setAnnotation(e.target.value)}
                        rows={3}
                        maxLength={4000}
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="button"
                        disabled={!answer || (answer !== 'YES' && !annotation.trim())}
                        onClick={submit}
                      >
                        Submit final answer
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">Submissions are closed.</p>
                )}
              </div>
            </section>
          </>
        ) : (
          <div className="panel empty-state">Select a mapping from your queue.</div>
        )}
        <Training training={workspace.training} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function McAdjudicator({
  workspace,
  selected,
  onSelect,
  onRefresh,
}: {
  workspace: McAdjudicatorWorkspace;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => Promise<McWorkspace>;
}) {
  const [detail, setDetail] = useState<McAdjudicatorCase | null>(null);
  const emptyForm: Omit<McAdjudicationInput, 'caseId'> = {
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: '',
    decision: 'YES',
  };
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!selected) return;
    api<McAdjudicatorCase>(`/api/mc/cases/${selected}`)
      .then((next) => {
        // A newly loaded mapping starts from an empty form: nothing typed for another mapping
        // may be submitted as this mapping's immutable adjudication. The default status follows
        // the answers (both insufficient: rubric-addition review; otherwise a disagreement).
        const bothInsufficient =
          next.responses.length === 2 &&
          next.responses.every((r) => r.answer === 'INSUFFICIENT_INFORMATION');
        setDetail(next);
        setForm({
          ...emptyForm,
          status: bothInsufficient ? 'RUBRIC_ADDITION_REVIEWED' : 'DISCORDANT_RESOLVED',
          basis: bothInsufficient ? 'NONE' : 'REVIEWER_1',
          decision: bothInsufficient ? undefined : 'YES',
        });
        setError('');
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- emptyForm is a constant literal
  }, [selected]);
  const shown = selected && detail?.case.caseId === selected ? detail : null;
  async function decide() {
    if (!shown) return;
    const detail = shown;
    const noDecision = form.status !== 'DISCORDANT_RESOLVED';
    try {
      const next = await api<McAdjudicatorCase>('/api/mc/adjudicate', {
        method: 'POST',
        body: JSON.stringify({
          caseId: detail.case.caseId,
          status: form.status,
          basis: noDecision ? 'NONE' : form.basis,
          decision: noDecision ? undefined : form.decision,
          rationale: form.rationale,
        }),
      });
      setDetail(next);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="workspace-grid">
      <aside className="panel" aria-label="Adjudication queue">
        <div className="panel-header">
          <span className="section-label">Complete mappings</span>
          <span className="muted">
            {workspace.campaign ? readable(workspace.campaign.phase) : 'No campaign'}
          </span>
        </div>
        <ul className="queue-list">
          {workspace.queue.map((q) => (
            <li key={q.caseId}>
              <button
                className={`queue-item${selected === q.caseId ? ' active' : ''}`}
                onClick={() => onSelect(q.caseId)}
              >
                <span className="queue-top">
                  <span className="mono">{q.caseId}</span>
                  <span className="queue-meta">
                    {q.adjudicated
                      ? 'Adjudicated'
                      : q.needsAdjudication
                        ? 'Needs adjudication'
                        : 'Concordant'}
                  </span>
                </span>
                <span className="queue-copy">
                  {q.conditionLabel} · {q.reviewer1Answer ?? '—'} / {q.reviewer2Answer ?? '—'}
                </span>
              </button>
            </li>
          ))}
          {!workspace.queue.length && (
            <li className="muted">
              Nothing to adjudicate: both reviewers must submit and the investigator must authorize
              adjudication.
            </li>
          )}
        </ul>
      </aside>
      <div>
        <Banner />
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {shown ? (
          <>
            <Evidence c={shown.case} ids />
            <section className="panel" aria-label="Reviewer answers">
              <div className="panel-header">
                <span className="section-label">Independent final answers</span>
              </div>
              <div className="panel-body">
                {shown.responses.map((r) => (
                  <p key={r.reviewerSlot} data-testid={`mc-slot-${r.reviewerSlot}`}>
                    <strong>Reviewer {r.reviewerSlot}:</strong> {MC_ANSWER_LABELS[r.answer]}
                    {r.annotation ? ` — ${r.annotation}` : ''}
                  </p>
                ))}
                {shown.adjudication ? (
                  <div className="notice" data-testid="mc-adjudication">
                    <strong>Adjudicated:</strong> {readable(shown.adjudication.status)}
                    {shown.adjudication.decision ? ` (${shown.adjudication.decision})` : ''} —{' '}
                    {shown.adjudication.rationale}
                  </div>
                ) : (
                  <>
                    <label className="field">
                      <span className="form-label">Status</span>
                      <select
                        value={form.status}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            status: e.target.value as McAdjudicationInput['status'],
                          })
                        }
                      >
                        {MC_ADJUDICATION_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {readable(s)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {form.status === 'DISCORDANT_RESOLVED' && (
                      <>
                        <label className="field">
                          <span className="form-label">Decision</span>
                          <select
                            value={form.decision ?? 'YES'}
                            onChange={(e) =>
                              setForm({ ...form, decision: e.target.value as 'YES' | 'NO' })
                            }
                          >
                            <option value="YES">Yes, the mapping is appropriate</option>
                            <option value="NO">No, the mapping is not appropriate</option>
                          </select>
                        </label>
                        <label className="field">
                          <span className="form-label">Basis</span>
                          <select
                            value={form.basis}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                basis: e.target.value as McAdjudicationInput['basis'],
                              })
                            }
                          >
                            <option value="REVIEWER_1">Reviewer 1</option>
                            <option value="REVIEWER_2">Reviewer 2</option>
                            <option value="NEITHER">Neither</option>
                          </select>
                        </label>
                      </>
                    )}
                    <label className="field">
                      <span className="form-label">Rationale</span>
                      <textarea
                        value={form.rationale}
                        onChange={(e) => setForm({ ...form, rationale: e.target.value })}
                        rows={3}
                        maxLength={4000}
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="button"
                        disabled={form.rationale.trim().length < 3}
                        onClick={decide}
                      >
                        Record adjudication
                      </button>
                    </div>
                  </>
                )}
              </div>
            </section>
          </>
        ) : (
          <div className="panel empty-state">Select a complete mapping.</div>
        )}
        <Training training={workspace.training} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function McInvestigator({
  workspace,
  onRefresh,
}: {
  workspace: McInvestigatorWorkspace;
  onRefresh: () => Promise<McWorkspace>;
}) {
  const [error, setError] = useState('');
  const [attestation, setAttestation] = useState('');
  const [seed, setSeed] = useState(20261022);
  const [bundle, setBundle] = useState<McBundle | null>(null);
  async function act(input: McAdminAction) {
    try {
      await api('/api/mc/admin/action', { method: 'POST', body: JSON.stringify(input) });
      setError('');
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const c = workspace.campaign;
  const phase = c?.phase ?? null;
  return (
    <div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <section className="panel" aria-label="Campaign">
        <div className="panel-header">
          <span className="section-label">Synthetic campaign</span>
          <span className="header-phase" data-testid="mc-phase">
            {c
              ? `${readable(c.phase)} · ${c.conditionSetId} (${c.conditionSetStatus})`
              : 'No campaign'}
          </span>
        </div>
        <div className="panel-body">
          <div className="context-grid">
            <div className="stat">
              <span className="stat-value">{workspace.counts.syntheticPilot}</span>
              <span className="stat-label">Synthetic pilot mappings</span>
            </div>
            <div className="stat">
              <span className="stat-value">{workspace.counts.trainingExample}</span>
              <span className="stat-label">Training examples, excluded from statistics</span>
            </div>
            <div className="stat">
              <span className="stat-value">{workspace.counts.evaluation}</span>
              <span className="stat-label">Evaluation mappings</span>
            </div>
            <div className="stat">
              <span className="stat-value">{workspace.adjudicationsRecorded}</span>
              <span className="stat-label">Adjudications</span>
            </div>
          </div>
          {!c && (
            <div className="step">
              <h3>Start</h3>
              <p>
                Creates the campaign for the proposed condition list and draft rubric. Synthetic
                records never enter any statistic.
              </p>
              <button className="button" onClick={() => act({ action: 'create-campaign' })}>
                Create synthetic campaign
              </button>
            </div>
          )}
          {c && phase === 'OPEN' && (
            <div className="step">
              <h3>Prepare the pilot</h3>
              <p>
                {workspace.completion.length > 0
                  ? 'Every mapping is assigned to both pilot reviewers.'
                  : workspace.counts.syntheticPilot > 0
                    ? 'The synthetic mappings are imported. Assign each one to the two pilot reviewers.'
                    : 'Import the synthetic mappings, then assign each one to the two pilot reviewers.'}{' '}
                Evaluation import opens once the condition list, sampling frame and rubric are
                approved.
              </p>
              <div className="toolbar">
                {workspace.counts.syntheticPilot === 0 && (
                  <button
                    className="button secondary"
                    onClick={() => act({ action: 'import-synthetic' })}
                  >
                    Import synthetic mappings
                  </button>
                )}
                {workspace.completion.length === 0 && (
                  <>
                    <label className="field inline">
                      <span className="form-label">Seed</span>
                      <input
                        type="number"
                        value={seed}
                        min={1}
                        onChange={(e) => setSeed(Number(e.target.value))}
                      />
                    </label>
                    <button
                      className="button secondary"
                      disabled={workspace.counts.syntheticPilot === 0}
                      onClick={() => act({ action: 'assign', seed })}
                    >
                      Assign to the two pilot reviewers
                    </button>
                  </>
                )}
                <button
                  className="button secondary"
                  disabled
                  onClick={() => act({ action: 'import-evaluation' })}
                >
                  Import evaluation mappings
                </button>
              </div>
            </div>
          )}
          {c && phase !== 'LOCKED' && (
            <div className="step">
              <h3>
                {phase === 'OPEN'
                  ? 'Close submissions'
                  : phase === 'CLOSED'
                    ? 'Authorize adjudication'
                    : 'Lock the campaign'}
              </h3>
              <p>
                {phase === 'OPEN'
                  ? 'Ends reviewer submissions once every mapping has two final answers.'
                  : phase === 'CLOSED'
                    ? 'Lets the adjudicator resolve the disagreements.'
                    : 'Makes the campaign immutable and enables the export.'}{' '}
                Your attestation is recorded with the phase change.
              </p>
              <label className="field">
                <span className="form-label">Attestation</span>
                <input
                  value={attestation}
                  onChange={(e) => setAttestation(e.target.value)}
                  maxLength={2000}
                  placeholder="At least 20 characters"
                />
              </label>
              <div className="button-row">
                {phase === 'OPEN' && (
                  <button
                    className="button"
                    disabled={attestation.trim().length < 20}
                    onClick={() => act({ action: 'phase', eventType: 'CLOSED', attestation })}
                  >
                    Close submissions
                  </button>
                )}
                {phase === 'CLOSED' && (
                  <button
                    className="button"
                    disabled={attestation.trim().length < 20}
                    onClick={() =>
                      act({ action: 'phase', eventType: 'ADJUDICATION_AUTHORIZED', attestation })
                    }
                  >
                    Authorize adjudication
                  </button>
                )}
                {phase === 'ADJUDICATION' && (
                  <button
                    className="button"
                    disabled={attestation.trim().length < 20}
                    onClick={() => act({ action: 'phase', eventType: 'LOCKED', attestation })}
                  >
                    Lock the campaign
                  </button>
                )}
              </div>
            </div>
          )}
          {phase === 'LOCKED' && (
            <div className="button-row">
              <button
                className="button"
                onClick={() =>
                  api<McBundle>('/api/mc/admin/export')
                    .then((b) => {
                      setBundle(b);
                      setError('');
                    })
                    .catch((e) => setError(e.message))
                }
              >
                Build export
              </button>
              <button
                className="button secondary"
                onClick={() => act({ action: 'register-export' })}
              >
                Register export
              </button>
            </div>
          )}
          {bundle && (
            <div className="notice" data-testid="mc-bundle">
              <strong>Export {String(bundle.manifest.export_id)}</strong>{' '}
              {String(bundle.manifest.review_mode)} ·{' '}
              {String(bundle.manifest.assignment_visibility)} · manifest{' '}
              {bundle.manifestSha256.slice(0, 12)}…
              <ul>
                <li>
                  <a href={`/api/mc/admin/export/${bundle.manifestName}`}>{bundle.manifestName}</a>
                </li>
                {bundle.files.map((f) => (
                  <li key={f.name}>
                    <a href={`/api/mc/admin/export/${f.name}`}>{f.name}</a> ({f.rows} rows)
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
      <section className="panel" aria-label="Completion">
        <div className="panel-header">
          <span className="section-label">Completion (counts only)</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Slot</th>
                <th>Assigned</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {workspace.completion.map((r) => (
                <tr key={r.reviewerPseudoId}>
                  <td className="mono">{r.reviewerPseudoId}</td>
                  <td>{r.reviewerSlot}</td>
                  <td>{r.assigned}</td>
                  <td>{r.submitted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul>
          {workspace.events.map((e) => (
            <li key={e.eventType + e.occurredAt}>
              {readable(e.eventType)} at {e.occurredAt}
            </li>
          ))}
          {workspace.exports.map((e) => (
            <li key={e.exportId} className="mono">
              export {e.exportId} registered {e.createdAt}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel" aria-label="Condition list">
        <div className="panel-header">
          <span className="section-label">Proposed ten-condition list (approval pending)</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Figure row</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {workspace.conditions.map((cond) => (
                <tr key={cond.code}>
                  <td className="mono">{cond.code}</td>
                  <td>{cond.label}</td>
                  <td>{readable(cond.figureRow)}</td>
                  <td className="muted">{cond.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
