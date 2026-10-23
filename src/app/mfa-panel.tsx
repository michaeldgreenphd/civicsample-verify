'use client';

// Investigator second factor (TOTP) through Supabase Auth: enrol an authenticator app (QR code or
// manual secret) and verify a six-digit code; the server exchanges the verified session for an
// aal2 session. The database refuses investigator actions until the session carries aal2.
import { useState } from 'react';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string' ? data.error : 'The request could not be completed.',
    );
  return data as T;
}

export function MfaPanel({ enrolled, onVerified }: { enrolled: boolean; onVerified: () => void }) {
  const [enrolment, setEnrolment] = useState<{
    factorId: string;
    qrCode: string;
    qrSvg: string | null;
    secret: string;
    uri: string;
  } | null>(null);
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function enrol() {
    setBusy(true);
    setError('');
    try {
      const next = await api<{
        factorId: string;
        qrCode: string;
        qrSvg: string | null;
        secret: string;
        uri: string;
      }>('/api/mfa/enroll', { method: 'POST', body: '{}' });
      setEnrolment(next);
      setFactorId(next.factorId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/mfa/verify', { method: 'POST', body: JSON.stringify({ factorId, code }) });
      onVerified();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Second factor">
      <div className="panel-header">
        <span className="section-label">Second factor required for investigator actions</span>
      </div>
      <div className="panel-body">
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!enrolled && !enrolment && (
          <>
            <p>
              Enrol an authenticator app (for example a TOTP app on your phone). The app generates a
              six-digit code every thirty seconds; the code is verified by Supabase Auth, never
              stored here.
            </p>
            <button className="button" onClick={enrol} disabled={busy}>
              Enrol an authenticator app
            </button>
            <p className="muted" style={{ fontSize: 12 }}>
              Starting again discards any earlier enrolment that was never verified.
            </p>
          </>
        )}
        {enrolment && (
          <>
            <p>
              Scan the QR code with your authenticator app, or enter the secret manually, then enter
              the first code it shows.
            </p>
            {enrolment.qrSvg ? (
              // Auth returns the QR as raw SVG markup (validated and given a viewBox server-side);
              // rendered inline so it scales with the panel instead of overflowing it.
              <div
                role="img"
                aria-label="Authenticator enrolment QR code"
                className="mfa-qr"
                dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
              />
            ) : enrolment.qrCode ? (
              <div className="mfa-qr">
                <img src={enrolment.qrCode} alt="Authenticator enrolment QR code" />
              </div>
            ) : null}
            <p className="mfa-text">
              Manual entry secret:{' '}
              <span className="mono" data-testid="mfa-secret">
                {enrolment.secret}
              </span>
            </p>
            {enrolment.uri && (
              <p className="muted mfa-text" style={{ fontSize: 12 }}>
                Setup link (same information as the QR code):{' '}
                <span className="mono">{enrolment.uri}</span>
              </p>
            )}
          </>
        )}
        {(enrolled || enrolment) && (
          <form onSubmit={verify}>
            {enrolled && !enrolment && (
              <label className="field">
                <span className="form-label">Authenticator</span>
                <input
                  value={factorId}
                  onChange={(e) => setFactorId(e.target.value)}
                  placeholder="factor id"
                  className="mono"
                />
              </label>
            )}
            <label className="field">
              <span className="form-label">Six-digit code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
            <div className="button-row">
              <button
                className="button"
                type="submit"
                disabled={busy || code.length !== 6 || !factorId}
              >
                Verify code
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
