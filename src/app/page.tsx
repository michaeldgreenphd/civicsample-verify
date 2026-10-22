'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Actor,
  AdjudicationInput,
  AdminInput,
  CaseDetail,
  Configuration,
  Decision,
  Judgment,
  JudgmentInput,
  Workspace,
} from '@/lib/types';
import { Icon } from '@/components/icons';

const decisions: { value: Decision; label: string; description: string }[] = [
  {
    value: 'INCLUDE',
    label: 'Include',
    description: 'The evidence supports membership in this area.',
  },
  {
    value: 'EXCLUDE',
    label: 'Exclude',
    description: 'The evidence does not support membership in this area.',
  },
  {
    value: 'CONTEXT_DEPENDENT',
    label: 'Context dependent',
    description: 'Membership depends on conditions that you can specify.',
  },
  {
    value: 'INSUFFICIENT_INFORMATION',
    label: 'Insufficient information',
    description: 'The packet does not provide enough evidence for a judgment.',
  },
];
const emptyJudgment = (): JudgmentInput => ({
  decision: 'INSUFFICIENT_INFORMATION',
  rationale: '',
  uncertain: false,
  context: '',
  packetProblem: false,
});
const readable = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : 'The request could not be completed. Please try again.',
    );
  return body as T;
}
function Brand() {
  return (
    <a className="brand" href="/" aria-label="CivicSample Verify home">
      <span className="brand-symbol" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      <span className="brand-word">
        CivicSample<em>Verify</em>
      </span>
    </a>
  );
}
function Header({ user, onLogout }: { user: Actor | null; onLogout: () => void }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          {user && (
            <div className="account-area">
              <div className="account-name">
                {user.displayName}
                <span className="account-role">{readable(user.role)}</span>
              </div>
              <button className="text-button" onClick={onLogout}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="environment-banner">
        <span className="environment-dot" />
        <strong>SYNTHETIC PILOT</strong>
        <span>Fabricated evidence only. This workspace is not approved for formal validation.</span>
      </div>
    </>
  );
}
function Footer() {
  return (
    <footer className="page-footer">
      <span>CivicSample Verify · Independent evidence review</span>
      <span>Synthetic environment · No production data</span>
    </footer>
  );
}
function Rubric() {
  return (
    <details className="panel rubric-panel">
      <summary>
        Review guidance <span className="muted">Synthetic placeholder</span>
      </summary>
      <div className="rubric-content">
        <p>
          <strong>This is not an approved formal study rubric.</strong> The pilot exercises the
          review workflow with fabricated evidence. Formal interpretation rules, tier version, and
          the analysis plan require separate approval.
        </p>
        <ul>
          <li>
            Judge the provided evidence against the area definition and explain your reasoning.
          </li>
          <li>
            Record uncertainty independently of your decision. Flag incomplete or problematic
            packets.
          </li>
          <li>
            For a context dependent decision, specify the clinical context and conditions that would
            change the classification.
          </li>
          <li>
            For trial cases, submit and lock the descriptor judgment before opening trial evidence.
          </li>
          <li>
            Submitted judgments are locked. Other reviewers’ responses and model outputs are not
            available during independent review.
          </li>
        </ul>
      </div>
    </details>
  );
}
function Login({ onLogin }: { onLogin: (user: Actor) => void }) {
  const [account, setAccount] = useState('reviewer-a');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api<{ user: Actor }>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ account, password }),
      });
      onLogin(data.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="auth-wrap">
      <section className="auth-intro">
        <div className="eyebrow">Human judgment. Recorded independently.</div>
        <h1>A considered view of the evidence.</h1>
        <p>
          A dedicated workspace for reviewing research classifications, documenting uncertainty, and
          preserving independent judgments.
        </p>
        <ul className="auth-features">
          <li>
            <Icon name="shield" />
            Independent, role-controlled review
          </li>
          <li>
            <Icon name="file" />
            Source evidence alongside every decision
          </li>
          <li>
            <Icon name="lock" />
            Locked submissions with a traceable record
          </li>
        </ul>
      </section>
      <form className="auth-form" onSubmit={submit}>
        <h2>Enter the review workspace</h2>
        <p>Select your assigned pilot account to continue.</p>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        <div className="field">
          <label className="form-label" htmlFor="account">
            Pilot account
          </label>
          <select id="account" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="reviewer-a">Reviewer A</option>
            <option value="reviewer-b">Reviewer B</option>
            <option value="investigator">Investigator</option>
            <option value="adjudicator">Adjudicator</option>
          </select>
        </div>
        <div className="field">
          <label className="form-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="button" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
          <Icon name="arrow" size={14} />
        </button>
        <div className="auth-note">
          Use the password for your assigned role from local setup. Access is limited to synthetic
          fixtures; formal-study activation is disabled.
        </div>
      </form>
    </main>
  );
}

export default function Home() {
  const [user, setUser] = useState<Actor | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState('review');
  useEffect(() => {
    api<{ user: Actor | null }>('/api/session')
      .then((d) => setUser(d.user))
      .catch((e) => setError(e.message))
      .finally(() => setInitializing(false));
  }, []);
  const refresh = useCallback(async () => {
    const next = await api<Workspace>('/api/workspace');
    setWorkspace(next);
    setSelected((current) =>
      current && next.queue.some((q) => q.caseId === current)
        ? current
        : (next.queue[0]?.caseId ?? null),
    );
    return next;
  }, []);
  useEffect(() => {
    if (!user) return;
    api<Workspace>('/api/workspace')
      .then((next) => {
        setWorkspace(next);
        setSelected(next.queue[0]?.caseId ?? null);
      })
      .catch((e) => setError(e.message));
  }, [user]);
  async function logout() {
    try {
      await api('/api/session', { method: 'DELETE' });
      setUser(null);
      setSelected(null);
      setWorkspace(null);
      setError('');
      setTab('review');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Header user={user} onLogout={logout} />
      {initializing ? (
        <main id="main" className="loading">
          <span className="loading-dot" />
          Opening workspace…
        </main>
      ) : !user ? (
        <>
          <Login
            onLogin={(u) => {
              setError('');
              setUser(u);
            }}
          />
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <main id="main" className="app-shell">
          <div className="page-intro">
            <div>
              <div className="eyebrow">
                {user.role === 'INVESTIGATOR'
                  ? 'Study oversight'
                  : user.role === 'ADJUDICATOR'
                    ? 'Independent adjudication'
                    : 'Independent review'}
              </div>
              <h1>
                {user.role === 'INVESTIGATOR'
                  ? 'Pilot overview'
                  : user.role === 'ADJUDICATOR'
                    ? 'Resolve with the evidence.'
                    : 'Your review workspace'}
              </h1>
              <p className="intro-copy">
                {user.role === 'INVESTIGATOR'
                  ? 'Track completion and readiness while preserving the independence of every review.'
                  : user.role === 'ADJUDICATOR'
                    ? 'Consider the authorized human judgments and record a reasoned final determination.'
                    : 'Read the evidence, make your judgment, and document the reasoning behind it.'}
              </p>
            </div>
            {workspace && (
              <span className="phase-label">
                {readable(workspace.campaign.state)} · Synthetic pilot
              </span>
            )}
          </div>
          <nav className="workspace-tabs" aria-label="Workspace sections">
            <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
              {user.role === 'INVESTIGATOR'
                ? 'Overview & readiness'
                : user.role === 'ADJUDICATOR'
                  ? 'Adjudication queue'
                  : 'Review queue'}
              {workspace && user.role !== 'INVESTIGATOR' && (
                <span className="count-pill">{workspace.queue.length}</span>
              )}
            </button>
            <button
              className={tab === 'module-b' ? 'active' : ''}
              onClick={() => setTab('module-b')}
            >
              Module B <span className="count-pill">Proposed</span>
            </button>
          </nav>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button
                className="text-button"
                style={{ marginLeft: 16 }}
                onClick={() =>
                  refresh()
                    .then(() => setError(''))
                    .catch((e) => setError(e.message))
                }
              >
                Retry
              </button>
            </div>
          )}
          {!workspace ? (
            !error && (
              <div className="loading">
                <span className="loading-dot" />
                Loading assigned workspace…
              </div>
            )
          ) : tab === 'module-b' ? (
            <ModuleB />
          ) : user.role === 'INVESTIGATOR' ? (
            <Investigator workspace={workspace} onRefresh={refresh} />
          ) : (
            <ReviewWorkspace
              workspace={workspace}
              selected={selected}
              onSelect={setSelected}
              onRefresh={refresh}
            />
          )}
          <Footer />
        </main>
      )}
    </>
  );
}
function ModuleB() {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Module B</h2>
          <p>A separate proposed study track</p>
        </div>
        <span className="badge amber">Proposed · Not approved</span>
      </div>
      <div className="panel-body">
        <div className="notice warning">
          <strong>Not activated</strong>Module B has no approved protocol, sample, or analysis plan
          in this workspace. It is excluded from the active review queue and pilot completion
          counts.
        </div>
        <p className="muted">
          This space records the separation of Module B from the current synthetic pilot. No formal
          cases can be enrolled or reviewed here.
        </p>
      </div>
    </section>
  );
}
function ReviewWorkspace({
  workspace,
  selected,
  onSelect,
  onRefresh,
}: {
  workspace: Workspace;
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<Workspace>;
}) {
  const [filter, setFilter] = useState('all');
  const completed = workspace.queue.filter(
    (q) => q.status === 'SUBMITTED' || q.status === 'ADJUDICATED',
  ).length;
  const filtered = workspace.queue.filter(
    (q) =>
      filter === 'all' ||
      (filter === 'complete'
        ? ['SUBMITTED', 'ADJUDICATED'].includes(q.status)
        : !['SUBMITTED', 'ADJUDICATED'].includes(q.status)),
  );
  return (
    <>
      {workspace.notice && <div className="notice">{workspace.notice}</div>}
      <div className="workspace-grid">
        <aside aria-label="Assigned review cases">
          <section className="panel">
            <div className="queue-top">
              <h2>Assigned cases</h2>
              <div className="queue-progress">
                <div className="progress-caption">
                  <span>
                    {completed} of {workspace.queue.length} complete
                  </span>
                  <span>
                    {workspace.queue.length
                      ? Math.round((completed / workspace.queue.length) * 100)
                      : 0}
                    %
                  </span>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Assigned case completion"
                  aria-valuemin={0}
                  aria-valuemax={workspace.queue.length || 1}
                  aria-valuenow={completed}
                >
                  <div
                    className="progress-fill"
                    style={{
                      width: `${workspace.queue.length ? (completed / workspace.queue.length) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
              <div className="queue-filter" aria-label="Filter assigned cases">
                {[
                  ['all', 'All cases'],
                  ['pending', 'To review'],
                  ['complete', 'Complete'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    aria-pressed={filter === value}
                    className={filter === value ? 'active' : ''}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ul className="queue-list">
              {filtered.map((item) => (
                <li key={item.caseId}>
                  <button
                    className={`queue-item ${item.caseId === selected ? 'selected' : ''}`}
                    aria-current={item.caseId === selected ? 'true' : undefined}
                    onClick={() => onSelect(item.caseId)}
                  >
                    <span className="queue-icon">
                      <Icon
                        name={['SUBMITTED', 'ADJUDICATED'].includes(item.status) ? 'check' : 'file'}
                        size={13}
                      />
                    </span>
                    <span className="queue-copy">
                      <strong>{item.title}</strong>
                      <span className="queue-meta">
                        <span>{item.unitType === 'TRIAL_AREA' ? 'Trial' : 'Descriptor'}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`status ${['SUBMITTED', 'ADJUDICATED'].includes(item.status) ? 'complete' : item.status !== 'NOT_STARTED' ? 'draft' : ''}`}
                        >
                          {readable(item.status)}
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
            {filtered.length === 0 && (
              <div className="empty-state" style={{ padding: 25 }}>
                No cases in this view.
              </div>
            )}
            <div className="queue-footer">{workspace.queue.length} assigned synthetic cases</div>
          </section>
          <div className="privacy-note">
            <Icon name="shield" size={15} />
            <p>
              {workspace.user.role === 'ADJUDICATOR'
                ? 'Only authorized human responses are available. Model predictions remain hidden.'
                : 'Your judgments stay independent. Other reviewers’ responses and model predictions are hidden.'}
            </p>
          </div>
        </aside>
        <div>
          {selected ? (
            <CaseReview
              key={`${selected}:${workspace.campaign.state}`}
              caseId={selected}
              user={workspace.user}
              onRefresh={onRefresh}
            />
          ) : (
            <section className="panel empty-state">
              <Icon name="lock" size={27} />
              <h2>
                {workspace.user.role === 'ADJUDICATOR'
                  ? 'Awaiting authorization'
                  : 'No assigned cases'}
              </h2>
              <p>
                {workspace.user.role === 'ADJUDICATOR'
                  ? 'Human responses become available only after review closes and the investigator explicitly authorizes adjudication.'
                  : 'Your assigned cases will appear here when they are available.'}
              </p>
            </section>
          )}
          <Rubric />
        </div>
      </div>
    </>
  );
}
function CaseReview(props: { caseId: string; user: Actor; onRefresh: () => Promise<Workspace> }) {
  return props.user.role === 'ADJUDICATOR' ? (
    <AdjudicationReview {...props} />
  ) : (
    <ReviewerCase {...props} />
  );
}
function ReviewerCase({
  caseId,
  user,
  onRefresh,
}: {
  caseId: string;
  user: Actor;
  onRefresh: () => Promise<Workspace>;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [judgment, setJudgment] = useState<JudgmentInput>(emptyJudgment);
  const [chosen, setChosen] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [amending, setAmending] = useState(false);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const current = useRef({ judgment: emptyJudgment(), dirty: false, locked: true });
  const saved = useRef('');
  const adjudicating = user.role === 'ADJUDICATOR';
  const locked =
    !!detail &&
    (adjudicating
      ? !!detail.adjudication || detail.phase !== 'ADJUDICATION'
      : (!!detail.submission && !amending) || detail.phase !== 'OPEN');
  useEffect(() => {
    let live = true;
    api<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`)
      .then((data) => {
        if (!live) return;
        setDetail(data);
        const amendmentDraft = data.drafts?.find(
          (draft) =>
            draft.amendmentId &&
            data.availableAmendments?.some(
              (amendment) => amendment.id === draft.amendmentId && amendment.level === draft.level,
            ),
        );
        const value = amendmentDraft || data.submission || data.draft || emptyJudgment();
        setAmending(!!amendmentDraft);
        setJudgment(value);
        setChosen(!!(amendmentDraft || data.submission || data.draft));
        saved.current = JSON.stringify(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [caseId]);
  useEffect(() => {
    current.current = { judgment, dirty, locked: !detail || locked || busy || !chosen };
  }, [judgment, dirty, detail, locked, busy, chosen]);
  const persist = useCallback(
    (value: JudgmentInput): Promise<void> => {
      const fingerprint = JSON.stringify(value);
      const operation = pending.current
        .catch(() => {})
        .then(async () => {
          if (fingerprint === saved.current) return;
          setSaving('saving');
          try {
            await api(`/api/cases/${encodeURIComponent(caseId)}/draft`, {
              method: 'POST',
              body: JSON.stringify(value),
            });
            saved.current = fingerprint;
            setSaving('saved');
            void onRefresh().catch(() => {});
          } catch (e) {
            setSaving('error');
            throw e;
          }
        });
      pending.current = operation;
      return operation;
    },
    [caseId, onRefresh],
  );
  useEffect(() => {
    if (!dirty || !detail || locked || busy || !chosen) return;
    const timer = setTimeout(() => {
      persist(judgment).catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [judgment, dirty, detail, locked, busy, chosen, persist]);
  useEffect(
    () => () => {
      const latest = current.current;
      if (latest.dirty && !latest.locked) void persist(latest.judgment).catch(() => {});
    },
    [persist],
  );
  function update(changes: Partial<JudgmentInput>) {
    setJudgment((old) => ({ ...old, ...changes }));
    setDirty(true);
    setConfirm(false);
  }
  function requestSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!chosen || !judgment.rationale.trim()) {
      setError('Select a decision and provide a rationale before submitting.');
      return;
    }
    if (judgment.decision === 'CONTEXT_DEPENDENT') {
      try {
        const context = JSON.parse(judgment.context);
        if (
          !context.clinicalContext?.trim() ||
          !context.inclusionConditions?.trim() ||
          !context.exclusionConditions?.trim()
        )
          throw new Error();
      } catch {
        setError('Complete all three structured context fields before submitting.');
        return;
      }
    }
    setConfirm(true);
  }
  async function submit() {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      await pending.current.catch(() => {});
      const endpoint = adjudicating
        ? 'adjudicate'
        : detail.step1Required && !detail.step1Locked
          ? 'step1'
          : 'submit';
      await api(`/api/cases/${encodeURIComponent(caseId)}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(judgment),
      });
      current.current.locked = true;
      setDirty(false);
      setAmending(false);
      setConfirm(false);
      setSaving('idle');
      const next = await api<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);
      setDetail(next);
      const nextValue = next.submission || next.draft || emptyJudgment();
      setJudgment(nextValue);
      setChosen(!!(next.adjudication || next.submission || next.draft));
      saved.current = JSON.stringify(nextValue);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <section className="panel">
        {error ? (
          <div className="panel-body">
            <div className="notice error" role="alert">
              {error}
            </div>
          </div>
        ) : (
          <div className="loading">
            <span className="loading-dot" />
            Loading evidence packet…
          </div>
        )}
      </section>
    );
  const isStep1 = !amending && detail.step1Required && !detail.step1Locked;
  const final = amending ? undefined : detail.submission;
  function startAmendment(amendment: { id: string; level: string; reason: string }) {
    const source =
      amendment.level === 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' ? detail?.step1 : detail?.submission;
    const previousDraft = detail?.drafts?.find(
      (draft) => draft.level === amendment.level && draft.amendmentId === amendment.id,
    );
    setJudgment(
      previousDraft || {
        decision: source?.decision || 'INSUFFICIENT_INFORMATION',
        rationale: source?.rationale || '',
        uncertain: source?.uncertain || false,
        context: source?.context || '',
        packetProblem: source?.packetProblem || false,
        ...(source?.packetProblemNote ? { packetProblemNote: source.packetProblemNote } : {}),
        ...(source?.descriptorRole ? { descriptorRole: source.descriptorRole } : {}),
        level: amendment.level,
        amendmentId: amendment.id,
      },
    );
    setChosen(!!(previousDraft || source));
    setAmending(true);
    setDirty(false);
    setConfirm(false);
    setError('');
    setSaving('idle');
  }
  return (
    <section className="panel">
      <header className="case-header">
        <div className="eyebrow">
          {detail.unitType === 'TRIAL_AREA' ? 'Trial–area judgment' : 'Descriptor–area judgment'}
        </div>
        <div className="case-headline">
          <h2>{detail.title}</h2>
          <span className={`badge ${final ? '' : 'neutral'}`}>
            {final ? (
              <>
                <Icon name="lock" size={11} />
                Submitted
              </>
            ) : isStep1 ? (
              'Step 1 of 2'
            ) : detail.step1Required ? (
              'Step 2 of 2'
            ) : (
              'Ready for review'
            )}
          </span>
        </div>
        <div className="case-subline">
          <span>Area: {detail.area}</span>
          <span aria-hidden="true">·</span>
          <span className="mono">{detail.caseId}</span>
        </div>
      </header>
      <form onSubmit={requestSubmit}>
        <div className="case-content">
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {!amending && detail.phase === 'OPEN' && !!detail.availableAmendments?.length && (
            <div className="notice">
              <strong>Authorized amendment available</strong>
              <p>
                Your original response stays locked. Select the authorized level to create a new
                version.
              </p>
              <div className="button-row" style={{ marginTop: 12 }}>
                {detail.availableAmendments.map((amendment) => (
                  <button
                    type="button"
                    className="button secondary small"
                    key={amendment.id}
                    onClick={() => startAmendment(amendment)}
                  >
                    Amend {readable(amendment.level)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {amending && (
            <div className="notice warning">
              <strong>Editing an authorized amendment</strong>A new response version will be
              recorded for {readable(judgment.level || '')}. The original judgment remains
              preserved.
            </div>
          )}
          {isStep1 && (
            <div className="notice">
              <strong>Descriptor judgment first</strong>Record and lock your descriptor-level
              judgment before seeing trial-specific evidence. This first judgment cannot be revised
              after disclosure.
            </div>
          )}
          {detail.step1Locked && (
            <div className="notice locked-notice">
              <Icon name="lock" />
              <div>
                <strong>
                  Step 1 locked:{' '}
                  {detail.step1 ? readable(detail.step1.decision) : 'Descriptor judgment recorded'}
                </strong>
                Trial evidence is now disclosed. Record a separate trial-level judgment below.
                {detail.step1 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer' }}>
                      View locked descriptor reasoning
                    </summary>
                    <p style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{detail.step1.rationale}</p>
                  </details>
                )}
              </div>
            </div>
          )}
          <div className="section-label">
            <span className="section-index">01</span>Evidence packet
          </div>
          <Evidence detail={detail} />
          {detail.trialPacket && <TrialEvidence detail={detail} />}
          <hr className="section-divider" />
          {adjudicating && (
            <>
              <div className="section-label">Authorized human responses</div>
              {detail.humanReviews?.length ? (
                <div className="response-grid">
                  {detail.humanReviews.map((review, index) => (
                    <HumanResponse key={review.id} review={review} index={index} />
                  ))}
                </div>
              ) : (
                <div className="notice warning">
                  No authorized human responses are available for this case.
                </div>
              )}
            </>
          )}
          <div className="section-label">
            <span className="section-index">02</span>
            {adjudicating
              ? 'Adjudication'
              : isStep1
                ? 'Descriptor judgment'
                : detail.step1Required
                  ? 'Trial judgment'
                  : 'Your judgment'}
          </div>
          <p className="help-line">
            {locked
              ? 'This record is read-only.'
              : 'Choose the decision best supported by the evidence above.'}
          </p>
          {final && (
            <div className="notice locked-notice">
              <Icon name="lock" />
              <div>
                <strong>Final submission locked</strong>Submitted{' '}
                {new Date(final.submittedAt).toLocaleString()}. This judgment is preserved and
                cannot be edited.
              </div>
            </div>
          )}
          {locked && !final && (
            <div className="notice warning">
              Review is closed for this case. Your saved draft is read-only.
            </div>
          )}
          <fieldset disabled={locked || busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">Decision and rationale</legend>
            <div className="decision-list">
              {decisions.map((option) => (
                <label
                  key={option.value}
                  aria-label={option.label}
                  className={`decision-option ${chosen && judgment.decision === option.value ? 'chosen' : ''}`}
                >
                  <input
                    type="radio"
                    name={`decision-${caseId}`}
                    value={option.value}
                    required
                    checked={chosen && judgment.decision === option.value}
                    onChange={() => {
                      setChosen(true);
                      update({ decision: option.value });
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
            {!isStep1 &&
              detail.unitType === 'TRIAL_AREA' &&
              (!amending || judgment.level === 'TRIAL_LEVEL') && (
                <div className="field">
                  <label className="form-label" htmlFor="descriptor-role">
                    Descriptor role in this trial <span className="required">Required</span>
                  </label>
                  <select
                    id="descriptor-role"
                    required
                    value={judgment.descriptorRole || ''}
                    onChange={(e) => update({ descriptorRole: e.target.value })}
                  >
                    <option value="">Select the observed role</option>
                    {[
                      'DISEASE_STUDIED',
                      'COMORBIDITY',
                      'COMPLICATION',
                      'OUTCOME_ONLY',
                      'PREVENTION_TARGET',
                      'RISK_FACTOR',
                      'OTHER',
                      'UNRESOLVABLE',
                    ].map((value) => (
                      <option key={value} value={value}>
                        {readable(value)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            {chosen && judgment.decision === 'CONTEXT_DEPENDENT' && (
              <ContextFields value={judgment.context} onChange={(context) => update({ context })} />
            )}
            <div className="field">
              <label htmlFor={`rationale-${caseId}`} className="form-label">
                Rationale <span className="required">Required for submission</span>
              </label>
              <textarea
                id={`rationale-${caseId}`}
                value={judgment.rationale}
                onChange={(e) => update({ rationale: e.target.value })}
                required
                placeholder="Explain how the evidence supports your judgment. Identify any relevant limitations."
              />
              <p className="form-hint">
                A clear reasoning record is required for every final decision.
              </p>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={judgment.uncertain}
                onChange={(e) => update({ uncertain: e.target.checked })}
              />
              <span>
                I am uncertain about this judgment
                <small>Uncertainty is recorded separately from the decision.</small>
              </span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={judgment.packetProblem}
                onChange={(e) => update({ packetProblem: e.target.checked })}
              />
              <span>
                There is a problem with this evidence packet
                <small>Describe the problem separately below.</small>
              </span>
            </label>
            {judgment.packetProblem && (
              <div className="field">
                <label className="form-label" htmlFor="packet-note">
                  Packet problem details <span className="required">Required</span>
                </label>
                <textarea
                  id="packet-note"
                  required
                  value={judgment.packetProblemNote || ''}
                  onChange={(e) => update({ packetProblemNote: e.target.value })}
                />
              </div>
            )}
          </fieldset>
          {confirm && !locked && (
            <div
              className="confirmation"
              role="region"
              aria-label="Confirm final submission"
              style={{ marginTop: 22 }}
            >
              <h3>
                {isStep1 ? 'Lock your descriptor judgment?' : 'Submit and lock this judgment?'}
              </h3>
              <p>
                {isStep1
                  ? 'Your descriptor judgment becomes final and trial evidence will be disclosed. You cannot return to edit Step 1.'
                  : 'This is your final judgment. After submission, this record cannot be edited.'}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm(false)}
                >
                  Keep reviewing
                </button>
                <button type="button" className="button" disabled={busy} onClick={submit}>
                  <Icon name="lock" size={13} />
                  {busy ? 'Submitting…' : 'Confirm & lock'}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="form-footer">
          <div
            className={`save-status ${saving === 'error' ? 'error' : ''}`}
            role="status"
            aria-live="polite"
          >
            <Icon name={locked ? 'lock' : saving === 'saving' ? 'clock' : 'check'} size={13} />
            {locked
              ? 'Locked record'
              : saving === 'saving'
                ? 'Saving draft…'
                : saving === 'saved'
                  ? 'Draft saved'
                  : saving === 'error'
                    ? 'Draft not saved'
                    : !chosen
                      ? 'Choose a decision to enable draft saving'
                      : 'Drafts save automatically'}
            {saving === 'error' && (
              <button
                type="button"
                className="text-button"
                onClick={() => persist(judgment).catch(() => {})}
              >
                Retry
              </button>
            )}
          </div>
          {!locked && !confirm && (
            <button className="button" disabled={busy}>
              {isStep1
                ? 'Lock Step 1 & continue'
                : adjudicating
                  ? 'Submit adjudication'
                  : 'Submit judgment'}
              <Icon name="arrow" size={13} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
function Evidence({ detail }: { detail: Pick<CaseDetail, 'packet'> }) {
  const p = detail.packet;
  return (
    <>
      <div className="evidence-box">
        <div className="eyebrow">Descriptor scope note · Synthetic</div>
        <p className="evidence-text">{p.scopeNote}</p>
      </div>
      <dl className="metadata-list">
        <div>
          <dt>Descriptor</dt>
          <dd>{p.descriptorName}</dd>
        </div>
        <div>
          <dt>Descriptor ID</dt>
          <dd className="mono">{p.descriptorId}</dd>
        </div>
        <div>
          <dt>Entry terms</dt>
          <dd>{p.entryTerms.length ? p.entryTerms.join(' · ') : 'None supplied'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {p.source} · {p.sourceVersion}
          </dd>
        </div>
        <div>
          <dt>Area definition</dt>
          <dd>{p.areaDefinition}</dd>
        </div>
        <div>
          <dt>Tree placement</dt>
          <dd>
            {p.treeNumbers.length
              ? p.treeNumbers.map((t) => `${t.number} — ${t.label}`).join('; ')
              : 'None supplied'}
          </dd>
        </div>
      </dl>
    </>
  );
}
function TrialEvidence({ detail }: { detail: Pick<CaseDetail, 'trialPacket'> }) {
  const p = detail.trialPacket!;
  return (
    <>
      <hr className="section-divider" />
      <div className="section-label">Disclosed trial evidence</div>
      <div className="evidence-box">
        <div className="eyebrow">Fabricated trial summary</div>
        <h3 style={{ marginBottom: 8 }}>{p.title}</h3>
        <p className="evidence-text">{p.summary}</p>
      </div>
      <dl className="metadata-list">
        {[
          ['Synthetic registry ID', p.registryId],
          ['Conditions', p.conditions.join('; ')],
          ['Interventions', p.interventions.join('; ')],
          ['Primary outcomes', p.primaryOutcomes.join('; ')],
          ['Study type / purpose', `${p.studyType} · ${p.primaryPurpose}`],
          ['Phase / age range', `${p.phase} · ${p.ageRange}`],
          ['Source', `${p.source} · ${p.sourceVersion}`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || 'Not supplied'}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
function ContextFields({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  let context: Record<string, string> = {};
  try {
    context = JSON.parse(value || '{}');
  } catch {
    context = { clinicalContext: value };
  }
  return (
    <div className="context-area">
      <div className="form-label" style={{ marginBottom: 12 }}>
        Structured context <span className="required">All fields required</span>
      </div>
      <div className="context-grid">
        {[
          ['clinicalContext', 'Relevant clinical context'],
          ['inclusionConditions', 'Conditions supporting inclusion'],
          ['exclusionConditions', 'Conditions supporting exclusion'],
        ].map(([key, label]) => (
          <div key={key} className="field">
            <label className="form-label" htmlFor={key}>
              {label}
            </label>
            <textarea
              id={key}
              style={{ minHeight: 75 }}
              required
              value={context[key] || ''}
              onChange={(e) => onChange(JSON.stringify({ ...context, [key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
function HumanResponse({ review, index }: { review: Judgment; index: number }) {
  let context: Record<string, string> | null = null;
  try {
    context = review.context ? JSON.parse(review.context) : null;
  } catch {
    /* Historical free-text context is shown in the rationale. */
  }
  return (
    <article className="human-response">
      <h3>Human reviewer {index + 1}</h3>
      <span className="badge neutral">{readable(review.decision)}</span>
      <p>{review.rationale}</p>
      {review.descriptorRole && (
        <p className="muted" style={{ fontSize: 11 }}>
          Descriptor role: {readable(review.descriptorRole)}
        </p>
      )}
      {review.packetProblemNote && (
        <p className="muted" style={{ fontSize: 11 }}>
          Packet problem: {review.packetProblemNote}
        </p>
      )}
      {context && (
        <dl className="metadata-list" style={{ gridTemplateColumns: '1fr', marginTop: 12 }}>
          {Object.entries(context).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="muted" style={{ fontSize: 10, marginTop: 12 }}>
        Uncertain: {review.uncertain ? 'Yes' : 'No'} · Packet problem:{' '}
        {review.packetProblem ? 'Yes' : 'No'}
      </p>
    </article>
  );
}
function Investigator({
  workspace,
  onRefresh,
}: {
  workspace: Workspace;
  onRefresh: () => Promise<Workspace>;
}) {
  const [config, setConfig] = useState<Configuration>(workspace.configuration);
  const [attestation, setAttestation] = useState('');
  const [action, setAction] = useState<AdminInput['action'] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [amendment, setAmendment] = useState({
    caseId: '',
    reviewerId: '00000000-0000-4000-8000-000000000002',
    level: 'DESCRIPTOR_LEVEL',
    reason: '',
  });
  const [newCase, setNewCase] = useState({
    id: 'SYN-011',
    kind: 'TWO_STEP' as 'DESCRIPTOR' | 'TWO_STEP',
    title: 'Fictional condition K',
    area: 'Respiratory',
    descriptorName: 'Fictional condition K',
    descriptorId: 'TESTFX-D0011',
    scopeNote:
      'Synthetic training vignette 11. This invented descriptor exercises the two-step authoring and review workflow.',
    entryTerms: 'Fictional synonym 11',
    treeNumber: 'TESTFX.011',
    treeLabel: 'Synthetic branch — no real MeSH classification',
    areaDefinition:
      'For this pilot only, consider whether the fictional condition belongs in the respiratory construct.',
    source: 'Hand-authored fictional engineering fixture',
    sourceVersion: 'synthetic-v1',
    registryId: 'SYN-NCT-0011',
    trialTitle: 'Fictional trial 11',
    trialSummary:
      'An invented trial examines fictional condition K as its primary condition. No real trial is represented.',
    conditions: 'Fictional condition K',
    interventions: 'Fictional nebulized intervention',
    primaryOutcomes: 'Fictional respiratory symptom score',
    studyType: 'Synthetic interventional example',
    primaryPurpose: 'Synthetic treatment example',
    trialPhase: 'Not applicable to fictional study',
    ageRange: 'Fictional adult population',
  });
  // Preview exactly the evidence that will be submitted, including trimmed list values.
  const splitList = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const authoredPayload = {
    id: newCase.id.trim(),
    kind: newCase.kind,
    packet: {
      title: newCase.title.trim(),
      area: newCase.area.trim(),
      descriptorName: newCase.descriptorName.trim(),
      descriptorId: newCase.descriptorId.trim(),
      scopeNote: newCase.scopeNote.trim(),
      entryTerms: splitList(newCase.entryTerms),
      treeNumbers: [{ number: newCase.treeNumber.trim(), label: newCase.treeLabel.trim() }],
      areaDefinition: newCase.areaDefinition.trim(),
      source: newCase.source.trim(),
      sourceVersion: newCase.sourceVersion.trim(),
    },
    ...(newCase.kind === 'TWO_STEP'
      ? {
          trialPacket: {
            registryId: newCase.registryId.trim(),
            title: newCase.trialTitle.trim(),
            summary: newCase.trialSummary.trim(),
            conditions: splitList(newCase.conditions),
            interventions: splitList(newCase.interventions),
            primaryOutcomes: splitList(newCase.primaryOutcomes),
            studyType: newCase.studyType.trim(),
            primaryPurpose: newCase.primaryPurpose.trim(),
            phase: newCase.trialPhase.trim(),
            ageRange: newCase.ageRange.trim(),
            source: newCase.source.trim(),
            sourceVersion: newCase.sourceVersion.trim(),
          },
        }
      : {}),
  };
  async function authorCase(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/admin/cases', {
        method: 'POST',
        body: JSON.stringify(authoredPayload),
      });
      const refreshed = await onRefresh();
      setConfig(refreshed.configuration);
      setNotice(`Synthetic case ${newCase.id.trim()} authored and assigned to both reviewers.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!action || !attestation.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/action', {
        method: 'POST',
        body: JSON.stringify({
          action,
          attestation,
          ...(action === 'configure' ? { configuration: { tierVersion: config.tierVersion } } : {}),
          ...(action === 'authorize-amendment' ? amendment : {}),
        }),
      });
      const refreshed = await onRefresh();
      setConfig(refreshed.configuration);
      setNotice('Action recorded in the synthetic pilot audit log.');
      setAction(null);
      setAttestation('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const phase = workspace.campaign.state;
  const done = workspace.campaign.completed;
  const total = workspace.campaign.total;
  return (
    <>
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
          <div className="stat-label">Synthetic cases</div>
          <div className="stat-value">{workspace.campaign.caseCount}</div>
          <div className="stat-detail">Fabricated pilot evidence</div>
        </div>
        <div className="stat">
          <div className="stat-label">Completed judgments</div>
          <div className="stat-value">
            {done}
            <span style={{ fontSize: 15, color: 'var(--muted)', letterSpacing: 0 }}>
              {' '}
              / {total}
            </span>
          </div>
          <div className="stat-detail">Required human submissions</div>
        </div>
        <div className="stat">
          <div className="stat-label">Campaign phase</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            {readable(phase)}
          </div>
          <div className="stat-detail">Explicit phase transitions</div>
        </div>
        <div className="stat">
          <div className="stat-label">Formal activation</div>
          <div className="stat-value" style={{ fontSize: 21 }}>
            Disabled
          </div>
          <div className="stat-detail">Synthetic environment only</div>
        </div>
      </div>
      <div className="admin-grid">
        <div>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Review progress</h2>
                <p>Operational completion only; no reviewer decisions or model outputs</p>
              </div>
              <Icon name="shield" />
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Reviewer / assignment</th>
                    <th scope="col">Complete</th>
                    <th scope="col">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.progress?.map((item) => (
                    <tr key={item.label}>
                      <td>{item.label}</td>
                      <td>
                        {item.completed} / {item.total}
                      </td>
                      <td>
                        <div
                          className="progress-track"
                          role="progressbar"
                          aria-label={`${item.label} completion`}
                          aria-valuemin={0}
                          aria-valuemax={item.total || 1}
                          aria-valuenow={item.completed}
                          aria-valuetext={`${item.completed} of ${item.total} complete`}
                        >
                          <div
                            className="progress-fill"
                            style={{
                              width: `${item.total ? (item.completed / item.total) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!workspace.progress?.length && (
              <div className="empty-state" style={{ padding: 25 }}>
                No progress records available.
              </div>
            )}
            <div className="panel-body">
              <p className="muted" style={{ fontSize: 11 }}>
                Independent judgments remain concealed from the investigator while review is open.
              </p>
            </div>
          </section>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <div>
                <h2>Study configuration</h2>
                <p>Proposal, approval, and freeze are distinct recorded states</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="notice warning">
                <strong>Synthetic workflow configuration</strong>Approval and freeze are unavailable
                in this prototype. Scientific materials remain proposed, and real study data cannot
                be authorized.
              </div>
              <div className="config-grid">
                <div className="field">
                  <label className="form-label" htmlFor="tier-version">
                    Tier version
                  </label>
                  <select
                    id="tier-version"
                    disabled={workspace.configuration.tierState === 'FROZEN' || phase === 'LOCKED'}
                    value={config.tierVersion}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        tierVersion: e.target.value as Configuration['tierVersion'],
                      })
                    }
                  >
                    <option value="PENDING">Pending decision</option>
                    <option value="v1.1">v1.1</option>
                    <option value="v1.2">v1.2</option>
                  </select>
                </div>
                {(
                  [
                    ['tierState', 'Tier approval'],
                    ['rubricState', 'Rubric approval'],
                    ['sampleState', 'Sample approval'],
                    ['analysisPlanState', 'Analysis plan approval'],
                  ] as const
                ).map(([key, label]) => (
                  <div className="field" key={key}>
                    <label className="form-label" htmlFor={key}>
                      {label}
                    </label>
                    <select
                      id={key}
                      value={config[key]}
                      disabled
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    >
                      <option value="PROPOSED">Proposed</option>
                      <option value="APPROVED">Approved</option>
                      <option value="FROZEN">Frozen</option>
                    </select>
                  </div>
                ))}
                <div className="field">
                  <label className="form-label" htmlFor="scope">
                    Adjudication scope
                  </label>
                  <select
                    id="scope"
                    value={config.adjudicationScope}
                    disabled
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        adjudicationScope: e.target.value as Configuration['adjudicationScope'],
                      })
                    }
                  >
                    <option value="ALL_CASE_LEVELS">All case levels</option>
                    <option value="DISAGREEMENTS_ONLY">Disagreements only</option>
                  </select>
                </div>
              </div>
              <button
                className="button secondary"
                style={{ marginTop: 19 }}
                disabled={phase === 'LOCKED' || config.tierVersion === 'PENDING'}
                onClick={() => {
                  setAction('configure');
                  setNotice('');
                }}
              >
                Record tier proposal
              </button>
            </div>
          </section>
          <details className="panel rubric-panel">
            <summary>Authorize a documented amendment</summary>
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <p className="muted" style={{ fontSize: 12, marginBottom: 15 }}>
                An amendment creates a new response version. The original locked judgment remains in
                the audit record. Step 1 in a trial case cannot be amended after submission because
                submitting it makes the trial context available.
              </p>
              <div className="field">
                <label className="form-label" htmlFor="amend-case">
                  Synthetic case ID
                </label>
                <input
                  id="amend-case"
                  value={amendment.caseId}
                  onChange={(e) => setAmendment({ ...amendment, caseId: e.target.value })}
                />
              </div>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="amend-reviewer">
                    Reviewer
                  </label>
                  <select
                    id="amend-reviewer"
                    value={amendment.reviewerId}
                    onChange={(e) => setAmendment({ ...amendment, reviewerId: e.target.value })}
                  >
                    <option value="00000000-0000-4000-8000-000000000002">Reviewer A</option>
                    <option value="00000000-0000-4000-8000-000000000003">Reviewer B</option>
                  </select>
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="amend-level">
                    Judgment level
                  </label>
                  <select
                    id="amend-level"
                    value={amendment.level}
                    onChange={(e) => setAmendment({ ...amendment, level: e.target.value })}
                  >
                    <option value="DESCRIPTOR_LEVEL">Descriptor</option>
                    <option value="TRIAL_LEVEL">Trial</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="form-label" htmlFor="amend-reason">
                  Reason
                </label>
                <textarea
                  id="amend-reason"
                  value={amendment.reason}
                  onChange={(e) => setAmendment({ ...amendment, reason: e.target.value })}
                />
              </div>
              <button
                className="button secondary"
                disabled={phase !== 'OPEN' || !amendment.caseId.trim() || !amendment.reason.trim()}
                onClick={() => setAction('authorize-amendment')}
              >
                Review amendment authorization
              </button>
            </div>
          </details>
          <details className="panel rubric-panel">
            <summary>Author a synthetic pilot case</summary>
            <form className="panel-body" style={{ paddingTop: 0 }} onSubmit={authorCase}>
              <p className="muted" style={{ fontSize: 12, marginBottom: 15 }}>
                Create a fictional pilot case with descriptor evidence and optional trial evidence.
                Review the complete preview before assigning it to both reviewers. Source details
                apply to both evidence packets.
              </p>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="author-case-id">
                    New synthetic case ID
                  </label>
                  <input
                    id="author-case-id"
                    value={newCase.id}
                    onChange={(e) => setNewCase({ ...newCase, id: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="author-case-kind">
                    Case kind
                  </label>
                  <select
                    id="author-case-kind"
                    value={newCase.kind}
                    onChange={(e) =>
                      setNewCase({
                        ...newCase,
                        kind: e.target.value as 'DESCRIPTOR' | 'TWO_STEP',
                      })
                    }
                  >
                    <option value="DESCRIPTOR">Descriptor only</option>
                    <option value="TWO_STEP">Two-step trial case</option>
                  </select>
                </div>
              </div>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="author-case-title">
                    Case title
                  </label>
                  <input
                    id="author-case-title"
                    value={newCase.title}
                    onChange={(e) => setNewCase({ ...newCase, title: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="author-case-area">
                    Construct area
                  </label>
                  <input
                    id="author-case-area"
                    value={newCase.area}
                    onChange={(e) => setNewCase({ ...newCase, area: e.target.value })}
                  />
                </div>
              </div>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="author-descriptor-name">
                    Descriptor name
                  </label>
                  <input
                    id="author-descriptor-name"
                    value={newCase.descriptorName}
                    onChange={(e) => setNewCase({ ...newCase, descriptorName: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="author-descriptor-id">
                    Synthetic descriptor ID
                  </label>
                  <input
                    id="author-descriptor-id"
                    value={newCase.descriptorId}
                    onChange={(e) => setNewCase({ ...newCase, descriptorId: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label className="form-label" htmlFor="author-scope-note">
                  Descriptor scope note
                </label>
                <textarea
                  id="author-scope-note"
                  value={newCase.scopeNote}
                  onChange={(e) => setNewCase({ ...newCase, scopeNote: e.target.value })}
                />
              </div>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="author-entry-terms">
                    Entry terms
                  </label>
                  <input
                    id="author-entry-terms"
                    aria-describedby="author-list-help"
                    value={newCase.entryTerms}
                    onChange={(e) => setNewCase({ ...newCase, entryTerms: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="author-tree-number">
                    Tree number
                  </label>
                  <input
                    id="author-tree-number"
                    value={newCase.treeNumber}
                    onChange={(e) => setNewCase({ ...newCase, treeNumber: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label className="form-label" htmlFor="author-tree-label">
                  Tree placement label
                </label>
                <input
                  id="author-tree-label"
                  value={newCase.treeLabel}
                  required
                  maxLength={200}
                  onChange={(e) => setNewCase({ ...newCase, treeLabel: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="form-label" htmlFor="author-area-definition">
                  Area definition
                </label>
                <textarea
                  id="author-area-definition"
                  value={newCase.areaDefinition}
                  onChange={(e) => setNewCase({ ...newCase, areaDefinition: e.target.value })}
                />
              </div>
              <div className="context-grid">
                <div className="field">
                  <label className="form-label" htmlFor="author-source">
                    Evidence source
                  </label>
                  <input
                    id="author-source"
                    value={newCase.source}
                    required
                    maxLength={200}
                    onChange={(e) => setNewCase({ ...newCase, source: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="author-source-version">
                    Evidence source version
                  </label>
                  <input
                    id="author-source-version"
                    value={newCase.sourceVersion}
                    required
                    maxLength={100}
                    onChange={(e) => setNewCase({ ...newCase, sourceVersion: e.target.value })}
                  />
                </div>
              </div>
              <p className="muted" id="author-list-help">
                Separate multiple entry terms, conditions, interventions, or outcomes with a comma.
              </p>
              {newCase.kind === 'TWO_STEP' && (
                <>
                  <div className="context-grid">
                    <div className="field">
                      <label className="form-label" htmlFor="author-registry-id">
                        Synthetic trial registry ID
                      </label>
                      <input
                        id="author-registry-id"
                        value={newCase.registryId}
                        onChange={(e) => setNewCase({ ...newCase, registryId: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="form-label" htmlFor="author-trial-title">
                        Trial title
                      </label>
                      <input
                        id="author-trial-title"
                        value={newCase.trialTitle}
                        onChange={(e) => setNewCase({ ...newCase, trialTitle: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label className="form-label" htmlFor="author-trial-summary">
                      Trial summary
                    </label>
                    <textarea
                      id="author-trial-summary"
                      value={newCase.trialSummary}
                      onChange={(e) => setNewCase({ ...newCase, trialSummary: e.target.value })}
                    />
                  </div>
                  {(
                    [
                      ['conditions', 'Conditions'],
                      ['interventions', 'Interventions'],
                      ['primaryOutcomes', 'Primary outcomes'],
                    ] as const
                  ).map(([key, label]) => (
                    <div className="field" key={key}>
                      <label className="form-label" htmlFor={`author-${key}`}>
                        {label}
                      </label>
                      <textarea
                        id={`author-${key}`}
                        aria-describedby="author-list-help"
                        value={newCase[key]}
                        required
                        onChange={(e) => setNewCase({ ...newCase, [key]: e.target.value })}
                      />
                    </div>
                  ))}
                  <div className="context-grid">
                    {(
                      [
                        ['studyType', 'Study type'],
                        ['primaryPurpose', 'Primary purpose'],
                        ['trialPhase', 'Trial phase'],
                        ['ageRange', 'Age range'],
                      ] as const
                    ).map(([key, label]) => (
                      <div className="field" key={key}>
                        <label className="form-label" htmlFor={`author-${key}`}>
                          {label}
                        </label>
                        <input
                          id={`author-${key}`}
                          value={newCase[key]}
                          required
                          maxLength={200}
                          onChange={(e) => setNewCase({ ...newCase, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
              <section aria-labelledby="author-evidence-preview-heading">
                <hr className="section-divider" />
                <h3 id="author-evidence-preview-heading">Evidence preview</h3>
                <p className="muted">
                  These values will be saved. Trial evidence is available to reviewers only after
                  they lock Step 1.
                </p>
                <dl className="metadata-list">
                  <div>
                    <dt>Case ID</dt>
                    <dd>{authoredPayload.id}</dd>
                  </div>
                  <div>
                    <dt>Case title</dt>
                    <dd>{authoredPayload.packet.title}</dd>
                  </div>
                  <div>
                    <dt>Construct area</dt>
                    <dd>{authoredPayload.packet.area}</dd>
                  </div>
                  <div>
                    <dt>Case kind</dt>
                    <dd>
                      {authoredPayload.kind === 'TWO_STEP'
                        ? 'Two-step trial case'
                        : 'Descriptor only'}
                    </dd>
                  </div>
                </dl>
                <Evidence detail={{ packet: authoredPayload.packet }} />
                {authoredPayload.trialPacket && (
                  <TrialEvidence detail={{ trialPacket: authoredPayload.trialPacket }} />
                )}
              </section>
              <button className="button secondary" disabled={phase !== 'OPEN' || busy}>
                Author synthetic case
              </button>
            </form>
          </details>
        </div>
        <div>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Readiness gates</h2>
                <p>Evidence of readiness is required</p>
              </div>
              <span className="badge amber">Formal use blocked</span>
            </div>
            <div className="panel-body">
              <ul className="gate-list">
                {workspace.gates.map((gate) => (
                  <li key={gate.id}>
                    <div>
                      <strong>{gate.label}</strong>
                      <p>{gate.detail}</p>
                    </div>
                    <span
                      className={`badge ${gate.state === 'PASS' ? '' : gate.state === 'BLOCKED' ? 'amber' : 'neutral'}`}
                    >
                      {readable(gate.state)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <h2>Campaign controls</h2>
            </div>
            <div className="panel-body">
              <p className="muted" style={{ fontSize: 12 }}>
                Each transition requires an explicit attestation and is recorded in the audit log.
              </p>
              <div className="admin-actions">
                <button
                  className="button secondary"
                  disabled={phase !== 'OPEN'}
                  onClick={() => setAction('close')}
                >
                  Close independent review
                </button>
                <button
                  className="button secondary"
                  disabled={phase !== 'CLOSED'}
                  onClick={() => setAction('authorize-adjudication')}
                >
                  Authorize adjudication
                </button>
                <button
                  className="button secondary"
                  disabled={phase !== 'ADJUDICATION'}
                  onClick={() => setAction('lock')}
                >
                  Lock pilot & enable export
                </button>
                {phase === 'LOCKED' ? (
                  <a className="button" href="/api/admin/export" download>
                    Download locked export
                    <Icon name="file" size={13} />
                  </a>
                ) : (
                  <button className="button" disabled>
                    Export available after lock
                  </button>
                )}
                <button className="button secondary" disabled>
                  <Icon name="lock" size={13} />
                  Formal activation disabled
                </button>
              </div>
            </div>
          </section>
          {action && (
            <section
              className="confirmation"
              style={{ marginTop: 24 }}
              aria-label="Confirm administrative action"
            >
              <h3>{readable(action.replaceAll('-', '_'))}</h3>
              <p>
                {action === 'close'
                  ? 'Reviewers will no longer be able to submit ordinary judgments.'
                  : action === 'authorize-adjudication'
                    ? 'Authorized human responses will become visible to the adjudicator.'
                    : action === 'lock'
                      ? 'The pilot record will be locked and its export enabled.'
                      : action === 'configure'
                        ? 'The selected tier version will be recorded as a proposal. Approval states remain proposed.'
                        : 'The specified reviewer will receive permission to add a new judgment version.'}
              </p>
              <label className="form-label" htmlFor="attestation">
                Attestation / reason
              </label>
              <textarea
                id="attestation"
                required
                value={attestation}
                onChange={(e) => setAttestation(e.target.value)}
              />
              <div className="button-row" style={{ marginTop: 13 }}>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  Cancel
                </button>
                <button className="button" disabled={busy || !attestation.trim()} onClick={execute}>
                  {busy ? 'Recording…' : 'Confirm action'}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
      <Rubric />
    </>
  );
}
function AdjudicationReview({
  caseId,
  onRefresh,
}: {
  caseId: string;
  user: Actor;
  onRefresh: () => Promise<Workspace>;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [level, setLevel] = useState('');
  const [input, setInput] = useState<AdjudicationInput>({
    ...emptyJudgment(),
    decision: null,
    status: 'RESOLVED',
    basis: '',
    reasonCode: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(async () => {
    const data = await api<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);
    setDetail(data);
    return data;
  }, [caseId]);
  useEffect(() => {
    api<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [caseId]);
  function update(changes: Partial<AdjudicationInput>) {
    setInput((old) => ({ ...old, ...changes }));
    setConfirm(false);
  }
  const levels = Array.from(
    new Set(
      (detail?.humanReviews || []).map((r) => r.level).filter((value): value is string => !!value),
    ),
  );
  const final =
    detail?.adjudications?.find((a) => a.level === level) ||
    (detail?.adjudication?.level === level ? detail.adjudication : undefined);
  const locked = !!final || detail?.phase !== 'ADJUDICATION';
  function changeLevel(value: string) {
    setLevel(value);
    setConfirm(false);
    setError('');
    const existing = detail?.adjudications?.find((a) => a.level === value);
    setInput(
      existing
        ? {
            ...existing,
            status: existing.status,
            basis: existing.basis || '',
            reasonCode: existing.reasonCode || '',
          }
        : {
            ...emptyJudgment(),
            decision: null,
            level: value,
            status: 'RESOLVED',
            basis: '',
            reasonCode: '',
          },
    );
  }
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/cases/${encodeURIComponent(caseId)}/adjudicate`, {
        method: 'POST',
        body: JSON.stringify({
          ...input,
          level,
          decision: input.status === 'UNRESOLVED_ESCALATED' ? null : input.decision,
        }),
      });
      await load();
      await onRefresh();
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function prepare(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (
      !level ||
      !input.rationale.trim() ||
      !input.basis.trim() ||
      !input.reasonCode ||
      (input.status === 'RESOLVED' && !input.decision)
    ) {
      setError('Complete the level, disposition, rationale, basis, and reason code.');
      return;
    }
    if (input.status === 'RESOLVED' && input.decision === 'CONTEXT_DEPENDENT') {
      try {
        const context = JSON.parse(input.context);
        if (
          !context.clinicalContext?.trim() ||
          !context.inclusionConditions?.trim() ||
          !context.exclusionConditions?.trim()
        )
          throw new Error();
      } catch {
        setError('Complete all structured context fields.');
        return;
      }
    }
    setConfirm(true);
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
            <div className="loading">Loading authorized evidence…</div>
          )}
        </div>
      </section>
    );
  const views = (detail.humanReviews || []).filter((r) => r.level === level);
  return (
    <section className="panel">
      <header className="case-header">
        <div className="eyebrow">Human adjudication</div>
        <div className="case-headline">
          <h2>{detail.title}</h2>
          <span className="badge neutral">{detail.area}</span>
        </div>
        <p className="case-subline">Resolve each authorized judgment level independently.</p>
      </header>
      <div className="case-content">
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="section-label">
          <span className="section-index">01</span>Source evidence
        </div>
        <Evidence detail={detail} />
        {detail.trialPacket && <TrialEvidence detail={detail} />}
        <hr className="section-divider" />
        <div className="field">
          <label className="form-label" htmlFor="adjudication-level">
            Judgment level <span className="required">Choose a level to review</span>
          </label>
          <select
            id="adjudication-level"
            value={level}
            onChange={(e) => changeLevel(e.target.value)}
          >
            <option value="">Select judgment level</option>
            {levels.map((value) => (
              <option key={value} value={value}>
                {readable(value)}
                {detail.adjudications?.some((a) => a.level === value) ? ' — locked' : ''}
              </option>
            ))}
          </select>
        </div>
        {!levels.length && (
          <div className="notice warning">
            No judgment levels have been authorized for this case.
          </div>
        )}
        {level && (
          <>
            <div className="section-label">Authorized human responses</div>
            <div className="response-grid">
              {views.map((review, index) => (
                <HumanResponse key={review.id} review={review} index={index} />
              ))}
            </div>
            <form onSubmit={prepare}>
              <div className="section-label">
                <span className="section-index">02</span>Adjudication record
              </div>
              {final && (
                <div className="notice locked-notice">
                  <Icon name="lock" />
                  <div>
                    <strong>Adjudication locked</strong>
                    {final.status === 'UNRESOLVED_ESCALATED'
                      ? 'Unresolved and escalated. No final classification was assigned.'
                      : `Final classification: ${final.decision ? readable(final.decision) : 'None'}.`}
                  </div>
                </div>
              )}
              <fieldset disabled={locked || busy} style={{ margin: 0, padding: 0, border: 0 }}>
                <legend className="sr-only">Adjudication fields</legend>
                <div className="field">
                  <label className="form-label" htmlFor="disposition">
                    Disposition
                  </label>
                  <select
                    id="disposition"
                    value={input.status}
                    onChange={(e) =>
                      update({ status: e.target.value as AdjudicationInput['status'] })
                    }
                  >
                    <option value="RESOLVED">Resolved — assign a final classification</option>
                    <option value="UNRESOLVED_ESCALATED">
                      Unresolved — escalate without a classification
                    </option>
                  </select>
                </div>
                {input.status === 'RESOLVED' ? (
                  <div className="decision-list">
                    {decisions.map((option) => (
                      <label
                        aria-label={option.label}
                        className={`decision-option ${input.decision === option.value ? 'chosen' : ''}`}
                        key={option.value}
                      >
                        <input
                          type="radio"
                          name="adjudication-decision"
                          required
                          checked={input.decision === option.value}
                          onChange={() => update({ decision: option.value })}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="notice warning">
                    This records an unresolved escalation with no classification. It does not
                    substitute an “insufficient information” decision.
                  </div>
                )}
                {input.status === 'RESOLVED' && input.decision === 'CONTEXT_DEPENDENT' && (
                  <ContextFields
                    value={input.context}
                    onChange={(context) => update({ context })}
                  />
                )}
                <div className="field">
                  <label className="form-label" htmlFor="adjudication-rationale">
                    Rationale <span className="required">Required</span>
                  </label>
                  <textarea
                    id="adjudication-rationale"
                    required
                    value={input.rationale}
                    onChange={(e) => update({ rationale: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="adjudication-basis">
                    Basis for resolution or escalation <span className="required">Required</span>
                  </label>
                  <textarea
                    id="adjudication-basis"
                    required
                    value={input.basis}
                    onChange={(e) => update({ basis: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="form-label" htmlFor="reason-code">
                    Reason code <span className="required">Required</span>
                  </label>
                  <select
                    id="reason-code"
                    required
                    value={input.reasonCode}
                    onChange={(e) => update({ reasonCode: e.target.value })}
                  >
                    <option value="">Select reason code</option>
                    {[
                      'CONSTRUCT_BOUNDARY',
                      'POLICY_RULE_INTERPRETATION',
                      'MESH_PLACEMENT_MISLEADING',
                      'TRIAL_CONTEXT',
                      'PACKET_INSUFFICIENT',
                      'MULTILABEL_OR_CROSS_AREA',
                      'OTHER',
                    ].map((value) => (
                      <option key={value} value={value}>
                        {readable(value)}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={input.uncertain}
                    onChange={(e) => update({ uncertain: e.target.checked })}
                  />
                  <span>Uncertainty remains after adjudication</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={input.packetProblem}
                    onChange={(e) => update({ packetProblem: e.target.checked })}
                  />
                  <span>There is a problem with this evidence packet</span>
                </label>
                {input.packetProblem && (
                  <div className="field">
                    <label className="form-label" htmlFor="adjudication-packet-note">
                      Packet problem details <span className="required">Required</span>
                    </label>
                    <textarea
                      id="adjudication-packet-note"
                      required
                      value={input.packetProblemNote || ''}
                      onChange={(e) => update({ packetProblemNote: e.target.value })}
                    />
                  </div>
                )}
              </fieldset>
              {confirm && !locked ? (
                <div className="confirmation">
                  <h3>Lock this adjudication?</h3>
                  <p>
                    The final disposition, rationale, and basis will become an immutable record for
                    this judgment level.
                  </p>
                  <div className="button-row">
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm(false)}
                    >
                      Keep reviewing
                    </button>
                    <button className="button" type="button" disabled={busy} onClick={submit}>
                      {busy ? 'Submitting…' : 'Confirm & lock'}
                    </button>
                  </div>
                </div>
              ) : (
                !locked && (
                  <button className="button" style={{ marginTop: 15 }}>
                    Review & submit adjudication
                    <Icon name="arrow" size={13} />
                  </button>
                )
              )}
              <p className="form-hint" style={{ marginTop: 13 }}>
                Adjudication edits are kept in this view until submission. Submit before switching
                cases or judgment levels.
              </p>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
