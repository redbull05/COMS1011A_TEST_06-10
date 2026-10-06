'use strict';

const { spawn } = require('child_process');

/**
 * Run an external command and buffer its output.
 *
 * Output is collected as Buffers (avoids exec() maxBuffer surprises) and
 * capped at `maxMB` megabytes to protect the server from pathological input.
 * Interactive credential prompts are disabled so remote operations fail fast
 * with a readable error instead of hanging.
 */
function runCommand(cmd, args, { cwd, maxMB = 1024, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    const out = [];
    const errChunks = [];
    let outBytes = 0;
    let capped = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        capped = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > maxMB * 1024 * 1024) {
        capped = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`failed to run "${cmd}": ${e.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (capped) return reject(new Error(`${cmd} exceeded its resource limit (${maxMB} MB output or timeout)`));
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr });
      reject(
        new Error(
          `${cmd} ${args.slice(0, 3).join(' ')} failed (exit ${code}): ${stderr.slice(0, 800) || 'no stderr output'}`
        )
      );
    });
  });
}

/** Convenience wrapper for git with a friendlier error label. */
function runGit(args, opts) {
  return runCommand('git', args, opts);
}

module.exports = { runCommand, runGit };
