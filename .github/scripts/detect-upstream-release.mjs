#!/usr/bin/env node
/**
 * Decide whether the newest upstream GitHub release still needs a fork release.
 *
 * A fork release is considered present when a release with the suffixed tag
 * already exists. Only the newest upstream release is mirrored; if several
 * releases were published while the automation was off, the newest one wins.
 *
 * Environment:
 *   GITHUB_TOKEN        token with public read access (github.token is enough)
 *   GITHUB_REPOSITORY   fork slug, e.g. binbuf/twinkle-tray
 *   UPSTREAM_REPO       default: xanderfrangos/twinkle-tray
 *   GITHUB_OUTPUT       set by Actions; if absent the result is printed as JSON
 */

import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const FORK_SUFFIX = 'nightlightdarkmode';
const UPSTREAM_REPO =
  process.env.UPSTREAM_REPO || 'xanderfrangos/twinkle-tray';
const FORK_REPO =
  process.env.GITHUB_REPOSITORY || process.env.FORK_REPO || 'binbuf/twinkle-tray';
const UPSTREAM_URL =
  process.env.UPSTREAM_URL || `https://github.com/${UPSTREAM_REPO}.git`;
const TOKEN = process.env.GITHUB_TOKEN;

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'twinkle-tray-fork-automation',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

function output(result) {
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(result).map(([key, value]) => {
      const safe = String(value).replace(/\r?\n/g, ' ');
      return `${key}=${safe}`;
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const releases = (await api(`/repos/${UPSTREAM_REPO}/releases?per_page=100`)) || [];
  const latest = releases
    .filter((release) => !release.draft)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];

  if (!latest) {
    output({ should_release: 'false', reason: 'upstream has no releases' });
    return;
  }

  const upstreamTag = latest.tag_name;
  const baseVersion = String(upstreamTag)
    .replace(/^v/, '')
    .replace(new RegExp(`-${FORK_SUFFIX}$`), '');

  if (!/^\d+\.\d+\.\d+/.test(baseVersion)) {
    output({
      should_release: 'false',
      reason: `unrecognised upstream tag: ${upstreamTag}`,
    });
    return;
  }

  const version = `${baseVersion}-${FORK_SUFFIX}`;
  const tag = `v${version}`;

  const existing = await api(
    `/repos/${FORK_REPO}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (existing) {
    output({
      should_release: 'false',
      reason: `fork release ${tag} already exists`,
      tag,
      version,
      upstream_tag: upstreamTag,
    });
    return;
  }

  // Make sure the code for that upstream release is actually present in the
  // commit we are about to build. The sync job runs first, so this is normally
  // satisfied. If the author tagged an old branch/commit we skip rather than
  // publish a release whose tag does not describe the built code.
  git(
    [
      'fetch',
      '--no-tags',
      UPSTREAM_URL,
      `refs/tags/${upstreamTag}:refs/upstream-tags/${upstreamTag}`,
    ],
    { allowFailure: true },
  );
  const releaseCommit = git(
    ['rev-parse', `refs/upstream-tags/${upstreamTag}^{commit}`],
    { allowFailure: true },
  );
  if (!releaseCommit) {
    output({
      should_release: 'false',
      reason: `could not resolve upstream tag ${upstreamTag}`,
      tag,
      version,
      upstream_tag: upstreamTag,
    });
    return;
  }

  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', releaseCommit, 'HEAD'],
    { stdio: 'ignore' },
  );
  if (ancestor.status !== 0) {
    output({
      should_release: 'false',
      reason: `upstream release commit ${releaseCommit} is not in fork master yet`,
      tag,
      version,
      upstream_tag: upstreamTag,
    });
    return;
  }

  output({
    should_release: 'true',
    reason: `upstream release ${upstreamTag} has not been mirrored`,
    tag,
    version,
    upstream_tag: upstreamTag,
    prerelease: latest.prerelease ? 'true' : 'false',
    title: `Twinkle Tray v${version}`,
    upstream_url: latest.html_url,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
