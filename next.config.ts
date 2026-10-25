import type { NextConfig } from 'next';
import { resolveBuildIdentity } from './scripts/build-identity.mjs';
const config: NextConfig = {
  poweredByHeader: false,
  // The source commit is captured when the build starts and inlined into the artifact; a
  // deployment may still supply VERIFY_APP_GIT_SHA explicitly (see src/server/tlv5.ts).
  env: { VERIFY_BUILD_GIT_SHA: resolveBuildIdentity() },
  // Local runtime state is never part of a deployable application package.
  outputFileTracingExcludes: {
    '**': [
      './.git',
      './.git/**/*',
      './.local/**/*',
      './.data/**/*',
      './data_private/**/*',
      './private/**/*',
      './artifacts/**/*',
      './.env*',
    ],
  },
  serverExternalPackages: ['@electric-sql/pglite'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
