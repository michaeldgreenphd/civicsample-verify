'use client';

// Design v5 workspace: trial-level verification of the analysis labels (reviewer form with 19
// items, the training view, the adjudicator queue and the investigator console). Every rule the
// screens express is enforced again by the database; the screens never widen access.
import { useCallback, useEffect, useState } from 'react';
import {
  ANSWER_LABELS,
  AREA_ITEMS,
  DETAIL_CODES,
  ROW_ITEMS,
  SCALES,
  SG_ITEMS,
  SG_ROW,
  ADJUDICATION_BASES,
  ADJUDICATION_STATUSES,
  DISAGREEMENT_REASONS,
  itemFamily,
  itemQuestion,
} from '@/lib/tlv5-codes';
import type {
  Tlv5AdjudicatorCaseDetail,
  Tlv5AdjudicatorWorkspace,
  Tlv5AdminAction,
  Tlv5Bundle,
  Tlv5InvestigatorWorkspace,
  Tlv5ItemInput,
  Tlv5Mode,
  Tlv5QueueItem,
  Tlv5QueueRow,
  Tlv5ReviewerCase,
  Tlv5ReviewerWorkspace,
  Tlv5TrialPacket,
  Tlv5Workspace,
} from '@/lib/tlv5-types';
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
const MODE_LABEL: Record<Tlv5Mode, string> = {
  PILOT: 'Synthetic pilot',
  CALIBRATION: 'Rubric calibration',
  TRAINING: 'Training example',
  FORMAL: 'Formal',
};

export function Tlv5Panel({ user }: { user: Actor }) {
  const [workspace, setWorkspace] = useState<Tlv5Workspace | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<Tlv5Workspace>('/api/tlv5/workspace');
    setWorkspace(next);
    return next;
  }, []);
  useEffect(() => {
    api<Tlv5Workspace>('/api/tlv5/workspace')
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
        Loading the trial verification workspace…
      </div>
    );
  if (workspace.kind === 'investigator')
    return <Tlv5Investigator workspace={workspace} onRefresh={refresh} />;
  if (workspace.kind === 'adjudicator')
    return (
      <Tlv5Adjudicator
        workspace={workspace}
        selected={selected}
        onSelect={setSelected}
        onRefresh={refresh}
      />
    );
  return (
    <Tlv5Reviewer
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
      <strong>Design v5, PROPOSED</strong>Trial-level verification of the therapeutic-area labels.
      The rubric is a draft and no scientific choice is approved; the synthetic pilot and training
      examples never enter any statistic.
    </div>
  );
}

function RubricPanel() {
  const [rubric, setRubric] = useState<{
    version: string;
    sections: { heading: string; paragraphs: string[] }[];
  } | null>(null);
  useEffect(() => {
    api<{ version: string; sections: { heading: string; paragraphs: string[] }[] }>(
      '/api/tlv5/rubric',
    )
      .then(setRubric)
      .catch(() => setRubric(null));
  }, []);
  return (
    <details className="panel rubric-panel">
      <summary>
        Rubric <span className="muted">{rubric?.version ?? 'DRAFT'}</span>
      </summary>
      <div className="rubric-content">
        {rubric?.sections.map((section) => (
          <div key={section.heading}>
            <h3>{section.heading}</h3>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

function Packet({ packet }: { packet: Tlv5TrialPacket }) {
  const t = packet.trial;
  return (
    <div className="evidence-box">
      <dl className="metadata-list">
        {t.nct_id && (
          <>
            <dt>Trial identifier</dt>
            <dd className="mono">{t.nct_id}</dd>
          </>
        )}
        <dt>Brief title</dt>
        <dd>{t.brief_title}</dd>
        <dt>Official title</dt>
        <dd>{t.official_title}</dd>
        <dt>Conditions entered by the study team</dt>
        <dd>{t.conditions_registered.join('; ')}</dd>
        <dt>Standardized MeSH terms from ClinicalTrials.gov</dt>
        <dd>{t.condition_mesh_headings.join('; ')}</dd>
        <dt>Brief summary</dt>
        <dd className="evidence-text">{t.brief_summary}</dd>
        <dt>Interventions</dt>
        <dd>
          {t.interventions
            .map(
              (i) =>
                `${i.intervention_type}: ${i.name}${i.description ? ` (${i.description})` : ''}`,
            )
            .join('; ')}
        </dd>
        <dt>Eligibility age range</dt>
        <dd>
          {t.eligibility_age_range.minimum_age} to {t.eligibility_age_range.maximum_age}
        </dd>
      </dl>
      {packet.notices.map((notice) => (
        <p className="muted" key={notice}>
          {notice}
        </p>
      ))}
    </div>
  );
}

function QueueList({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: Tlv5QueueItem[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="queue-top">
        <h2>{title}</h2>
      </div>
      <ul className="queue-list">
        {items.map((item) => (
          <li key={item.assignmentId}>
            <button
              className={`queue-item ${item.caseId === selected ? 'selected' : ''}`}
              aria-current={item.caseId === selected ? 'true' : undefined}
              onClick={() => onSelect(item.caseId)}
            >
              <span className="queue-copy">
                <strong>{item.title}</strong>
                <span className="queue-meta">
                  <span>{MODE_LABEL[item.mode]}</span>
                  <span aria-hidden="true">·</span>
                  <span className={`status ${item.submissions ? 'complete' : ''}`}>
                    {item.submissions ? `Submitted (${item.submissions})` : 'Not started'}
                  </span>
                </span>
              </span>
              <span className="queue-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!items.length && (
        <div className="empty-state" style={{ padding: 25 }}>
          Nothing assigned in this view.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------------------------
type FormItem = { answer: string; uncertain: boolean; note: string; detailCode: string };
const blankForm = (): Record<string, FormItem> =>
  Object.fromEntries(
    [...AREA_ITEMS, ...ROW_ITEMS, ...SG_ITEMS].map((code) => [
      code,
      { answer: '', uncertain: false, note: '', detailCode: '' },
    ]),
  );
function fromSubmission(items: Tlv5ItemInput[]): Record<string, FormItem> {
  const form = blankForm();
  for (const item of items)
    form[item.itemCode] = {
      answer: item.answer,
      uncertain: item.uncertain,
      note: item.note ?? '',
      detailCode: item.detailCode ?? '',
    };
  return form;
}

function Tlv5Reviewer({
  workspace,
  selected,
  onSelect,
  onRefresh,
}: {
  workspace: Tlv5ReviewerWorkspace;
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<Tlv5Workspace>;
  user: Actor;
}) {
  return (
    <>
      <Banner />
      {!workspace.reviewer && (
        <div className="notice">
          Your account is not enrolled as a design v5 reviewer yet. The investigator enrols pilot
          and formal reviewers.
        </div>
      )}
      <div className="workspace-grid">
        <aside aria-label="Assigned trials">
          <QueueList
            title="Trials to verify"
            items={workspace.queue}
            selected={selected}
            onSelect={onSelect}
          />
          <QueueList
            title="Training examples"
            items={workspace.training}
            selected={selected}
            onSelect={onSelect}
          />
          <div className="privacy-note">
            <p>
              Labels, design fields, the other reviewer’s answers and adjudications are never shown
              to you. Please do not look the trial up in the registry.
            </p>
          </div>
        </aside>
        <div>
          {selected ? (
            <TrialForm key={selected} caseId={selected} onRefresh={onRefresh} />
          ) : (
            <section className="panel empty-state">
              <h2>Select a trial</h2>
              <p>
                Your assigned trials appear in the list. Each one has 17 items plus up to 2 subgroup
                items.
              </p>
            </section>
          )}
          <RubricPanel />
        </div>
      </div>
    </>
  );
}

function TrialForm({
  caseId,
  onRefresh,
}: {
  caseId: string;
  onRefresh: () => Promise<Tlv5Workspace>;
}) {
  const [detail, setDetail] = useState<Tlv5ReviewerCase | null>(null);
  const [form, setForm] = useState<Record<string, FormItem>>(blankForm);
  const [overallComment, setOverallComment] = useState('');
  const [packetIssue, setPacketIssue] = useState(false);
  const [packetIssueNote, setPacketIssueNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [started] = useState(() => Date.now());
  const apply = useCallback((data: Tlv5ReviewerCase) => {
    setDetail(data);
    const latest = data.submissions.at(-1);
    if (latest) {
      setForm(fromSubmission(latest.items));
      setOverallComment(latest.overallComment ?? '');
      setPacketIssue(latest.packetIssueFlag);
      setPacketIssueNote(latest.packetIssueNote ?? '');
    }
  }, []);
  const load = useCallback(
    () => api<Tlv5ReviewerCase>(`/api/tlv5/cases/${encodeURIComponent(caseId)}`),
    [caseId],
  );
  useEffect(() => {
    load()
      .then((data) => apply(data))
      .catch((e) => setError(e.message));
  }, [load, apply]);
  function update(code: string, changes: Partial<FormItem>) {
    setForm((old) => {
      const next = { ...old, [code]: { ...old[code], ...changes } };
      // The subgroup answer is dropped when the matching row answer changes away from Yes.
      for (const [sg, row] of Object.entries(SG_ROW))
        if (code === row && changes.answer !== undefined && changes.answer !== 'YES')
          next[sg] = { answer: '', uncertain: false, note: '', detailCode: '' };
      return next;
    });
    setNotice('');
  }
  function visible(code: string): boolean {
    const row = SG_ROW[code];
    return !row || form[row].answer === 'YES';
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const items: Tlv5ItemInput[] = [];
    for (const code of [...AREA_ITEMS, ...ROW_ITEMS, ...SG_ITEMS]) {
      if (!visible(code)) continue;
      const value = form[code];
      if (!value.answer) {
        setError(`Answer every item before submitting (missing: ${readable(code)}).`);
        return;
      }
      items.push({
        itemCode: code,
        answer: value.answer,
        uncertain: value.uncertain,
        ...(value.note.trim() ? { note: value.note.trim() } : {}),
        ...(value.detailCode ? { detailCode: value.detailCode } : {}),
      });
    }
    setBusy(true);
    try {
      await api(`/api/tlv5/cases/${encodeURIComponent(caseId)}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          items,
          ...(overallComment.trim() ? { overallComment: overallComment.trim() } : {}),
          packetIssueFlag: packetIssue,
          ...(packetIssue ? { packetIssueNote: packetIssueNote.trim() } : {}),
          secondsOnCase: Math.round((Date.now() - started) / 1000),
        }),
      });
      apply(await load());
      await onRefresh();
      setNotice(
        'Final submission recorded and locked. Contact the investigator if a correction is needed.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <section className="panel">
        <div className="panel-body">
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : (
            <div className="loading">Loading the trial packet…</div>
          )}
        </div>
      </section>
    );
  const latest = detail.submissions.at(-1);
  const locked = !detail.submissionsOpen;
  return (
    <section className="panel">
      <header className="case-header">
        <div className="eyebrow">{MODE_LABEL[detail.mode]} · trial verification</div>
        <div className="case-headline">
          <h2>{detail.packet.case_title}</h2>
          <span className={`badge ${latest ? '' : 'neutral'}`}>
            {latest ? 'Submitted · locked' : 'Not submitted'}
          </span>
        </div>
        <div className="case-subline">
          <span className="mono">{detail.caseId}</span>
        </div>
      </header>
      <form onSubmit={submit}>
        <div className="case-content">
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {locked && (
            <div className="notice locked-notice">
              <strong>Submissions are closed for this trial.</strong>{' '}
              {detail.rubricMismatch
                ? 'The rubric text changed since this review began; the investigator must reconcile the rubric before review activity continues. '
                : ''}
              Your recorded answers are shown read-only.
            </div>
          )}
          <div className="section-label">
            <span className="section-index">01</span>Trial packet
          </div>
          <Packet packet={detail.packet} />
          <hr className="section-divider" />
          <div className="section-label">
            <span className="section-index">02</span>Therapeutic areas (7)
          </div>
          {AREA_ITEMS.map((code) => (
            <ItemField
              key={code}
              code={code}
              value={form[code]}
              locked={locked}
              onChange={update}
            />
          ))}
          <div className="section-label">
            <span className="section-index">03</span>Condition rows (10) and subgroups
          </div>
          {ROW_ITEMS.map((code) => (
            <div key={code}>
              <ItemField code={code} value={form[code]} locked={locked} onChange={update} />
              {SG_ITEMS.filter((sg) => SG_ROW[sg] === code && visible(sg)).map((sg) => (
                <ItemField
                  key={sg}
                  code={sg}
                  value={form[sg]}
                  locked={locked}
                  onChange={update}
                  subgroup
                />
              ))}
            </div>
          ))}
          <div className="section-label">
            <span className="section-index">04</span>Case level
          </div>
          <div className="field">
            <label className="form-label" htmlFor={`overall-${caseId}`}>
              Overall comment (optional)
            </label>
            <textarea
              id={`overall-${caseId}`}
              value={overallComment}
              disabled={locked}
              onChange={(e) => setOverallComment(e.target.value)}
            />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={packetIssue}
              disabled={locked}
              onChange={(e) => setPacketIssue(e.target.checked)}
            />
            <span>Report a packet problem (a note is required)</span>
          </label>
          {packetIssue && (
            <div className="field">
              <label className="form-label" htmlFor={`issue-${caseId}`}>
                Packet problem note
              </label>
              <textarea
                id={`issue-${caseId}`}
                value={packetIssueNote}
                disabled={locked}
                onChange={(e) => setPacketIssueNote(e.target.value)}
              />
            </div>
          )}
          {!locked && (
            <div className="form-footer">
              <button className="button" type="submit" disabled={busy}>
                Submit trial verification
              </button>
            </div>
          )}
          {detail.mode === 'TRAINING' && latest && (
            <div className="notice">
              <strong>Worked answer</strong>
              {detail.workedAnswer ? (
                <>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{detail.workedAnswer.note}</p>
                  <ul>
                    {detail.workedAnswer.items.map((item, index) => (
                      <li key={`${item.itemCode}-${index}`}>
                        {item.itemCode}: {item.answer}
                        {item.detailCode ? ` / ${item.detailCode}` : ''}
                        {item.note ? ` — ${item.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>The worked answer is not available in this environment.</p>
              )}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}

function ItemField({
  code,
  value,
  locked,
  onChange,
  subgroup = false,
}: {
  code: string;
  value: FormItem;
  locked: boolean;
  onChange: (code: string, changes: Partial<FormItem>) => void;
  subgroup?: boolean;
}) {
  const scale = SCALES[itemFamily(code)] ?? [];
  const details = DETAIL_CODES[`${code}/${value.answer}`];
  return (
    <fieldset className="field" style={subgroup ? { marginLeft: 24 } : undefined}>
      <legend className="form-label">{itemQuestion(code)}</legend>
      <div className="context-grid">
        <div className="field">
          <label className="form-label" htmlFor={`${code}-answer`}>
            Answer ({code})
          </label>
          <select
            id={`${code}-answer`}
            value={value.answer}
            disabled={locked}
            onChange={(e) => onChange(code, { answer: e.target.value, detailCode: '' })}
          >
            <option value="">Select…</option>
            {scale.map((option) => (
              <option key={option} value={option}>
                {ANSWER_LABELS[option] ?? readable(option)}
              </option>
            ))}
          </select>
        </div>
        {details && (
          <div className="field">
            <label className="form-label" htmlFor={`${code}-detail`}>
              Detail ({code})
            </label>
            <select
              id={`${code}-detail`}
              value={value.detailCode}
              disabled={locked}
              onChange={(e) => onChange(code, { detailCode: e.target.value })}
            >
              <option value="">Select…</option>
              {details.map((option) => (
                <option key={option} value={option}>
                  {readable(option)}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={value.uncertain}
            disabled={locked}
            onChange={(e) => onChange(code, { uncertain: e.target.checked })}
          />
          <span>Uncertain ({code})</span>
        </label>
        <div className="field">
          <label className="form-label" htmlFor={`${code}-note`}>
            Note ({code})
          </label>
          <input
            id={`${code}-note`}
            value={value.note}
            disabled={locked}
            onChange={(e) => onChange(code, { note: e.target.value })}
          />
        </div>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Adjudicator
// ---------------------------------------------------------------------------------------------
function Tlv5Adjudicator({
  workspace,
  selected,
  onSelect,
  onRefresh,
}: {
  workspace: Tlv5AdjudicatorWorkspace;
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<Tlv5Workspace>;
}) {
  return (
    <>
      <Banner />
      <div className="workspace-grid">
        <aside aria-label="Adjudication queue">
          <section className="panel">
            <div className="queue-top">
              <h2>Adjudication queue</h2>
            </div>
            <ul className="queue-list">
              {workspace.cases.map((c) => (
                <li key={c.caseId}>
                  <button
                    className={`queue-item ${c.caseId === selected ? 'selected' : ''}`}
                    aria-current={c.caseId === selected ? 'true' : undefined}
                    onClick={() => onSelect(c.caseId)}
                  >
                    <span className="queue-copy">
                      <strong>{c.title}</strong>
                      <span className="queue-meta">
                        <span>{MODE_LABEL[c.mode]}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`status ${c.itemsNeedingAdjudication ? 'draft' : 'complete'}`}
                        >
                          {c.itemsNeedingAdjudication} item(s) need adjudication
                        </span>
                      </span>
                    </span>
                    <span className="queue-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {!workspace.cases.length && (
              <div className="empty-state" style={{ padding: 25 }}>
                No items are available. Formal items appear after the close and the snapshot.
              </div>
            )}
          </section>
          <div className="privacy-note">
            <p>
              Both reviewers’ answers are shown side by side. No label or design field is ever
              shown.
            </p>
          </div>
        </aside>
        <div>
          {selected ? (
            <AdjudicationCase key={selected} caseId={selected} onRefresh={onRefresh} />
          ) : (
            <section className="panel empty-state">
              <h2>Select a trial</h2>
              <p>
                Items where the reviewers differ, or only one reviewer answered, need your decision.
              </p>
            </section>
          )}
          <RubricPanel />
        </div>
      </div>
    </>
  );
}

function AdjudicationCase({
  caseId,
  onRefresh,
}: {
  caseId: string;
  onRefresh: () => Promise<Tlv5Workspace>;
}) {
  const [detail, setDetail] = useState<Tlv5AdjudicatorCaseDetail | null>(null);
  const [item, setItem] = useState('');
  const [decision, setDecision] = useState('');
  const [detailCode, setDetailCode] = useState('');
  const [status, setStatus] = useState<string>('DISCORDANT_RESOLVED');
  const [basis, setBasis] = useState<string>('REVIEWER_1');
  const [reason, setReason] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () => api<Tlv5AdjudicatorCaseDetail>(`/api/tlv5/cases/${encodeURIComponent(caseId)}`),
    [caseId],
  );
  useEffect(() => {
    load()
      .then((data) => setDetail(data))
      .catch((e) => setError(e.message));
  }, [load]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!item || !rationale.trim()) {
      setError('Select an item and give a rationale.');
      return;
    }
    if (status !== 'UNRESOLVED_ESCALATED' && !effectiveBasis) {
      setError('Select a decision; the basis follows from the reviewer answers it adopts.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/tlv5/adjudicate', {
        method: 'POST',
        body: JSON.stringify({
          caseId,
          itemCode: item,
          decision: status === 'UNRESOLVED_ESCALATED' ? null : decision,
          ...(detailCode ? { detailCode } : {}),
          status,
          basis: status === 'UNRESOLVED_ESCALATED' ? 'NONE' : effectiveBasis,
          rationale: rationale.trim(),
          ...(reason ? { disagreementReasonCode: reason } : {}),
        }),
      });
      setDetail(await load());
      await onRefresh();
      setNotice('Adjudication recorded and locked.');
      setItem('');
      setDecision('');
      setDetailCode('');
      setRationale('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <section className="panel">
        <div className="panel-body">
          {error ? (
            <div className="notice error">{error}</div>
          ) : (
            <div className="loading">Loading…</div>
          )}
        </div>
      </section>
    );
  const family = item ? itemFamily(item) : '';
  const scale = family
    ? [...(SCALES[family] ?? []), ...(family.startsWith('SG_') ? ['NOT_APPLICABLE'] : [])]
    : [];
  const details = DETAIL_CODES[`${item}/${decision}`];
  // Under DISAGREEMENTS_ONLY a concordant item enters the reference by rule and the database refuses
  // an explicit adjudication, so it is not offered; under ALL_ITEMS every item is adjudicated.
  const adjudicable = (row: Tlv5QueueRow) =>
    !row.adjudicated && (detail.adjudicationScope === 'ALL_ITEMS' || row.needsAdjudication);
  const selectedRow = detail.items.find((row) => row.itemCode === item);
  // The basis names whose latest answer (and detail code) the decision adopts; the database checks
  // the same rule (migration 0015), so only consistent choices are offered.
  const matches = (answer: string | null, detailValue: string | null) =>
    answer !== null && answer === decision && (detailValue ?? '') === (detailCode || '');
  const validBases =
    selectedRow && decision
      ? [
          matches(selectedRow.reviewer1Answer, selectedRow.reviewer1Detail) ? 'REVIEWER_1' : null,
          matches(selectedRow.reviewer2Answer, selectedRow.reviewer2Detail) ? 'REVIEWER_2' : null,
          matches(selectedRow.reviewer1Answer, selectedRow.reviewer1Detail) &&
          matches(selectedRow.reviewer2Answer, selectedRow.reviewer2Detail)
            ? 'BOTH_REVIEWERS'
            : null,
          !matches(selectedRow.reviewer1Answer, selectedRow.reviewer1Detail) &&
          !matches(selectedRow.reviewer2Answer, selectedRow.reviewer2Detail)
            ? 'NEITHER'
            : null,
        ].filter((b): b is string => b !== null)
      : [];
  const effectiveBasis = validBases.includes(basis) ? basis : (validBases[0] ?? '');
  return (
    <section className="panel">
      <header className="case-header">
        <div className="eyebrow">{MODE_LABEL[detail.mode]} · adjudication</div>
        <div className="case-headline">
          <h2>{detail.packet.case_title}</h2>
          <span className={`badge ${detail.adjudicationOpen ? 'neutral' : ''}`}>
            {detail.adjudicationOpen ? 'Open' : 'Closed or locked'}
          </span>
        </div>
        <div className="case-subline">
          <span className="mono">{detail.caseId}</span>
        </div>
      </header>
      <div className="case-content">
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <div className="section-label">
          <span className="section-index">01</span>Trial packet
        </div>
        <Packet packet={detail.packet} />
        <div className="section-label">
          <span className="section-index">02</span>Reviewer answers
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Reviewer 1</th>
                <th scope="col">Reviewer 2</th>
                <th scope="col">Needs adjudication</th>
                <th scope="col">Adjudicated</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((row) => (
                <tr key={row.itemCode}>
                  <td className="mono">{row.itemCode}</td>
                  <td>
                    {row.reviewer1Answer ?? '—'}
                    {row.reviewer1Detail ? ` / ${row.reviewer1Detail}` : ''}
                    {row.reviewer1Uncertain ? ' (uncertain)' : ''}
                    {row.reviewer1Note ? <div className="muted">{row.reviewer1Note}</div> : null}
                  </td>
                  <td>
                    {row.reviewer2Answer ?? '—'}
                    {row.reviewer2Detail ? ` / ${row.reviewer2Detail}` : ''}
                    {row.reviewer2Uncertain ? ' (uncertain)' : ''}
                    {row.reviewer2Note ? <div className="muted">{row.reviewer2Note}</div> : null}
                  </td>
                  <td>{row.needsAdjudication ? 'Yes' : 'No (by rule)'}</td>
                  <td>{row.adjudicated ? 'Yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {detail.adjudications.length > 0 && (
          <>
            <div className="section-label">Recorded adjudications</div>
            <ul>
              {detail.adjudications.map((a) => (
                <li key={a.adjudicationId}>
                  <span className="mono">{a.itemCode}</span> (locked): {a.decision ?? 'unresolved'}
                  {a.detailCode ? ` / ${a.detailCode}` : ''} · {readable(a.status)} ·{' '}
                  {readable(a.basis)}
                  {a.disagreementReasonCode ? ` · ${readable(a.disagreementReasonCode)}` : ''}
                  {a.postUnblinding ? ' · post-unblinding' : ''} — {a.rationale}
                </li>
              ))}
            </ul>
          </>
        )}
        {detail.adjudicationOpen && detail.items.some(adjudicable) && (
          <form onSubmit={submit}>
            <div className="section-label">
              <span className="section-index">03</span>Record an adjudication
            </div>
            <div className="context-grid">
              <div className="field">
                <label className="form-label" htmlFor="adj-item">
                  Item
                </label>
                <select
                  id="adj-item"
                  value={item}
                  onChange={(e) => {
                    setItem(e.target.value);
                    setDecision('');
                    setDetailCode('');
                  }}
                >
                  <option value="">Select…</option>
                  {detail.items.map((row) => (
                    <option key={row.itemCode} value={row.itemCode} disabled={!adjudicable(row)}>
                      {row.itemCode}
                      {row.adjudicated
                        ? ' (locked)'
                        : row.needsAdjudication
                          ? ' (needs adjudication)'
                          : detail.adjudicationScope === 'ALL_ITEMS'
                            ? ' (concordant)'
                            : ' (by rule; not adjudicated)'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="form-label" htmlFor="adj-status">
                  Status
                </label>
                <select id="adj-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {ADJUDICATION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {readable(s)}
                    </option>
                  ))}
                </select>
              </div>
              {status !== 'UNRESOLVED_ESCALATED' && (
                <div className="field">
                  <label className="form-label" htmlFor="adj-decision">
                    Decision
                  </label>
                  <select
                    id="adj-decision"
                    value={decision}
                    onChange={(e) => {
                      setDecision(e.target.value);
                      setDetailCode('');
                    }}
                  >
                    <option value="">Select…</option>
                    {scale.map((option) => (
                      <option key={option} value={option}>
                        {ANSWER_LABELS[option] ?? readable(option)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {details && (
                <div className="field">
                  <label className="form-label" htmlFor="adj-detail">
                    Detail
                  </label>
                  <select
                    id="adj-detail"
                    value={detailCode}
                    onChange={(e) => setDetailCode(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {details.map((option) => (
                      <option key={option} value={option}>
                        {readable(option)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {status !== 'UNRESOLVED_ESCALATED' && (
                <div className="field">
                  <label className="form-label" htmlFor="adj-basis">
                    Basis
                  </label>
                  <select
                    id="adj-basis"
                    value={effectiveBasis}
                    onChange={(e) => setBasis(e.target.value)}
                  >
                    {!validBases.length && <option value="">Select a decision first</option>}
                    {ADJUDICATION_BASES.filter((b) => validBases.includes(b)).map((b) => (
                      <option key={b} value={b}>
                        {readable(b)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label className="form-label" htmlFor="adj-reason">
                  Disagreement reason code
                </label>
                <select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">None</option>
                  {DISAGREEMENT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {readable(r)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label className="form-label" htmlFor="adj-rationale">
                Rationale
              </label>
              <textarea
                id="adj-rationale"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
            </div>
            <div className="form-footer">
              <button className="button" type="submit" disabled={busy || !item}>
                Record adjudication
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Investigator
// ---------------------------------------------------------------------------------------------
function Tlv5Investigator({
  workspace,
  onRefresh,
}: {
  workspace: Tlv5InvestigatorWorkspace;
  onRefresh: () => Promise<Tlv5Workspace>;
}) {
  const [attestation, setAttestation] = useState('');
  const [seed, setSeed] = useState('20261022');
  const [checklist, setChecklist] = useState({
    version: 'PILOT_ACCEPTANCE_CHECKLIST_v5',
    sha256: '',
  });
  const [activation, setActivation] = useState({
    designVersion: 'SYN-5',
    scope: 'DISAGREEMENTS_ONLY',
  });
  const [labelFileSha, setLabelFileSha] = useState('');
  const [enrol, setEnrol] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<Tlv5Bundle | null>(null);
  const s = workspace.state;
  async function act(action: Tlv5AdminAction, label: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/tlv5/admin/action', { method: 'POST', body: JSON.stringify(action) });
      await onRefresh();
      setNotice(`${label} recorded.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(mode: 'PILOT' | 'FORMAL') {
    setError('');
    try {
      setBundle(await api<Tlv5Bundle>(`/api/tlv5/admin/export/${mode}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const attested = attestation.trim().length >= 20;
  const modes: Tlv5Mode[] = ['PILOT', 'TRAINING', 'CALIBRATION', 'FORMAL'];
  return (
    <>
      <Banner />
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="stat-strip">
        <div className="stat">
          <div className="stat-label">Design v5</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            {s.activation ? `Active (${s.activation.adjudicationScope})` : 'Not activated'}
          </div>
          <div className="stat-detail">Schema {s.schemaVersions.slice(-2).join(', ')}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pilot</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            {s.pilotSignedOff
              ? 'Signed off'
              : s.locks.PILOT
                ? 'Locked'
                : `${workspace.counts.PILOT} cases`}
          </div>
          <div className="stat-detail">Synthetic, never analysed</div>
        </div>
        <div className="stat">
          <div className="stat-label">Formal phase</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            {readable(s.phase)}
          </div>
          <div className="stat-detail">
            {s.frozen ? `Frozen: ${s.frozen.nCases} cases` : 'Not frozen'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Reference locks</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            {Object.keys(s.locks).join(', ') || 'None'}
          </div>
          <div className="stat-detail">{s.snapshotTaken ? 'Snapshot taken' : 'No snapshot'}</div>
        </div>
      </div>
      <div className="admin-grid">
        <div>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Completion by mode</h2>
                <p>Counts only; no answer content while a phase is open</p>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Mode</th>
                    <th scope="col">Reviewer</th>
                    <th scope="col">Slot</th>
                    <th scope="col">Submitted / assigned</th>
                    <th scope="col">With revisions</th>
                  </tr>
                </thead>
                <tbody>
                  {modes.flatMap((mode) =>
                    workspace.completion[mode].map((row) => (
                      <tr key={`${mode}-${row.reviewerPseudoId}`}>
                        <td>{MODE_LABEL[mode]}</td>
                        <td className="mono">{row.reviewerPseudoId}</td>
                        <td>{row.reviewerSlot}</td>
                        <td>
                          {row.submitted} / {row.assigned}
                        </td>
                        <td>{row.withRevisions}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ fontSize: 12 }}>
                Cases: {modes.map((m) => `${MODE_LABEL[m]} ${workspace.counts[m]}`).join(' · ')}.
                Reviewers:{' '}
                {workspace.reviewers
                  .map(
                    (r) =>
                      `${r.pseudoId} (${r.modeScope}${r.account ? `, ${r.account}` : ''}${r.withdrawn ? ', withdrawn' : ''})`,
                  )
                  .join('; ') || 'none enrolled'}
                .
              </p>
              {workspace.verification.frozenLabels && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Frozen labels verify:{' '}
                  {workspace.verification.frozenLabels.matches ? 'match' : 'MISMATCH'} (
                  {workspace.verification.frozenLabels.currentRows} rows).
                </p>
              )}
              {workspace.verification.snapshot && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Snapshot verify: {workspace.verification.snapshot.matches ? 'match' : 'MISMATCH'}{' '}
                  ({workspace.verification.snapshot.currentRows} rows).
                </p>
              )}
              <p className="muted" style={{ fontSize: 12 }} data-testid="tlv5-rubric-bindings">
                Rubric bindings:{' '}
                {workspace.rubricBindings.length
                  ? workspace.rubricBindings
                      .map(
                        (b) =>
                          `${b.mode}: ${b.unreconciled ? 'UNRECONCILED (judgments predate rubric binding)' : `${b.rubricVersion}${b.matchesRuntime ? '' : ' (differs from the runtime rubric; activity blocked)'}`}`,
                      )
                      .join('; ')
                  : 'none yet (the first review activity of a mode binds the runtime rubric)'}
                .
              </p>
              {workspace.rubricBindings.some((b) => b.unreconciled) && (
                <RubricReconciliation
                  modes={workspace.rubricBindings.filter((b) => b.unreconciled).map((b) => b.mode)}
                  onReconcile={(input) => act(input, 'Rubric reconciliation')}
                />
              )}
            </div>
          </section>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <div>
                <h2>Exports (bundle format 5.0)</h2>
                <p>
                  Registered after the lock of each mode; the pilot bundle is a pipeline dry run
                </p>
              </div>
            </div>
            <div className="panel-body">
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={!s.locks.PILOT}
                  onClick={() => preview('PILOT')}
                >
                  Preview pilot bundle
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={!s.locks.FORMAL}
                  onClick={() => preview('FORMAL')}
                >
                  Preview formal bundle
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy || !s.locks.PILOT}
                  onClick={() =>
                    act({ action: 'register-export', mode: 'PILOT' }, 'Pilot export registration')
                  }
                >
                  Register pilot export
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy || !s.locks.FORMAL}
                  onClick={() =>
                    act({ action: 'register-export', mode: 'FORMAL' }, 'Formal export registration')
                  }
                >
                  Register formal export
                </button>
              </div>
              {bundle && (
                <div style={{ marginTop: 16 }}>
                  <p className="muted">
                    Manifest SHA-256 <span className="mono">{bundle.manifestSha256}</span>
                  </p>
                  <ul>
                    <li>
                      <a
                        href={`/api/tlv5/admin/export/${String(bundle.manifest.mode)}/${bundle.manifestName}`}
                      >
                        {bundle.manifestName}
                      </a>
                    </li>
                    {bundle.files.map((f) => (
                      <li key={f.name}>
                        <a
                          href={`/api/tlv5/admin/export/${String(bundle.manifest.mode)}/${f.name}`}
                        >
                          {f.name}
                        </a>{' '}
                        ({f.rows} rows, <span className="mono">{f.sha256.slice(0, 12)}…</span>)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {workspace.exports.length > 0 && (
                <ul>
                  {workspace.exports.map((e) => (
                    <li key={e.exportId}>
                      {e.mode} export {e.exportId.slice(0, 8)}… registered {e.createdAt} (manifest{' '}
                      {e.manifestSha256.slice(0, 12)}…)
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
        <div>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Gated actions</h2>
                <p>
                  Formal activation is disabled pending scientific approval and an approved frozen
                  rubric.
                </p>
              </div>
            </div>
            <div className="panel-body">
              <div className="field">
                <label className="form-label" htmlFor="tlv5-attestation">
                  Attestation (at least 20 characters)
                </label>
                <textarea
                  id="tlv5-attestation"
                  value={attestation}
                  onChange={(e) => setAttestation(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="form-label" htmlFor="tlv5-seed">
                  Assignment seed
                </label>
                <input id="tlv5-seed" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || workspace.counts.PILOT > 0}
                  onClick={() => act({ action: 'import-pilot' }, 'Pilot import')}
                >
                  Import the 10 synthetic pilot trials
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !workspace.counts.PILOT}
                  onClick={() =>
                    act({ action: 'assign', mode: 'PILOT', seed: Number(seed) }, 'Pilot assignment')
                  }
                >
                  Assign pilot trials to both pilot accounts
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested}
                  onClick={() =>
                    act({ action: 'lock', mode: 'PILOT', attestation }, 'Pilot reference lock')
                  }
                >
                  Lock pilot reference
                </button>
              </div>
              <hr className="section-divider" />
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="tlv5-checklist-version">
                    Checklist version
                  </label>
                  <input
                    id="tlv5-checklist-version"
                    value={checklist.version}
                    onChange={(e) => setChecklist({ ...checklist, version: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="tlv5-checklist-sha">
                    SHA-256 of the signed checklist
                  </label>
                  <input
                    id="tlv5-checklist-sha"
                    value={checklist.sha256}
                    onChange={(e) => setChecklist({ ...checklist, sha256: e.target.value })}
                  />
                </div>
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested || !/^[0-9a-fA-F]{64}$/.test(checklist.sha256)}
                  onClick={() =>
                    act(
                      {
                        action: 'sign-off',
                        checklistVersion: checklist.version,
                        checklistSha256: checklist.sha256,
                        attestation,
                      },
                      'Pilot sign-off',
                    )
                  }
                >
                  Sign off the v5 pilot
                </button>
              </div>
              <hr className="section-divider" />
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="tlv5-design-version">
                    Design version
                  </label>
                  <input
                    id="tlv5-design-version"
                    value={activation.designVersion}
                    onChange={(e) =>
                      setActivation({ ...activation, designVersion: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="tlv5-scope">
                    Adjudication scope
                  </label>
                  <select
                    id="tlv5-scope"
                    value={activation.scope}
                    onChange={(e) => setActivation({ ...activation, scope: e.target.value })}
                  >
                    <option value="DISAGREEMENTS_ONLY">Disagreements only</option>
                    <option value="ALL_ITEMS">All items</option>
                  </select>
                </div>
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={true}
                  onClick={() =>
                    act(
                      {
                        action: 'activate',
                        designVersion: activation.designVersion,
                        adjudicationScope: activation.scope,
                        attestation,
                      },
                      'Design v5 activation (local synthetic database)',
                    )
                  }
                >
                  Activate design v5 (disposable database only)
                </button>
              </div>
              <hr className="section-divider" />
              <div className="field">
                <label className="form-label" htmlFor="tlv5-enrol">
                  Enrol a formal-scope reviewer account
                </label>
                <select id="tlv5-enrol" value={enrol} onChange={(e) => setEnrol(e.target.value)}>
                  <option value="">Select…</option>
                  {workspace.formalCandidates.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.account} · {c.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: 'provision-staging-accounts' },
                      'Synthetic staging reviewer accounts',
                    )
                  }
                >
                  Provision the two synthetic staging reviewer accounts
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={true}
                  onClick={() =>
                    act({ action: 'enroll-formal', userId: enrol }, 'Formal reviewer enrolment')
                  }
                >
                  Enrol as FORMAL reviewer
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !workspace.counts.TRAINING}
                  onClick={() =>
                    act(
                      { action: 'assign', mode: 'TRAINING', seed: Number(seed) },
                      'Training assignment',
                    )
                  }
                >
                  Assign training examples
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested || !workspace.counts.TRAINING}
                  onClick={() =>
                    act(
                      { action: 'lock', mode: 'TRAINING', attestation },
                      'Training reference lock',
                    )
                  }
                >
                  Lock training reference
                </button>
              </div>
              <hr className="section-divider" />
              <div className="field">
                <label className="form-label" htmlFor="tlv5-label-sha">
                  SHA-256 of the imported label file (freeze)
                </label>
                <input
                  id="tlv5-label-sha"
                  value={labelFileSha}
                  onChange={(e) => setLabelFileSha(e.target.value)}
                />
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={true}
                  onClick={() =>
                    act({ action: 'freeze', labelFileSha256: labelFileSha, attestation }, 'Freeze')
                  }
                >
                  Freeze the formal sample and labels
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={true}
                  onClick={() =>
                    act(
                      { action: 'phase', eventType: 'FORMAL_OPENED', attestation },
                      'Formal phase opening',
                    )
                  }
                >
                  Open the formal phase
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={true}
                  onClick={() =>
                    act(
                      { action: 'assign', mode: 'FORMAL', seed: Number(seed) },
                      'Formal assignment',
                    )
                  }
                >
                  Assign formal trials
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested}
                  onClick={() =>
                    act(
                      { action: 'phase', eventType: 'FORMAL_CLOSED_COMPLETE', attestation },
                      'Formal close (complete)',
                    )
                  }
                >
                  Close formal phase (complete)
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested}
                  onClick={() =>
                    act(
                      { action: 'phase', eventType: 'FORMAL_CLOSED_INCOMPLETE', attestation },
                      'Formal close (incomplete)',
                    )
                  }
                >
                  Close formal phase (incomplete)
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => act({ action: 'snapshot' }, 'Judgment snapshot')}
                >
                  Take the judgment snapshot
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !attested}
                  onClick={() =>
                    act({ action: 'lock', mode: 'FORMAL', attestation }, 'Formal reference lock')
                  }
                >
                  Lock formal reference
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                Formal and training trials are imported only by the private staging dry-run script
                from files outside this repository; nothing here imports real data. Rubric{' '}
                {workspace.rubricVersion}, SHA-256{' '}
                <span className="mono">{workspace.rubricSha256.slice(0, 16)}…</span>; build{' '}
                <span className="mono">{workspace.appGitSha.slice(0, 12)}</span>.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/** Investigator-only: name the rubric that judgments recorded before rubric binding were made
 *  under. Recorded once per mode, append-only and audited (migration 0019). */
function RubricReconciliation({
  modes,
  onReconcile,
}: {
  modes: Tlv5Mode[];
  onReconcile: (input: Tlv5AdminAction) => Promise<void>;
}) {
  const [mode, setMode] = useState<Tlv5Mode>(modes[0]);
  const [version, setVersion] = useState('');
  const [sha, setSha] = useState('');
  const [attestation, setAttestation] = useState('');
  const ready =
    version.trim().length >= 3 && /^[0-9a-fA-F]{64}$/.test(sha) && attestation.trim().length >= 20;
  return (
    <form
      className="notice warning"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready)
          void onReconcile({
            action: 'reconcile-rubric',
            mode,
            rubricVersion: version.trim(),
            rubricSha256: sha.toLowerCase(),
            attestation,
          });
      }}
    >
      <strong>Rubric reconciliation required</strong>
      Judgments in {modes.join(', ')} were recorded before rubric binding existed. Record the rubric
      version and SHA-256 they were made under; review activity and exports for that mode stay
      blocked until then. This is a one-time, audited investigator record.
      <div className="context-grid">
        <label className="field">
          <span className="form-label">Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as Tlv5Mode)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="form-label">Rubric version</span>
          <input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span className="form-label">Rubric SHA-256</span>
          <input
            value={sha}
            onChange={(e) => setSha(e.target.value)}
            maxLength={64}
            className="mono"
          />
        </label>
        <label className="field">
          <span className="form-label">Attestation (20 characters or more)</span>
          <input
            value={attestation}
            onChange={(e) => setAttestation(e.target.value)}
            maxLength={2000}
          />
        </label>
      </div>
      <div className="button-row">
        <button className="button" type="submit" disabled={!ready}>
          Record rubric reconciliation
        </button>
      </div>
    </form>
  );
}
