#!/usr/bin/env node
/**
 * Re-applies the fork-specific metadata after an upstream merge.
 *
 * Upstream and this fork both edit package.json, and upstream can change any
 * of these fields at any time. Running this script after every merge makes the
 * fork values deterministic instead of relying on conflict resolution.
 *
 * Usage:
 *   node .github/scripts/apply-fork-branding.mjs
 *
 * Optional environment variables:
 *   FORK_REPO         default: binbuf/twinkle-tray
 *   UPSTREAM_REPO     default: xanderfrangos/twinkle-tray
 *   UPSTREAM_VERSION  use instead of reading upstream/master:package.json
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FORK_SUFFIX = 'nightlightdarkmode';
const FORK_REPO = process.env.FORK_REPO || 'binbuf/twinkle-tray';
const UPSTREAM_REPO = process.env.UPSTREAM_REPO || 'xanderfrangos/twinkle-tray';

const changed = [];

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function readUpstreamVersion() {
  if (process.env.UPSTREAM_VERSION) {
    return process.env.UPSTREAM_VERSION;
  }

  try {
    const raw = execFileSync('git', ['show', 'upstream/master:package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw).version;
  } catch {
    return null;
  }
}

function stripForkSuffix(version) {
  return String(version || '')
    .replace(new RegExp(`-${FORK_SUFFIX}(?:-\\d+)?$`), '')
    .trim();
}

const upstreamVersion = readUpstreamVersion();
const pkg = readJson('package.json');

let baseVersion = stripForkSuffix(upstreamVersion || pkg.version);
if (!baseVersion) {
  baseVersion = stripForkSuffix(pkg.version);
}
const forkVersion = `${baseVersion}-${FORK_SUFFIX}`;

const pkgBefore = JSON.stringify(pkg);

pkg.version = forkVersion;
pkg.author = 'binbuf';

pkg.build = pkg.build || {};
pkg.build.appId = 'com.binbuf.twinkle-tray';

pkg.build.win = pkg.build.win || {};
delete pkg.build.win.legalTrademarks;
pkg.build.win.artifactName = '${productName} v${version}.${ext}';

pkg.build.appx = pkg.build.appx || {};
pkg.build.appx.publisherDisplayName = 'binbuf';
pkg.build.appx.identityName = 'binbuf.TwinkleTray';
// Same test certificate the fork has always used. It keeps AppX builds
// unsigned-compatible with the existing fork installs.
pkg.build.appx.publisher =
  'CN=AppModelSamples, OID.2.25.311729368913984317654407730594956997722=1';

if (JSON.stringify(pkg) !== pkgBefore) {
  writeJson('package.json', pkg);
  changed.push('package.json');
}

// Keep package-lock.json's root version in step with package.json.
if (fs.existsSync('package-lock.json')) {
  const lock = readJson('package-lock.json');
  const lockBefore = JSON.stringify(lock);
  lock.version = forkVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = forkVersion;
  }
  if (JSON.stringify(lock) !== lockBefore) {
    writeJson('package-lock.json', lock);
    changed.push('package-lock.json');
  }
}

// The update checker must talk to the fork, not upstream. Upstream edits this
// line regularly, so normalise it after every merge instead of conflicting.
const electronPath = 'src/electron.js';
if (fs.existsSync(electronPath)) {
  const before = fs.readFileSync(electronPath, 'utf8');
  const after = before.replace(
    /https:\/\/api\.github\.com\/repos\/[^/"'\s]+\/[^/"'\s]+\/releases/g,
    `https://api.github.com/repos/${FORK_REPO}/releases`,
  );
  if (after !== before) {
    fs.writeFileSync(electronPath, after);
    changed.push(electronPath);
  } else if (!after.includes(`api.github.com/repos/${FORK_REPO}/releases`)) {
    console.warn(
      `WARNING: ${electronPath} no longer contains a GitHub releases API URL. ` +
        `Check that the update checker still points at ${FORK_REPO}.`,
    );
  }
}

console.log(`Fork version: ${forkVersion}`);
console.log(`Upstream repo: ${UPSTREAM_REPO}`);
if (changed.length) {
  console.log(`Updated: ${changed.join(', ')}`);
} else {
  console.log('Fork branding already up to date.');
}
