/**
 * worktreeNodeModulesGuard (ENG-731 AC3) — fail LOUD when backend/node_modules
 * is missing, so jest never silently resolves modules out of a sibling
 * worktree via upward directory walking.
 *
 * Loaded via jest `globalSetup` (runs in the main process before workers
 * spawn, so a throw here aborts the run instead of producing per-suite red).
 * Pure fs checks only — no dependency on node_modules itself, so it works
 * precisely when node_modules is absent.
 */
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  // rootDir === <worktree>/backend when jest runs from backend/ (globalSetup
  // resolves relative to the config file's directory... but __dirname here
  // is the guard file's own dir, which IS <rootDir> since the guard lives
  // in backend/. So rootDir = __dirname, not its parent.
  const rootDir = __dirname;
  const nmPath = path.join(rootDir, 'node_modules');
  let stat = null;
  try {
    stat = fs.lstatSync(nmPath);
  } catch {
    stat = null;
  }
  const worktreeName = path.basename(path.dirname(rootDir));
  if (!stat) {
    throw new Error(
      `[ENG-731] backend/node_modules is MISSING in worktree '${worktreeName}' ` +
        `(${rootDir}). Jest would silently resolve modules out of a sibling ` +
        `directory via upward lookup, producing misleading mass failures. ` +
        `Fix: run \`npm ci\` in ${rootDir} (or relink to the primary checkout ` +
        `per worktree-doctor.py), then re-run. Never weaken tests to bless ` +
        `this red — check the environment first.`,
    );
  }
  if (stat.isSymbolicLink() && !fs.existsSync(nmPath)) {
    throw new Error(
      `[ENG-731] backend/node_modules in worktree '${worktreeName}' is a ` +
        `DANGLING symlink (-> ${fs.readlinkSync(nmPath)}). Its donor worktree ` +
        `was likely pruned after merge. Fix: rm the link (never rm -rf, which ` +
        `follows the symlink) and \`npm ci\` in ${rootDir}, then re-run.`,
    );
  }
};
