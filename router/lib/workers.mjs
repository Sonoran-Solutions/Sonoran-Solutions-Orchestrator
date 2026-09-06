// lib/workers.mjs — safe process dispatch. ORCH-058..061.
// Workers are FIXED configuration (program + argv template). There is no
// webhook-derived shell string and shell: false is always used.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Resolve a program string to an executable path. Relative paths are resolved
// against the router directory; bare names are looked up on PATH.
export function resolveProgram(program, routerDir) {
  if (program.startsWith('/')) return program;
  if (program.startsWith('./') || program.startsWith('../')) return join(routerDir, program);
  return program;
}

export function interpolateArgs(args, vars) {
  return args.map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : '')));
}

export function runWorker(worker, { program, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let settled = false; let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, timedOut: false, code: null, signal: null, stdout: out, stderr: err, error: String(e) });
    });
    child.on('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, timedOut, code, signal, stdout: out, stderr: err, error: null });
    });
  });
}
