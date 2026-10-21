import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CivicSample Verify',
  description:
    'A synthetic-only workspace for independent human review of clinical research evidence.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
