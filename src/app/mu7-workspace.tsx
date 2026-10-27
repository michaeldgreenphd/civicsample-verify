'use client';

import { MU81_SUBTYPE_TEXT, type Mu81Subtype } from '../lib/mu7-types';

// Review design v7 (mapping units). Reviewers answer one question per unit: is our displayed
// assignment right for this trial? The adjudicator breaks ties on routed units only, and the
// investigator runs the synthetic pilot. Every rule shown here is enforced again by the database,
// whose guard message is shown unchanged when it refuses. The formal review is not offered.
import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import {
  MU7_ANSWERS,
  MU7_ANSWER_TEXT,
  MU7_REASON_MEANING,
  type Mu7AdjudicationInput,
  type Mu7AdjudicatorUnit,
  type Mu7AdjudicatorWorkspace,
  type Mu7AdminAction,
  type Mu7Answer,
  type Mu7InvestigatorWorkspace,
  type Mu7Packet,
  type Mu7ReviewerUnit,
  type Mu7ReviewerWorkspace,
  type Mu7TrainingView,
  type Mu7Workspace,
} from '@/lib/mu7-types';
import type { Actor } from '@/lib/types';
import { Icon } from '@/components/icons';
import { PracticeSections, ReviewGuide } from './practice-sections';
import { FormalPreparation } from './formal-preparation';
import { FormalSampleIntake } from './formal-intake';
import { ProposedSamplePreview } from './sample-preview';
import { ReviewTarget } from './review-target';
import { nextUnansweredUnit } from '@/lib/mu7-review-navigation';
import {
  answerMeaning,
  reasonLabel,
  readableCode,
  studyLabel,
  unitDisplay,
} from '@/lib/mu7-display';
import styles from './practice-sections.module.css';

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
const readable = readableCode;
const answerLabel = (a: Mu7Answer | null) => (a ? MU7_ANSWER_TEXT[a].label : 'Not answered');
const exampleSummary = (text: string, profileId?: string | null) =>
  studyLabel(text).replace(/\b[A-Z][A-Z0-9_]*\b/g, (code) =>
    Object.hasOwn(MU7_REASON_MEANING, code)
      ? reasonLabel(code, profileId)
      : MU7_ANSWERS.includes(code as Mu7Answer)
        ? answerLabel(code as Mu7Answer)
        : code,
  );

const when = (iso: string) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '');

export function Mu7Panel({ user }: { user: Actor }) {
  const [workspace, setWorkspace] = useState<Mu7Workspace | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<Mu7Workspace>('/api/mu7/workspace');
    setWorkspace(next);
    return next;
  }, []);
  useEffect(() => {
    api<Mu7Workspace>('/api/mu7/workspace')
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
        Loading the mapping-unit review…
      </div>
    );
  if (workspace.kind === 'investigator')
    return (
      <PracticeSections
        reviewMode={workspace.design?.designVersion === 'review-design-v8.1.0'}
        workLabel={
          workspace.design?.designVersion === 'review-design-v8.1.0'
            ? 'Study preparation'
            : 'Practice setup'
        }
        description={
          workspace.design?.designVersion === 'review-design-v8.1.0'
            ? 'Inspect the recorded sample and guide. Clinical review remains closed.'
            : 'Manage the synthetic practice and return to the worked examples at any time.'
        }
        exampleCount={workspace.training.length}
        examples={
          <Training
            training={workspace.training}
            profileId={workspace.reviewerProfile?.profileId}
          />
        }
        guide={
          workspace.reviewerProfile?.guideText ? (
            <ReviewGuide text={workspace.reviewerProfile.guideText} />
          ) : undefined
        }
      >
        <Investigator workspace={workspace} onRefresh={refresh} />
      </PracticeSections>
    );
  if (workspace.kind === 'adjudicator')
    return (
      <Adjudicator
        workspace={workspace}
        selected={selected}
        onSelect={setSelected}
        onRefresh={refresh}
      />
    );
  return (
    <Reviewer
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
      <strong>Mapping units, synthetic pilot</strong>
      Each screen is one trial and one of our assignments, shown as stored. Synthetic units never
      enter any statistic. The formal review stays closed until the study decisions are specified
      and approved.
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The packet: trial evidence first, then the assignment being assessed.
// ---------------------------------------------------------------------------------------------
function Packet({
  packet,
  ids = false,
  profileId,
  titleRef,
}: {
  packet: Mu7Packet;
  ids?: boolean;
  profileId?: string | null;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const u = packet.unit;
  const t = packet.trial;
  const display = unitDisplay(u, profileId);
  const repeatsMembership =
    (u.family === 'AREA' && display.assertion === 'in this area') ||
    (u.family === 'ROW' && display.assertion === 'in this row');
  const tid = (name: string) => (ids ? name : undefined);
  return (
    <section className="panel" aria-label="Unit under review">
      <div className="panel-header">
        <span className="section-label">
          {u.unit_role === 'SUBGROUP' ? 'Inclusion or exclusion check' : 'Trial classification'}
        </span>
        <span className="muted mono" data-testid={tid('mu7-unit-id')}>
          {u.unit_id}
        </span>
      </div>
      <div className="panel-body">
        {packet.notices.map((n) => (
          <p key={n} className={styles.packetNotice} data-testid={tid('mu7-notice')}>
            {n
              .replace(/^SYNTHETIC UNIT:/, 'Synthetic unit ·')
              .replace(
                /^SYNTHETIC TRAINING EXAMPLE, READ ONLY:/,
                'Synthetic training example · Read only ·',
              )}
          </p>
        ))}
        <h3
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className={styles.trialTitle}
          data-testid={tid('mu7-brief-title')}
        >
          {t.brief_title}
        </h3>
        <p className="muted">
          <span className="mono">{t.nct_id}</span>
          {t.registry_url && (
            <>
              {' · '}
              <a href={t.registry_url} target="_blank" rel="noopener noreferrer">
                Registry record
              </a>
            </>
          )}
        </p>
        {t.official_title && <p className="muted">{t.official_title}</p>}
        <div className={styles.trialSummary}>
          <span className="form-label">Brief summary</span>
          <p data-testid={tid('mu7-brief-summary')}>
            {t.brief_summary || 'No brief summary registered.'}
          </p>
        </div>
        {t.detailed_description && (
          <details>
            <summary>Detailed description</summary>
            <p>{t.detailed_description}</p>
          </details>
        )}
        <dl className="metadata-list">
          <div>
            <dt>Conditions entered by the study team</dt>
            <dd>{t.conditions_registered?.join('; ') || 'None registered'}</dd>
          </div>
          <div>
            <dt>Standardized MeSH terms from ClinicalTrials.gov</dt>
            <dd>{t.condition_mesh_headings?.join('; ') || 'None'}</dd>
          </div>
          <div>
            <dt>Interventions</dt>
            <dd>
              {t.interventions?.length
                ? t.interventions
                    .map((i) => `${i.name} (${readable(i.intervention_type)})`)
                    .join('; ')
                : 'None registered'}
            </dd>
          </div>
          <div>
            <dt>Eligible ages</dt>
            <dd>
              {t.eligibility_age_range
                ? `${t.eligibility_age_range.minimum_age ?? 'N/A'} to ${t.eligibility_age_range.maximum_age ?? 'N/A'}`
                : 'Not registered'}
            </dd>
          </div>
        </dl>
        <p className="privacy-note">
          Registry text is shown as registered, even when it names another trial.
        </p>
        <div className={styles.assignmentSummary}>
          <p className={styles.assignmentTitle} data-testid={tid('mu7-mapping-label')}>
            <strong>{display.title}</strong>
            {display.context && <span className={styles.mappingContext}> {display.context}</span>}
          </p>
          {display.parent_row_label && (
            <p>
              Condition group: <strong>{display.parent_row_label}</strong>
            </p>
          )}
          {!repeatsMembership && (
            <p data-testid={tid('mu7-display-text')}>
              <span className={styles.assignmentLabel}>Our classification</span>
              <strong>{display.assertion}</strong>
            </p>
          )}
          {u.display_decision && (
            <p data-testid={tid('mu7-display-decision')}>
              <strong>{display.decision}</strong>
            </p>
          )}
          {u.family === 'SG' && (
            <p>
              <span className={styles.assignmentLabel}>Why it was classified this way</span>
              {display.basis}
            </p>
          )}
          {display.note && (
            <p className="form-hint" data-testid={tid('mu7-display-note')}>
              {display.note}
            </p>
          )}
          <div className={styles.reviewQuestion}>
            <span className={styles.assignmentLabel}>Your question</span>
            <p>{display.question}</p>
            {display.polarity && <p className="form-hint">{display.polarity}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Training({
  training,
  acknowledgedAt,
  onAcknowledge,
  profileId,
}: {
  training: Mu7TrainingView[];
  acknowledgedAt?: string | null;
  onAcknowledge?: () => void;
  profileId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = training.find((t) => t.trainingUnitId === selectedId) ?? training[0];
  if (!selected) return null;
  return (
    <section className={styles.examples} aria-label="Worked examples">
      <div className={styles.exampleChoices} role="group" aria-label="Choose a worked example">
        {training.map((t, index) => (
          <button
            key={t.trainingUnitId}
            type="button"
            aria-pressed={selected.trainingUnitId === t.trainingUnitId}
            onClick={() => setSelectedId(t.trainingUnitId)}
          >
            <span className={styles.exampleNumber}>Example {index + 1}</span>
            <strong>{studyLabel(t.packet.unit.mapping_label).replace(/ \(.*/, '')}</strong>
            <span className={styles.exampleId}>{t.trainingUnitId} · Read only</span>
          </button>
        ))}
      </div>
      <div className={styles.exampleBody}>
        <Packet packet={selected.packet} profileId={profileId} />
        <section className="panel" aria-label="Illustrative answers and outcome">
          <div className="panel-header">
            <span className="section-label">Illustrative answers</span>
          </div>
          <div className="panel-body">
            <p className="muted">
              {exampleSummary(selected.workedExample.outcome_summary, profileId)}
            </p>
            <div className="response-grid">
              {selected.workedExample.worked_answers.map((a) => (
                <div className="human-response" key={a.reviewer_slot}>
                  <h3>Reviewer {a.reviewer_slot}</h3>
                  <p>
                    <strong>{answerLabel(a.answer)}</strong>
                    {a.reason_code ? `, ${reasonLabel(a.reason_code, profileId)}` : ''}
                    {a.uncertain ? ' (uncertain)' : ''}
                  </p>
                  {a.note && <p className="muted">{a.note}</p>}
                </div>
              ))}
            </div>
            <div className={styles.outcome}>
              <h3>Recorded outcome in this example</h3>
              <p>
                <strong>Reference:</strong>{' '}
                {answerLabel(selected.workedExample.reference.final_answer)} (
                {readable(selected.workedExample.reference.status)})
              </p>
              {selected.workedExample.reference.rationale && (
                <p>{selected.workedExample.reference.rationale}</p>
              )}
              <p className="muted">{studyLabel(selected.workedExample.teaching_point)}</p>
            </div>
          </div>
        </section>
      </div>
      {acknowledgedAt !== undefined && (
        <div className={styles.acknowledgement}>
          <p data-testid="mu7-training-ack">
            {acknowledgedAt ? `Read ${when(acknowledgedAt)}` : 'Not yet marked as read'}
          </p>
          {onAcknowledge && !acknowledgedAt && (
            <button className="button secondary" onClick={onAcknowledge}>
              Mark the worked examples as read
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------------------------
type SavedReview = { assignmentId: string; queuePosition: number; advance: boolean };

function Reviewer({
  workspace,
  selected,
  onSelect,
  onRefresh,
  user,
}: {
  workspace: Mu7ReviewerWorkspace;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => Promise<Mu7Workspace>;
  user: Actor;
}) {
  const [detail, setDetail] = useState<Mu7ReviewerUnit | null>(null);
  const [subtype, setSubtype] = useState<Mu81Subtype | ''>('');
  const [answer, setAnswer] = useState<Mu7Answer | ''>('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [trainingError, setTrainingError] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [refreshNeeded, setRefreshNeeded] = useState<SavedReview | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const submitting = useRef(false);
  const focusAfterLoad = useRef<string | null>(null);
  const trialTitle = useRef<HTMLHeadingElement>(null);
  const caseContent = useRef<HTMLDivElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const load = useCallback((next: Mu7ReviewerUnit) => {
    // The form starts from your last answer on record (a resubmission is a revision).
    const last = next.ownAnswers.at(-1);
    setDetail(next);
    setAnswer(last?.answer ?? '');
    setSubtype(last?.diabetesSubtype ?? '');
    setReasonCode(last?.reasonCode ?? '');
    setNote(last?.note ?? '');
    setUncertain(last?.uncertain ?? false);
    setStarted(Date.now());
  }, []);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    const request = new AbortController();
    api<Mu7ReviewerUnit>(`/api/mu7/assignments/${selected}`, { signal: request.signal })
      .then((next) => {
        if (!current) return;
        load(next);
        setError('');
      })
      .catch((e) => {
        if (!current) return;
        setDetail(null);
        setError(e.message);
      });
    return () => {
      current = false;
      request.abort();
    };
  }, [selected, load, loadAttempt]);
  const shown = selected && detail?.assignmentId === selected ? detail : null;
  useEffect(() => {
    if (!shown || focusAfterLoad.current !== shown.assignmentId) return;
    focusAfterLoad.current = null;
    // The guide/examples may be open while a request completes. Do not move focus into a hidden tab.
    if (trialTitle.current?.getClientRects().length) {
      trialTitle.current.focus({ preventScroll: true });
      caseContent.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [shown]);
  useEffect(() => {
    if (error && errorNotice.current?.getClientRects().length) {
      errorNotice.current.focus({ preventScroll: true });
      caseContent.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [error]);
  const reviewMode = workspace.queue.some((q) => q.mode === 'FORMAL');
  const profileId = shown?.reviewerProfile?.profileId ?? workspace.reviewerProfile?.profileId;
  const primaryLeft = workspace.queue.filter((q) => q.unitRole === 'PRIMARY' && !q.answered).length;
  function selectCase(id: string | null) {
    if (submitting.current || id === selected) return;
    focusAfterLoad.current = null;
    setDetail(null);
    setSaved('');
    setSavedFor(null);
    setError('');
    setRefreshNeeded(null);
    onSelect(id);
  }
  async function refreshAfterSave(receipt: SavedReview) {
    try {
      const refreshed = await onRefresh();
      if (
        refreshed.kind !== 'reviewer' ||
        !refreshed.queue.some((q) => q.assignmentId === receipt.assignmentId && q.answered)
      )
        throw new Error('Saved answer is not yet reflected in the queue.');
      setRefreshNeeded(null);
      setError('');
      const next = nextUnansweredUnit(refreshed.queue, receipt.assignmentId);
      if (receipt.advance && next) {
        setSaved(
          `Case ${receipt.queuePosition} saved. Next: case ${next.queuePosition} of ${refreshed.queue.length}.`,
        );
        focusAfterLoad.current = next.assignmentId;
        onSelect(next.assignmentId);
      } else if (refreshed.queue.every((q) => q.answered)) {
        setSaved(
          refreshed.queue.length === 1
            ? 'Your answer is saved. You can return to revise it until review closes.'
            : `All ${refreshed.queue.length} answers are saved. You can return to revise them until review closes.`,
        );
      } else if (receipt.advance && !next) {
        setSaved('Answer saved. No other cases are available yet. You can return later.');
      }
    } catch {
      setRefreshNeeded(receipt);
      setError(
        'Your answer was saved, but progress could not be refreshed. Retry progress to continue; this will not submit your answer again.',
      );
    }
  }
  async function retryProgress() {
    if (!refreshNeeded || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await refreshAfterSave(refreshNeeded);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function submit(advance = false) {
    if (!shown || !answer || submitting.current || refreshNeeded) return;
    submitting.current = true;
    setBusy(true);
    setSaved('');
    setSavedFor(null);
    setError('');
    try {
      const next = await api<Mu7ReviewerUnit>(`/api/mu7/assignments/${shown.assignmentId}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          answer,
          ...(shown.subtypeRequired ? { diabetesSubtype: subtype } : {}),
          reasonCode: answer === 'DISAGREE' && reasonCode ? reasonCode : null,
          note: note.trim() || null,
          uncertain,
          secondsOnUnit: Math.max(0, Math.round((Date.now() - started) / 1000)),
        }),
      });
      if (next.assignmentId !== shown.assignmentId || !next.ownAnswers.length)
        throw new Error(
          'The server did not confirm this answer. Stay on this case and check its saved answer before trying again.',
        );
      // The POST receipt confirms persistence even if the following queue read fails.
      load(next);
      setSavedFor(shown.assignmentId);
      setSaved(next.ownAnswers.length > 1 ? 'Revision saved.' : 'Answer saved.');
      await refreshAfterSave({
        assignmentId: shown.assignmentId,
        queuePosition: shown.queuePosition,
        advance,
      });
    } catch (e) {
      setSaved('');
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function acknowledge() {
    setTrainingError('');
    try {
      await api('/api/mu7/training/acknowledge', { method: 'POST', body: '{}' });
      await onRefresh();
    } catch (e) {
      setTrainingError((e as Error).message);
    }
  }
  const last = shown?.ownAnswers.at(-1);
  const hasMore =
    shown && workspace.queue.some((q) => q.assignmentId !== shown.assignmentId && !q.answered);
  return (
    <PracticeSections
      workLabel={reviewMode ? 'Review cases' : 'Practice cases'}
      reviewMode={reviewMode}
      guide={
        workspace.reviewerProfile?.guideText ? (
          <ReviewGuide text={workspace.reviewerProfile.guideText} />
        ) : undefined
      }
      description="Read the trial evidence, choose an answer, then save it. Consult the worked examples whenever you need them."
      exampleCount={workspace.training.length}
      progress={{
        answered: workspace.queue.filter((q) => q.answered).length,
        total: workspace.queue.length,
      }}
      examples={
        <>
          {trainingError && (
            <div className="notice error" role="alert">
              {trainingError}
            </div>
          )}
          <Training
            training={workspace.training}
            profileId={workspace.reviewerProfile?.profileId}
            acknowledgedAt={workspace.trainingAcknowledgedAt}
            onAcknowledge={workspace.enrolled ? acknowledge : undefined}
          />
        </>
      }
    >
      <div className="workspace-grid">
        <aside className={`panel ${styles.reviewQueue}`} aria-label="Unit queue">
          <div className="panel-header">
            <span className="section-label">Your units</span>
            <span className="muted">{user.displayName}</span>
          </div>
          <label className={styles.mobilePicker}>
            Choose a {reviewMode ? 'review' : 'practice'} case
            <select
              disabled={busy}
              value={selected ?? ''}
              onChange={(e) => selectCase(e.target.value || null)}
            >
              <option value="">Select a case</option>
              {workspace.queue.map((q) => (
                <option key={q.assignmentId} value={q.assignmentId} disabled={!q.available}>
                  {q.queuePosition}. {q.unitId} ·{' '}
                  {q.answered ? 'Answered' : q.available ? 'Open' : 'Opens later'}
                </option>
              ))}
            </select>
          </label>
          <ul className="queue-list">
            {workspace.queue.map((q) => (
              <li key={q.assignmentId}>
                <button
                  className={`queue-item${selected === q.assignmentId ? ' selected' : ''}`}
                  aria-current={selected === q.assignmentId ? 'true' : undefined}
                  onClick={() => selectCase(q.assignmentId)}
                  disabled={busy || !q.available}
                  aria-label={`Unit ${q.queuePosition}: ${q.unitId}`}
                >
                  <span className="queue-icon">
                    <Icon name={q.answered ? 'check' : q.available ? 'file' : 'lock'} size={13} />
                  </span>
                  <span className="queue-copy">
                    <strong className="mono">
                      {q.queuePosition}. {q.unitId}
                    </strong>
                    <span className="queue-meta">
                      <span>
                        {q.unitRole === 'SUBGROUP'
                          ? 'Inclusion or exclusion check'
                          : 'Classification'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className={`status ${q.answered ? 'complete' : ''}`}>
                        {q.answered ? 'Answered' : q.available ? 'Open' : 'Opens later'}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!workspace.queue.length && <li className="muted">No units are assigned to you.</li>}
          </ul>
          <p className="privacy-note">
            {workspace.queue.length > 0 &&
              (primaryLeft > 0
                ? `Inclusion and exclusion checks open after your ${primaryLeft} remaining classification answers. `
                : 'Every classification is answered; inclusion and exclusion checks are open. ')}
            You never see another reviewer’s answer.
          </p>
        </aside>
        <div ref={caseContent} className={styles.reviewContent}>
          <p className={styles.reviewSaveStatus} role="status" aria-atomic="true">
            {saved}
          </p>
          {error && (
            <div ref={errorNotice} tabIndex={-1} className="notice error" role="alert">
              <p>{error}</p>
              {refreshNeeded && (
                <button className="button secondary" disabled={busy} onClick={retryProgress}>
                  {busy ? 'Refreshing progress…' : 'Retry progress'}
                </button>
              )}
            </div>
          )}
          {shown ? (
            <>
              <Packet packet={shown.packet} ids profileId={profileId} titleRef={trialTitle} />
              <section className="panel" aria-label="Your answer">
                <div className="panel-header">
                  <span className="section-label">Your answer</span>
                </div>
                <div className="panel-body">
                  {last && (
                    <p className="notice" data-testid="mu7-own-answer">
                      <strong>Your answer on record:</strong> {answerLabel(last.answer)}
                      {last.reasonCode ? `, ${reasonLabel(last.reasonCode, profileId)}` : ''}
                      {last.uncertain ? ' (uncertain)' : ''}, saved {when(last.submittedAt)}.
                      {shown.ownAnswers.length > 1
                        ? ` Revision ${last.revisionNumber}; your first answer (${answerLabel(shown.ownAnswers[0].answer)}) is kept as well.`
                        : ' You can revise it until the review closes.'}
                      {last.diabetesSubtype && (
                        <span className={styles.recordedSubtype}>
                          Registry stated-type answer: {MU81_SUBTYPE_TEXT[last.diabetesSubtype]}.
                        </span>
                      )}
                    </p>
                  )}
                  <ReviewTarget
                    unit={shown.packet.unit}
                    profileId={profileId}
                    id="mu7-review-target"
                  />
                  <fieldset
                    className={styles.answerControls}
                    disabled={busy || !!refreshNeeded}
                    aria-label="Record your answer"
                  >
                    <div
                      className="decision-list"
                      role="radiogroup"
                      aria-label="Answer"
                      aria-describedby="mu7-review-target"
                    >
                      {MU7_ANSWERS.map((a) => (
                        <label
                          key={a}
                          aria-label={MU7_ANSWER_TEXT[a].label}
                          className={`decision-option${answer === a ? ' chosen' : ''}`}
                        >
                          <input
                            type="radio"
                            name="mu7-answer"
                            value={a}
                            checked={answer === a}
                            onChange={() => setAnswer(a)}
                          />
                          <span>
                            <strong>{MU7_ANSWER_TEXT[a].label}</strong>
                            <small>{answerMeaning(a, profileId)}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    {answer === 'DISAGREE' && (
                      <label className="field">
                        <span className="form-label">Reason (required)</span>
                        <select
                          aria-describedby="mu7-reviewer-reason-help"
                          value={reasonCode}
                          onChange={(e) => setReasonCode(e.target.value)}
                        >
                          <option value="">Choose the reason that fits best</option>
                          {shown.reasonCodes.map((r) => (
                            <option key={r.code} value={r.code}>
                              {reasonLabel(r.code, profileId)}
                            </option>
                          ))}
                        </select>
                        <span className="form-hint" id="mu7-reviewer-reason-help">
                          {shown.reasonCodes.find((r) => r.code === reasonCode)?.meaning}
                        </span>
                      </label>
                    )}
                    {shown.subtypeRequired && (
                      <fieldset className="field">
                        <legend className="form-label">
                          Does the registry text state that the trial studies type 2 diabetes?
                          (required)
                        </legend>
                        <p className="form-hint">
                          This records what the packet states, separately from your membership
                          answer. It is not adjudicated.
                        </p>
                        {(Object.entries(MU81_SUBTYPE_TEXT) as [Mu81Subtype, string][]).map(
                          ([value, label]) => (
                            <label className="checkbox-row" key={value}>
                              <input
                                type="radio"
                                name="diabetes-subtype"
                                value={value}
                                checked={subtype === value}
                                onChange={() => setSubtype(value)}
                              />
                              <span>{label}</span>
                            </label>
                          ),
                        )}
                      </fieldset>
                    )}
                    <label className="field">
                      <span className="form-label">
                        Note {answer === 'DISAGREE' ? '(required)' : '(optional)'}
                      </span>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        maxLength={2000}
                      />
                      <span className="form-hint">
                        A short note helps the adjudicator when the two answers differ.
                      </span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={uncertain}
                        onChange={(e) => setUncertain(e.target.checked)}
                      />
                      <span>I am answering, but I am not sure.</span>
                    </label>
                    <div className={styles.saveActions}>
                      {hasMore && (
                        <button
                          className="button"
                          disabled={!answer || busy || (shown.subtypeRequired && !subtype)}
                          onClick={() => submit(true)}
                        >
                          {busy ? (refreshNeeded ? 'Refreshing…' : 'Saving…') : 'Save and next'}
                        </button>
                      )}
                      <button
                        className={`button${hasMore ? ' secondary' : ''}`}
                        disabled={!answer || busy || (shown.subtypeRequired && !subtype)}
                        onClick={() => submit()}
                      >
                        {busy && !hasMore
                          ? refreshNeeded
                            ? 'Refreshing…'
                            : 'Saving…'
                          : last
                            ? 'Save revision'
                            : 'Save answer'}
                      </button>
                      {hasMore && (
                        <p className={styles.saveHint}>
                          {last ? 'Save revision' : 'Save answer'} keeps this case open.
                        </p>
                      )}
                      {saved && savedFor === shown.assignmentId && (
                        <p className={styles.savedInline} aria-hidden="true">
                          {saved}
                        </p>
                      )}
                    </div>
                  </fieldset>
                </div>
              </section>
            </>
          ) : (
            <div className="panel empty-state" aria-busy={!!selected && !error}>
              {selected ? (
                error ? (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setError('');
                      focusAfterLoad.current = selected;
                      setLoadAttempt((n) => n + 1);
                    }}
                  >
                    Retry loading case
                  </button>
                ) : (
                  'Loading case…'
                )
              ) : workspace.queue.length ? (
                'Select a unit from your queue.'
              ) : (
                'Nothing is assigned to you yet.'
              )}
            </div>
          )}
        </div>
      </div>
    </PracticeSections>
  );
}

// ---------------------------------------------------------------------------------------------
// Adjudicator: routed units only
// ---------------------------------------------------------------------------------------------
type AdjForm = Omit<Mu7AdjudicationInput, 'unitId'>;
const EMPTY_ADJ: AdjForm = {
  status: 'DISCORDANT_RESOLVED',
  decision: null,
  basis: 'NONE',
  reasonCode: null,
  disagreementReasonCode: null,
  rationale: '',
};
function Adjudicator({
  workspace,
  selected,
  onSelect,
  onRefresh,
}: {
  workspace: Mu7AdjudicatorWorkspace;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => Promise<Mu7Workspace>;
}) {
  const [detail, setDetail] = useState<Mu7AdjudicatorUnit | null>(null);
  const [form, setForm] = useState<AdjForm>(EMPTY_ADJ);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    api<Mu7AdjudicatorUnit>(`/api/mu7/adjudication/${selected}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (controller.signal.aborted) return;
        // Each unit starts from an empty form: nothing typed for another unit can be recorded
        // as this unit's immutable tie-break.
        setDetail(next);
        setForm(EMPTY_ADJ);
        setError('');
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setError(e.message);
      });
    return () => controller.abort();
  }, [selected]);
  const shown = selected && detail?.unitId === selected ? detail : null;
  const profileId = shown?.reviewerProfile?.profileId ?? workspace.reviewerProfile?.profileId;
  // The basis names the reviewer whose answer the decision adopts (the database checks it).
  const suggestedBasis = (decision: 'AGREE' | 'DISAGREE'): AdjForm['basis'] => {
    if (!shown) return 'NEITHER';
    const match = shown.answers.find((a) => a.answer === decision);
    return match ? (match.reviewerSlot === 1 ? 'REVIEWER_1' : 'REVIEWER_2') : 'NEITHER';
  };
  const validResolvedDecision =
    !!form.decision &&
    (form.basis === 'NEITHER' ||
      shown?.answers.some(
        (answer) =>
          `REVIEWER_${answer.reviewerSlot}` === form.basis && answer.answer === form.decision,
      )) &&
    (form.decision !== 'DISAGREE' ||
      shown?.reasonCodes.some((reason) => reason.code === form.reasonCode));
  const readyToRecord =
    !!shown &&
    !shown.referenceLocked &&
    !shown.adjudication &&
    form.rationale.trim().length >= 3 &&
    (form.status === 'UNRESOLVED_ESCALATED' || validResolvedDecision);
  async function decide() {
    if (!shown || busy || !readyToRecord) return;
    const resolved = form.status === 'DISCORDANT_RESOLVED';
    setBusy(true);
    try {
      const next = await api<Mu7AdjudicatorUnit>('/api/mu7/adjudicate', {
        method: 'POST',
        body: JSON.stringify({
          unitId: shown.unitId,
          status: form.status,
          decision: resolved ? form.decision : null,
          basis: resolved ? form.basis : 'NONE',
          reasonCode: resolved && form.decision === 'DISAGREE' ? form.reasonCode : null,
          disagreementReasonCode: form.disagreementReasonCode || null,
          rationale: form.rationale,
        }),
      });
      await onRefresh();
      setDetail(next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PracticeSections
      workLabel="Adjudication"
      reviewMode={workspace.queue.some((q) => q.mode === 'FORMAL')}
      description="Resolve the cases routed to you. The worked examples explain how illustrative disagreements are recorded."
      exampleCount={workspace.training.length}
      examples={
        <Training training={workspace.training} profileId={workspace.reviewerProfile?.profileId} />
      }
      guide={
        workspace.reviewerProfile?.guideText ? (
          <ReviewGuide text={workspace.reviewerProfile.guideText} />
        ) : undefined
      }
    >
      <div className="workspace-grid">
        <aside className="panel" aria-label="Adjudication queue">
          <div className="panel-header">
            <span className="section-label">Routed units</span>
            <span className="muted">Tie-breaker only</span>
          </div>
          <ul className="queue-list">
            {workspace.queue.map((q) => (
              <li key={q.unitId}>
                <button
                  className={`queue-item${selected === q.unitId ? ' selected' : ''}`}
                  aria-current={selected === q.unitId ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => onSelect(q.unitId)}
                >
                  <span className="queue-icon">
                    <Icon name={q.adjudicated ? 'check' : 'file'} size={13} />
                  </span>
                  <span className="queue-copy">
                    <strong className="mono">{q.unitId}</strong>
                    <span className="queue-meta">
                      <span>{studyLabel(q.mappingLabel).replace(/ \(.*/, '')}</span>
                      <span aria-hidden="true">·</span>
                      <span className={`status ${q.adjudicated ? 'complete' : 'draft'}`}>
                        {q.adjudicated ? 'Decided' : 'Needs a decision'}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!workspace.queue.length && (
              <li className="muted">
                Nothing to decide. A unit arrives here when one reviewer agrees and the other
                disagrees, or exactly one cannot tell.
              </li>
            )}
          </ul>
        </aside>
        <div>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {shown ? (
            <>
              <Packet packet={shown.packet} ids profileId={profileId} />
              <section className="panel" aria-label="Reviewer answers">
                <div className="panel-header">
                  <span className="section-label">Both effective answers</span>
                </div>
                <div className="panel-body">
                  <div className="response-grid">
                    {shown.answers.map((a) => (
                      <div
                        className="human-response"
                        key={a.reviewerSlot}
                        data-testid={`mu7-slot-${a.reviewerSlot}`}
                      >
                        <h3>Reviewer {a.reviewerSlot}</h3>
                        <p>
                          <strong>{answerLabel(a.answer)}</strong>
                          {a.reasonCode ? `, ${reasonLabel(a.reasonCode, profileId)}` : ''}
                          {a.uncertain ? ' (uncertain)' : ''}
                        </p>
                        {a.note && <p className="muted">{a.note}</p>}
                      </div>
                    ))}
                  </div>
                  {shown.adjudication ? (
                    <div className="notice" data-testid="mu7-adjudication">
                      <strong>
                        {shown.adjudication.status === 'UNRESOLVED_ESCALATED'
                          ? 'Marked unresolved'
                          : `Resolved: ${answerLabel(shown.adjudication.decision)}, ${
                              shown.adjudication.basis === 'NEITHER'
                                ? 'adopting neither answer'
                                : `adopting ${readable(shown.adjudication.basis)}`
                            }`}
                      </strong>
                      {shown.adjudication.rationale}
                    </div>
                  ) : shown.referenceLocked ? (
                    <p className="muted">The reference is locked.</p>
                  ) : (
                    <>
                      <ReviewTarget
                        unit={shown.packet.unit}
                        profileId={profileId}
                        id="mu7-adjudication-target"
                      />
                      <div
                        className="decision-list"
                        role="radiogroup"
                        aria-label="Outcome"
                        aria-describedby="mu7-adjudication-target"
                      >
                        <label
                          aria-label="Resolve"
                          className={`decision-option${form.status === 'DISCORDANT_RESOLVED' ? ' chosen' : ''}`}
                        >
                          <input
                            type="radio"
                            name="mu7-status"
                            checked={form.status === 'DISCORDANT_RESOLVED'}
                            onChange={() =>
                              setForm({
                                ...form,
                                status: 'DISCORDANT_RESOLVED',
                                basis: form.decision ? suggestedBasis(form.decision) : 'NONE',
                              })
                            }
                          />
                          <span>
                            <strong>Resolve</strong>
                            <small>
                              Record Agree or Disagree and the reviewer whose answer you adopt.
                            </small>
                          </span>
                        </label>
                        <label
                          aria-label="Mark unresolved"
                          className={`decision-option${form.status === 'UNRESOLVED_ESCALATED' ? ' chosen' : ''}`}
                        >
                          <input
                            type="radio"
                            name="mu7-status"
                            checked={form.status === 'UNRESOLVED_ESCALATED'}
                            onChange={() => setForm({ ...form, status: 'UNRESOLVED_ESCALATED' })}
                          />
                          <span>
                            <strong>Mark unresolved</strong>
                            <small>The registry does not settle it; no decision is recorded.</small>
                          </span>
                        </label>
                      </div>
                      {form.status === 'DISCORDANT_RESOLVED' && (
                        <>
                          <label className="field">
                            <span className="form-label">Decision</span>
                            <select
                              aria-describedby="mu7-adjudication-target"
                              value={form.decision ?? ''}
                              onChange={(e) => {
                                const decision = e.target.value as '' | 'AGREE' | 'DISAGREE';
                                setForm({
                                  ...form,
                                  decision: decision || null,
                                  basis: decision ? suggestedBasis(decision) : 'NONE',
                                  reasonCode: null,
                                });
                              }}
                            >
                              <option value="">Choose your decision</option>
                              <option value="AGREE">Agree: our assignment is right</option>
                              <option value="DISAGREE">
                                Disagree: our assignment is not right
                              </option>
                            </select>
                          </label>
                          {form.decision === 'DISAGREE' && (
                            <label className="field">
                              <span className="form-label">Reason</span>
                              <select
                                aria-describedby="mu7-adjudicator-reason-help"
                                value={form.reasonCode ?? ''}
                                onChange={(e) =>
                                  setForm({ ...form, reasonCode: e.target.value || null })
                                }
                              >
                                <option value="">Choose the reason that fits best</option>
                                {shown.reasonCodes.map((r) => (
                                  <option key={r.code} value={r.code}>
                                    {reasonLabel(r.code, profileId)}
                                  </option>
                                ))}
                              </select>
                              <span className="form-hint" id="mu7-adjudicator-reason-help">
                                {shown.reasonCodes.find((r) => r.code === form.reasonCode)?.meaning}
                              </span>
                            </label>
                          )}
                          <label className="field">
                            <span className="form-label">Basis</span>
                            <select
                              value={form.basis === 'NONE' ? '' : form.basis}
                              disabled={!form.decision}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  basis: (e.target.value || 'NONE') as AdjForm['basis'],
                                })
                              }
                            >
                              <option value="">Choose a decision first</option>
                              {shown.answers
                                .filter((answer) => answer.answer === form.decision)
                                .map((answer) => (
                                  <option
                                    key={answer.reviewerSlot}
                                    value={`REVIEWER_${answer.reviewerSlot}`}
                                  >
                                    Reviewer {answer.reviewerSlot}
                                  </option>
                                ))}
                              <option value="NEITHER">Neither</option>
                            </select>
                          </label>
                        </>
                      )}
                      <label className="field">
                        <span className="form-label">Why the reviewers differed (optional)</span>
                        <select
                          value={form.disagreementReasonCode ?? ''}
                          onChange={(e) =>
                            setForm({ ...form, disagreementReasonCode: e.target.value || null })
                          }
                        >
                          <option value="">Not recorded</option>
                          {shown.disagreementReasons.map((r) => (
                            <option key={r} value={r}>
                              {readable(r)}
                            </option>
                          ))}
                        </select>
                      </label>
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
                          disabled={busy || !readyToRecord}
                          onClick={decide}
                        >
                          Record the tie-break
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="panel empty-state">Select a routed unit.</div>
          )}
        </div>
      </div>
    </PracticeSections>
  );
}

// ---------------------------------------------------------------------------------------------
// Investigator: the synthetic pilot, step by step
// ---------------------------------------------------------------------------------------------
interface BundleSummary {
  mode: 'PILOT' | 'FORMAL';
  manifest: Record<string, unknown>;
  manifestSha256: string;
  files: { name: string; role: string; rows: number; sha256: string }[];
}
function Investigator({
  workspace,
  onRefresh,
}: {
  workspace: Mu7InvestigatorWorkspace;
  onRefresh: () => Promise<Mu7Workspace>;
}) {
  const [error, setError] = useState('');
  const [attestation, setAttestation] = useState('');
  const [bundle, setBundle] = useState<BundleSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockReason, setLockReason] = useState('');
  const [gateAttestation, setGateAttestation] = useState<Record<string, string>>({});
  async function act(input: Mu7AdminAction) {
    setBusy(true);
    try {
      await api('/api/mu7/admin/action', { method: 'POST', body: JSON.stringify(input) });
      setError('');
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const w = workspace;
  const formalPreparation = w.design?.designVersion === 'review-design-v8.1.0';
  const attested = attestation.trim().length >= 20;
  const registered =
    bundle !== null && w.exports.some((x) => x.manifestSha256 === bundle.manifestSha256);
  const routed = w.pilotRouting.filter((r) => r.routing === 'ROUTED');
  const AttestationField = (
    <label className="field">
      <span className="form-label">Attestation</span>
      <input
        value={attestation}
        onChange={(e) => setAttestation(e.target.value)}
        maxLength={2000}
        placeholder="At least 20 characters"
      />
      <span className="form-hint">
        One sentence in your own words on why you are taking this step. It is stored with the record
        as your signature.
      </span>
    </label>
  );
  return (
    <div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!formalPreparation && <Banner />}
      <FormalPreparation workspace={w} />
      <FormalSampleIntake onRecorded={onRefresh} />
      <ProposedSamplePreview
        renderPacket={(packet, profileId) => <Packet packet={packet} profileId={profileId} />}
      />
      {!formalPreparation && (
        <section className="panel" aria-label="Synthetic pilot">
          <div className="panel-header">
            <span className="section-label">Synthetic pilot</span>
            <span className="header-phase" data-testid="mu7-phase">
              {w.pilotLock
                ? `Pilot locked (${w.pilotLock.nUnitsLocked} units)`
                : w.design
                  ? 'Pilot open'
                  : 'No design recorded'}
            </span>
          </div>
          <div className="panel-body">
            <div className="stat-strip">
              <div className="stat">
                <span className="stat-value">{w.counts.pilotUnits}</span>
                <span className="stat-label">Synthetic pilot units</span>
              </div>
              <div className="stat">
                <span className="stat-value">{w.counts.trainingUnits}</span>
                <span className="stat-label">Worked examples, outside every total</span>
              </div>
              <div className="stat">
                <span className="stat-value">{w.counts.pilotQueue}</span>
                <span className="stat-label">Pilot assignments</span>
              </div>
              <div className="stat">
                <span className="stat-value">{w.counts.formalUnits}</span>
                <span className="stat-label">Formal units</span>
              </div>
            </div>
            {!w.design && (
              <div className="step">
                <h3>Record the design</h3>
                <p>
                  Records a synthetic local design ({'SYN-7-SYNTHETIC-PILOT'}). The study’s own
                  design values wait for the investigator’s decisions.
                </p>
                {AttestationField}
                <div className="button-row">
                  <button
                    className="button"
                    disabled={busy || !attested}
                    onClick={() => act({ action: 'record-design', attestation })}
                  >
                    Record the synthetic design
                  </button>
                  {w.canCreateProfilePilot && (
                    <button
                      className="button secondary"
                      disabled={busy || !attested}
                      onClick={() => act({ action: 'record-profile-design', attestation })}
                    >
                      Start practice with the revised guide
                    </button>
                  )}
                </div>
              </div>
            )}
            {w.design && !w.pilotLock && (
              <div className="step">
                <h3>Prepare the pilot</h3>
                <p>
                  Import the 12 synthetic units and the three synthetic worked examples, then assign
                  every unit to both pilot reviewers: primary units first, subgroup units last.
                </p>
                <div className="toolbar">
                  <button
                    className="button secondary"
                    disabled={busy || w.counts.pilotUnits > 0}
                    onClick={() => act({ action: 'import-pilot' })}
                  >
                    {w.counts.pilotUnits
                      ? 'Pilot units imported'
                      : 'Import the synthetic pilot units'}
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || w.counts.trainingUnits > 0}
                    onClick={() => act({ action: 'import-training' })}
                  >
                    {w.counts.trainingUnits
                      ? 'Worked examples imported'
                      : 'Import the worked examples'}
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || w.counts.pilotUnits === 0 || w.counts.pilotQueue > 0}
                    onClick={() => act({ action: 'assign-pilot' })}
                  >
                    {w.counts.pilotQueue ? 'Both queues assigned' : 'Assign both pilot queues'}
                  </button>
                </div>
              </div>
            )}
            {w.design && !w.pilotLock && w.counts.pilotQueue > 0 && (
              <div className="step">
                <h3>Lock the pilot reference</h3>
                <p>
                  Possible once both reviewers have answered every unit and every routed unit has
                  its tie-break. The lock fixes the pilot inventory; nothing can be added or
                  answered afterwards.
                </p>
                {AttestationField}
                <div className="button-row">
                  <button
                    className="button"
                    disabled={busy || !attested}
                    onClick={() => act({ action: 'lock-pilot', attestation })}
                  >
                    Lock the pilot reference
                  </button>
                </div>
              </div>
            )}
            {w.pilotLock && (
              <div className="step">
                <h3>Export the locked pilot</h3>
                <p>
                  Build the locked pilot bundle, check its manifest, then register its hashes. The
                  bundle is marked synthetic; the analysis reads formal bundles only.
                </p>
                <div className="button-row">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      api<BundleSummary>('/api/mu7/admin/export/PILOT')
                        .then((b) => {
                          setBundle(b);
                          setError('');
                        })
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Build export
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || bundle === null || registered}
                    onClick={() => act({ action: 'register-pilot-export' })}
                  >
                    {registered ? 'Export registered' : 'Register export'}
                  </button>
                </div>
              </div>
            )}
            {bundle && (
              <div className="notice" data-testid="mu7-bundle">
                <strong>
                  Bundle {String(bundle.manifest.bundle_format_version)}, {readable(bundle.mode)}{' '}
                  mode
                </strong>
                {String(bundle.manifest.status)}. Manifest{' '}
                <span className="mono">{bundle.manifestSha256.slice(0, 12)}…</span>
                <ul>
                  <li>
                    <a href="/api/mu7/admin/export/PILOT/manifest.json">manifest.json</a>
                  </li>
                  {bundle.files.map((f) => (
                    <li key={f.name}>
                      <a href={`/api/mu7/admin/export/PILOT/${f.name}`}>{f.name}</a> ({f.rows} rows)
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel" aria-label="Progress">
        <div className="panel-header">
          <span className="section-label">Progress (counts only)</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Reviewer slot</th>
                <th>Assigned</th>
                <th>Answered</th>
              </tr>
            </thead>
            <tbody>
              {w.completion.map((r) => (
                <tr key={r.reviewerSlot}>
                  <td>{r.reviewerSlot}</td>
                  <td>{r.assigned}</td>
                  <td>{r.answered}</td>
                </tr>
              ))}
              {!w.completion.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    {formalPreparation ? 'No reviewers assigned.' : 'No pilot queue yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {w.pilotRouting.length > 0 && (
        <section className="panel" aria-label="Synthetic routing check">
          <div className="panel-header">
            <span className="section-label">
              Synthetic routing check (not a performance result)
            </span>
            <span className="muted">{routed.length} routed</span>
          </div>
          <div className="table-scroll">
            <table data-testid="mu7-routing">
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Routing</th>
                  <th>Expected</th>
                  <th>Final</th>
                </tr>
              </thead>
              <tbody>
                {w.pilotRouting.map((r) => (
                  <tr key={r.unitId}>
                    <td className="mono">{r.unitId}</td>
                    <td>{readable(r.routing)}</td>
                    <td>
                      {r.expectedRouting ? readable(r.expectedRouting) : ''}{' '}
                      {r.matches === null ? '' : r.matches ? '✓' : '✗'}
                    </td>
                    <td>
                      {readable(r.finalStatus)}
                      {r.finalAnswer ? ` (${answerLabel(r.finalAnswer)})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" aria-label="Study decisions">
        <div className="panel-header">
          <span className="section-label">Study decisions before the formal review</span>
          <span className="badge amber">Formal review disabled</span>
        </div>
        <div className="panel-body">
          <p>{w.formalDisabledReason}</p>
          <ul className="gate-list">
            {w.gates.map((g) => (
              <li key={g.gateId}>
                <span>
                  <strong className="mono">{g.gateId}</strong> {g.question}
                  {g.blocks.length > 0 && (
                    <span className="muted" style={{ display: 'block' }}>
                      Holds{' '}
                      {g.blocks
                        .map((b) => (b === 'FREEZE' ? 'the freeze' : 'the formal opening'))
                        .join(' and ')}
                    </span>
                  )}
                  {g.decisionReference && (
                    <span
                      className="muted"
                      style={{ display: 'block' }}
                      data-testid={`gate-record-${g.gateId}`}
                    >
                      Decision record: {g.decisionReference}
                    </span>
                  )}
                  {g.satisfied && g.approvedAt && (
                    <span className="muted" style={{ display: 'block' }}>
                      Approved {when(g.approvedAt)}, citing the record above.
                    </span>
                  )}
                  {g.requirementStatus === 'SPECIFIED' && !g.satisfied && (
                    <span className="gate-approval" style={{ display: 'block', marginTop: 12 }}>
                      <label className="field">
                        <span className="form-label">
                          Your approval as investigator ({g.gateId})
                        </span>
                        <input
                          value={gateAttestation[g.gateId] ?? ''}
                          onChange={(e) =>
                            setGateAttestation({ ...gateAttestation, [g.gateId]: e.target.value })
                          }
                          maxLength={2000}
                          placeholder="At least 20 characters"
                        />
                        <span className="form-hint">
                          The approval cites the decision record above and is stored with your
                          attestation. It cannot be withdrawn or replaced. It does not open the
                          formal review while other gates are pending.
                        </span>
                      </label>
                      <button
                        className="button secondary"
                        disabled={busy || (gateAttestation[g.gateId] ?? '').trim().length < 20}
                        onClick={() =>
                          act({
                            action: 'approve-gate',
                            gateId: g.gateId,
                            attestation: gateAttestation[g.gateId] ?? '',
                          })
                        }
                      >
                        Approve {g.gateId}
                      </button>
                    </span>
                  )}
                </span>
                <span className="status">
                  {g.satisfied
                    ? 'Approved'
                    : g.requirementStatus === 'SPECIFIED'
                      ? 'Ready for approval'
                      : readable(g.requirementStatus)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {w.localTools && (
        <section className="panel" aria-label="Local account tools">
          <div className="panel-header">
            <span className="section-label">Account lock (local synthetic database only)</span>
          </div>
          <div className="panel-body">
            <p className="muted">
              The local stand-in for the privileged identity tool. A locked account is refused at
              once by every database check and its sessions end; releasing the lock lets it sign in
              again.
            </p>
            <label className="field">
              <span className="form-label">Reason</span>
              <input
                value={lockReason}
                onChange={(e) => setLockReason(e.target.value)}
                maxLength={400}
              />
            </label>
            <div className="toolbar">
              {(['reviewer-a', 'reviewer-b', 'adjudicator'] as const).map((account) => (
                <span key={account} className="button-row">
                  <button
                    className="button secondary"
                    disabled={busy || lockReason.trim().length < 3}
                    onClick={() => act({ action: 'lock-account', account, reason: lockReason })}
                  >
                    Lock {account}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => act({ action: 'unlock-account', account })}
                  >
                    Release {account}
                  </button>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {(w.phaseEvents.length > 0 || w.exports.length > 0) && (
        <section className="panel" aria-label="Records">
          <div className="panel-header">
            <span className="section-label">Records</span>
          </div>
          <div className="panel-body">
            <ul>
              {w.phaseEvents.map((e) => (
                <li key={e.eventType + e.occurredAt}>
                  {readable(e.eventType)}, {when(e.occurredAt)}
                </li>
              ))}
              {w.exports.map((e) => (
                <li key={e.exportId} className="mono" data-testid="mu7-export-record">
                  {e.mode} export {e.exportId}, manifest {e.manifestSha256.slice(0, 12)}…, build{' '}
                  {e.appGitSha.slice(0, 7)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
