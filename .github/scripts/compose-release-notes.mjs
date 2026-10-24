#!/usr/bin/env node
/**
 * Build the notes file for a mirrored fork release.
 *
 * This is intentionally done in Node instead of PowerShell: native command
 * output in PowerShell is decoded with the console code page on Windows, which
 * corrupts curly quotes and other non-ASCII characters in upstream notes.
 *
 * Environment:
 *   GITHUB_TOKEN       token with public read access
 *   GITHUB_REPOSITORY  fork slug
 *   UPSTREAM_REPO      default: xanderfrangos/twinkle-tray
 *   UPSTREAM_TAG       upstream release tag (optional)
 *   RELEASE_VERSION    fork version without leading v
 *   NOTES_FILE         destination path
 */

import fs from 'node:fs';

const UPSTREAM_REPO =
  process.env.UPSTREAM_REPO || 'xanderfrangos/twinkle-tray';
const FORK_REPO =
  process.env.GITHUB_REPOSITORY || process.env.FORK_REPO || 'binbuf/twinkle-tray';
const UPSTREAM_TAG = process.env.UPSTREAM_TAG || '';
const RELEASE_VERSION = process.env.RELEASE_VERSION || '';
const NOTES_FILE = process.env.NOTES_FILE;
const TOKEN = process.env.GITHUB_TOKEN;

if (!NOTES_FILE) {
  console.error('NOTES_FILE is required.');
  process.exit(1);
}
if (!RELEASE_VERSION) {
  console.error('RELEASE_VERSION is required.');
  process.exit(1);
}

async function getUpstreamBody() {
  if (!UPSTREAM_TAG) return '';

  const response = await fetch(
    `https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/${encodeURIComponent(UPSTREAM_TAG)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'twinkle-tray-fork-automation',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    },
  );

  if (response.status === 404) return '';
  if (!response.ok) {
    throw new Error(
      `Could not read upstream release ${UPSTREAM_TAG}: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()).body || '';
}

const upstreamBody = await getUpstreamBody();

const footerLines = [
  '---',
  '',
  'This is an unofficial fork build of [Twinkle Tray](https://github.com/xanderfrangos/twinkle-tray) with Night Light and Dark Mode additions.',
  '',
];
if (UPSTREAM_TAG) {
  footerLines.push(
    `* Upstream release: https://github.com/${UPSTREAM_REPO}/releases/tag/${UPSTREAM_TAG}`,
  );
}
footerLines.push(
  `* Fork source: https://github.com/${FORK_REPO}`,
  `* Built version: ${RELEASE_VERSION}`,
);

const footer = footerLines.join('\n');
const body = upstreamBody
  ? `${upstreamBody.trimEnd()}\n\n${footer}\n`
  : `Fork build of Twinkle Tray ${RELEASE_VERSION}.\n\n${footer}\n`;

fs.writeFileSync(NOTES_FILE, body, 'utf8');
console.log(`Wrote release notes to ${NOTES_FILE}`);
