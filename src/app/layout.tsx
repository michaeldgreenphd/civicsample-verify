import type { Metadata } from 'next';
import './globals.css';

// Each response must receive its own CSP nonce.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'CivicSample Verify',
  description:
    'A permissioned workspace for independent human review of clinical research classifications.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
