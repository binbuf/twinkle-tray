#!/usr/bin/env node
/**
 * Merge xanderfrangos/twinkle-tray master into this fork's master and push.
 *
 * Conflict policy, in order:
 *   1. Fork-owned files (.github/workflows, FUNDING.yml, README.md) -> keep fork.
 *   2. package.json / package-lock.json -> take upstream, then re-apply fork
 *      branding with apply-fork-branding.mjs.
 *   3. Anything else -> do not touch master. Commit the attempted merge to a
 *      sync-upstream-conflict branch and open a PR for manual review.
 *
 * A second safety net verifies that the Night Light / Dark Mode feature is
 * still present after the merge. If upstream refactors a file the feature
 * depends on, master is left alone and the review PR is opened instead.
 *
 * Workflow files are always restored to the fork versions before the commit is
 * pushed. This is deliberate: GitHub's GITHUB_TOKEN cannot push a commit that
 * adds or edits anything under .github/workflows/. Because the merge commit is
 * made to contain no workflow changes, the sync does not need a PAT.
 */

import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const UPSTREAM_URL =
  process.env.UPSTREAM_URL || 'https://github.com/xanderfrangos/twinkle-tray.git';
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH || 'master';
const FORK_BRANCH = process.env.FORK_BRANCH || 'master';
const CONFLICT_BRANCH = process.env.CONFLICT_BRANCH || 'sync-upstream-conflict';
const REPO = process.env.GITHUB_REPOSITORY || 'binbuf/twinkle-tray';
const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const RUN_URL = process.env.GITHUB_RUN_ID
  ? `${SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : '';
const FORK_WORKFLOW_PATHS = ['.github/workflows', '.github/FUNDING.yml'];

// These are the load-bearing pieces of the fork feature. If upstream removes
// or renames one of them, the merge may be syntactically clean but the feature
// would silently disappear. In that case we open the review PR instead of
// pushing to master.
const FEATURE_CHECKS = [
  {
    label: 'Night Light module',
    file: 'src/NightLight.js',
  },
  {
    label: 'registry watcher native module',
    file: 'src/modules/tt-windows-utils/windows_registry_watch.cc',
  },
  {
    label: 'Night Light main-process wiring',
    file: 'src/electron.js',
    includes: ["require('./NightLight')", 'night-light-updated'],
  },
  {
    label: 'Night Light panel',
    file: 'src/components/BrightnessPanel.jsx',
    includes: ['nightLight'],
  },
  {
    label: 'Night Light settings',
    file: 'src/components/SettingsWindow.jsx',
    includes: ['showNightLight'],
  },
  {
    label: 'Night Light preload bridge',
    file: 'src/panel-preload.js',
    includes: ['request-night-light', 'set-night-light'],
  },
  {
    label: 'registry watcher export',
    file: 'src/modules/tt-windows-utils/index.js',
    includes: ['RegistryWatcher'],
  },
];

function log(message) {
  console.log(message);
}

function git(args, { allowFailure = false, stdio = 'pipe' } = {}) {
  try {
    const output = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: (output || '').trim() };
  } catch (error) {
    const stdout = String(error.stdout || '').trim();
    const stderr = String(error.stderr || '').trim();
    if (allowFailure) {
      return { status: error.status || 1, stdout, stderr };
    }
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    throw error;
  }
}

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  if (result.status !== 0) {
    if (allowFailure) {
      return { status: result.status || 1, stdout, stderr };
    }
    console.error(stderr);
    throw new Error(`gh ${args.join(' ')} failed`);
  }

  return { status: 0, stdout, stderr };
}

function gitLines(args, options) {
  return git(args, options)
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isForkOwned(path) {
  return (
    path === 'README.md' ||
    path === '.github/FUNDING.yml' ||
    path.startsWith('.github/workflows/')
  );
}

function isUpstreamOwned(path) {
  return path === 'package.json' || path === 'package-lock.json';
}

function restoreForkWorkflows(forkSha) {
  const forkFiles = new Set(
    gitLines(['ls-tree', '-r', '--name-only', forkSha, '--', ...FORK_WORKFLOW_PATHS]),
  );

  // Remove workflow files that only exist because upstream added them.
  const currentFiles = gitLines(['ls-files', '--', ...FORK_WORKFLOW_PATHS]);
  for (const file of currentFiles) {
    if (!forkFiles.has(file)) {
      git(['rm', '-f', '--ignore-unmatch', '--', file], { allowFailure: true });
    }
  }

  // Restore the fork versions of every file that exists in both places.
  git(['checkout', forkSha, '--', ...FORK_WORKFLOW_PATHS], { allowFailure: true });

  // Stage additions/modifications/deletions so the caller can commit them.
  git(['add', '-A', '--', ...FORK_WORKFLOW_PATHS]);
}

function verifyForkFeatures() {
  const problems = [];

  for (const check of FEATURE_CHECKS) {
    if (!fs.existsSync(check.file)) {
      problems.push(`${check.label}: missing ${check.file}`);
      continue;
    }

    if (check.includes) {
      const contents = fs.readFileSync(check.file, 'utf8');
      for (const needle of check.includes) {
        if (!contents.includes(needle)) {
          problems.push(`${check.label}: ${check.file} no longer contains "${needle}"`);
        }
      }
    }
  }

  return problems;
}

function openConflictPr(reasons) {
  if (process.env.SYNC_SKIP_PUSH === '1') {
    log('SYNC_SKIP_PUSH=1; skipping the conflict branch push and PR.');
    return;
  }

  const existing = gh(
    [
      'pr',
      'list',
      '--repo',
      REPO,
      '--head',
      CONFLICT_BRANCH,
      '--state',
      'open',
      '--json',
      'number',
      '--jq',
      '.[0].number',
    ],
    { allowFailure: true },
  );
  const prNumber = existing.stdout && existing.stdout !== 'null' ? existing.stdout : '';

  if (prNumber) {
    // Never force-push over a PR the user may already be editing. Add the
    // latest findings as a comment instead.
    gh(
      [
        'pr',
        'comment',
        prNumber,
        '--repo',
        REPO,
        '--body',
        `Another scheduled sync still needs review:\n\n${reasons.join('\n')}${
          RUN_URL ? `\n\nRun: ${RUN_URL}` : ''
        }`,
      ],
      { allowFailure: true },
    );
    log(`Conflict PR #${prNumber} is already open; added the latest details.`);
    return;
  }

  const push = git(['push', '--force', 'origin', `HEAD:refs/heads/${CONFLICT_BRANCH}`], {
    allowFailure: true,
  });
  if (push.status !== 0) {
    if (push.stdout) console.error(push.stdout);
    if (push.stderr) console.error(push.stderr);
    console.error(`Could not push ${CONFLICT_BRANCH}.`);
    return;
  }

  const body = [
    `Automated merge of \`xanderfrangos/twinkle-tray@${process.env.SYNC_UPSTREAM_SHA || 'master'}\` into \`${FORK_BRANCH}\` needs review.`,
    '',
    '## What needs attention',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    '## How to resolve',
    '',
    `This branch contains the attempted merge. If there are conflict markers, resolve them in the PR and merge it (or push the same resolution to \`${FORK_BRANCH}\`). If the feature check failed, update the feature integration in this branch and merge it.`,
    '',
    `The next scheduled sync will keep running, but it will not push to \`${FORK_BRANCH}\` while this work is outstanding.`,
    ...(RUN_URL ? ['', `Failed run: ${RUN_URL}`] : []),
  ].join('\n');

  const created = gh(
    [
      'pr',
      'create',
      '--repo',
      REPO,
      '--base',
      FORK_BRANCH,
      '--head',
      CONFLICT_BRANCH,
      '--title',
      'Upstream sync needs conflict resolution',
      '--body',
      body,
    ],
    { allowFailure: true },
  );

  if (created.status !== 0) {
    console.error(created.stderr);
    console.error(`Pushed ${CONFLICT_BRANCH}, but could not open the PR.`);
    return;
  }

  log(`Opened conflict PR: ${created.stdout}`);
}

function commentOnStaleConflictPr() {
  if (process.env.SYNC_SKIP_PUSH === '1') return;

  const existing = gh(
    [
      'pr',
      'list',
      '--repo',
      REPO,
      '--head',
      CONFLICT_BRANCH,
      '--state',
      'open',
      '--json',
      'number',
      '--jq',
      '.[0].number',
    ],
    { allowFailure: true },
  );
  const prNumber = existing.stdout && existing.stdout !== 'null' ? existing.stdout : '';
  if (!prNumber) return;

  gh(
    [
      'pr',
      'comment',
      prNumber,
      '--repo',
      REPO,
      '--body',
      `A scheduled sync now merges upstream cleanly. This conflict PR can be closed if you no longer need it.`,
    ],
    { allowFailure: true },
  );
  log(`Conflict PR #${prNumber} is now stale; added a comment instead of closing it.`);
}

function main() {
  git(['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'github-actions[bot]']);
  git([
    'config',
    'user.email',
    process.env.GIT_AUTHOR_EMAIL ||
      '41898282+github-actions[bot]@users.noreply.github.com',
  ]);

  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout;
  if (dirty) {
    console.error('Working tree has uncommitted changes; refusing to sync.');
    console.error(dirty);
    process.exit(1);
  }

  const beforeSha = git(['rev-parse', 'HEAD']).stdout;
  log(`Fork before sync: ${beforeSha}`);

  git([
    'fetch',
    '--no-tags',
    UPSTREAM_URL,
    `+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/upstream/${UPSTREAM_BRANCH}`,
  ]);
  const upstreamRef = `upstream/${UPSTREAM_BRANCH}`;
  const upstreamSha = git(['rev-parse', upstreamRef]).stdout;
  const upstreamVersion = JSON.parse(
    git(['show', `${upstreamRef}:package.json`]).stdout,
  ).version;
  log(`Upstream: ${upstreamSha} (${upstreamVersion})`);
  process.env.SYNC_UPSTREAM_SHA = upstreamSha;

  // Namespaced tags are used by detect-upstream-release.mjs and cannot collide
  // with the fork's own release tags.
  git(
    ['fetch', '--no-tags', UPSTREAM_URL, '+refs/tags/*:refs/upstream-tags/*'],
    { allowFailure: true },
  );

  const reviewReasons = [];
  const merge = git(['merge', '--no-ff', '--no-edit', upstreamRef], {
    allowFailure: true,
  });
  if (merge.stdout) log(merge.stdout);
  if (merge.stderr) console.error(merge.stderr);

  if (merge.status !== 0) {
    const conflicts = gitLines(['diff', '--name-only', '--diff-filter=U']);
    if (!conflicts.length) {
      console.error('git merge failed without reporting conflicts.');
      process.exit(1);
    }

    log(`Conflicts: ${conflicts.join(', ')}`);

    const unresolved = [];
    for (const file of conflicts) {
      if (isForkOwned(file)) {
        log(`  ${file}: keeping fork version`);
        git(['checkout', '--ours', '--', file]);
        git(['add', '--', file]);
      } else if (isUpstreamOwned(file)) {
        log(`  ${file}: taking upstream version (fork branding re-applied later)`);
        git(['checkout', '--theirs', '--', file]);
        git(['add', '--', file]);
      } else {
        unresolved.push(file);
      }
    }

    if (unresolved.length) {
      reviewReasons.push(`Merge conflicts need resolution: ${unresolved.join(', ')}`);
      log('Committing the attempted merge with conflict markers for review...');
    }

    // If there are unresolved files their conflict markers are staged too, so
    // this commits the merge without ever pushing it to master.
    git(['add', '-A']);
    git(['commit', '--no-edit']);
  }

  // Keep workflow files byte-for-byte identical to the fork's pre-merge copy.
  // This is what lets a normal GITHUB_TOKEN push succeed.
  restoreForkWorkflows(beforeSha);
  const stagedWorkflows = git([
    'diff',
    '--cached',
    '--name-only',
    '--',
    ...FORK_WORKFLOW_PATHS,
  ]).stdout;
  if (stagedWorkflows) {
    // A separate commit is intentional. Amending a merge commit here has
    // proven unreliable in detached checkouts, and the extra commit is
    // harmless.
    git(['commit', '-m', 'Keep fork workflows']);
  }

  const workflowDiff = gitLines([
    'diff',
    '--name-only',
    beforeSha,
    'HEAD',
    '--',
    ...FORK_WORKFLOW_PATHS,
  ]);
  if (workflowDiff.length) {
    console.error('Refusing to push: workflow files still differ.');
    console.error(workflowDiff.join('\n'));
    process.exit(1);
  }

  const branding = spawnSync(
    process.execPath,
    ['.github/scripts/apply-fork-branding.mjs'],
    {
      env: { ...process.env, UPSTREAM_VERSION: upstreamVersion },
      stdio: 'inherit',
    },
  );
  if (branding.status !== 0) {
    console.error('Fork branding script failed.');
    process.exit(branding.status || 1);
  }

  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only'], { allowFailure: true }).stdout;
  if (staged) {
    git(['commit', '-m', 'Apply fork branding']);
  }

  // Safety net: verify the fork feature still exists before touching master.
  const featureProblems = verifyForkFeatures();
  if (featureProblems.length) {
    reviewReasons.push(...featureProblems.map((problem) => `Fork feature check failed: ${problem}`));
  }

  const afterSha = git(['rev-parse', 'HEAD']).stdout;

  if (reviewReasons.length) {
    console.error('');
    console.error('Upstream sync needs a human:');
    for (const reason of reviewReasons) console.error(`  - ${reason}`);
    console.error('');
    console.error(`Master was not changed. Review PR branch: ${CONFLICT_BRANCH}`);
    openConflictPr(reviewReasons);
    process.exit(1);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${afterSha !== beforeSha}\nsha=${afterSha}\nupstream_sha=${upstreamSha}\nupstream_version=${upstreamVersion}\n`,
    );
  }

  if (afterSha === beforeSha) {
    log('Already up to date; nothing to push.');
  } else if (process.env.SYNC_SKIP_PUSH === '1') {
    log(`SYNC_SKIP_PUSH=1; not pushing ${afterSha}.`);
  } else {
    const push = git(['push', 'origin', `HEAD:${FORK_BRANCH}`], { allowFailure: true });
    if (push.status !== 0) {
      if (push.stdout) console.error(push.stdout);
      if (push.stderr) console.error(push.stderr);
      console.error('Push failed. The remote may have moved; the next run will retry.');
      process.exit(1);
    }
    log(`Pushed ${afterSha} to ${FORK_BRANCH}.`);
    commentOnStaleConflictPr();
  }

  log('Sync complete.');
}

main();
