#!/usr/bin/env node
/**
 * Merge xanderfrangos/twinkle-tray master into this fork's master and push.
 *
 * Conflict policy, in order:
 *   1. Fork-owned files (.github/workflows, FUNDING.yml, README.md) -> keep fork.
 *   2. package.json / package-lock.json -> take upstream, then re-apply fork
 *      branding with apply-fork-branding.mjs.
 *   3. Anything else -> abort and fail the workflow. Those conflicts need a
 *      human because blindly picking a side can break the feature.
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
const FORK_WORKFLOW_PATHS = ['.github/workflows', '.github/FUNDING.yml'];

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

function isWorkflowPath(path) {
  return (
    path === '.github/FUNDING.yml' || path.startsWith('.github/workflows/')
  );
}

function restoreForkWorkflows(forkSha) {
  const forkFiles = new Set(gitLines(['ls-tree', '-r', '--name-only', forkSha, '--', ...FORK_WORKFLOW_PATHS]));

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

function main() {
  git(['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'github-actions[bot]']);
  git([
    'config',
    'user.email',
    process.env.GIT_AUTHOR_EMAIL ||
      '41898282+github-actions[bot]@users.noreply.github.com',
  ]);

  const beforeSha = git(['rev-parse', 'HEAD']).stdout;
  log(`Fork before sync: ${beforeSha}`);

  git(['fetch', '--no-tags', UPSTREAM_URL, `+refs/heads/${UPSTREAM_BRANCH}:refs/remotes/upstream/${UPSTREAM_BRANCH}`]);
  const upstreamRef = `upstream/${UPSTREAM_BRANCH}`;
  const upstreamSha = git(['rev-parse', upstreamRef]).stdout;
  const upstreamVersion = JSON.parse(
    git(['show', `${upstreamRef}:package.json`]).stdout,
  ).version;
  log(`Upstream: ${upstreamSha} (${upstreamVersion})`);

  // Namespaced tags are used by detect-upstream-release.mjs and cannot collide
  // with the fork's own release tags.
  git(
    [
      'fetch',
      '--no-tags',
      UPSTREAM_URL,
      '+refs/tags/*:refs/upstream-tags/*',
    ],
    { allowFailure: true },
  );

  const merge = git(['merge', '--no-ff', '--no-edit', upstreamRef], { allowFailure: true });
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
      git(['merge', '--abort'], { allowFailure: true });
      console.error('');
      console.error('Upstream merge needs a human for these files:');
      for (const file of unresolved) console.error(`  - ${file}`);
      console.error('');
      console.error('Resolve them locally, commit, and push master. The next');
      console.error('scheduled sync will resume automatically.');
      process.exit(1);
    }

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

  const workflowDiff = gitLines(['diff', '--name-only', beforeSha, 'HEAD', '--', ...FORK_WORKFLOW_PATHS]);
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

  const afterSha = git(['rev-parse', 'HEAD']).stdout;

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
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${afterSha !== beforeSha}\nsha=${afterSha}\nupstream_sha=${upstreamSha}\nupstream_version=${upstreamVersion}\n`,
    );
  }

  log('Sync complete.');
}

main();
