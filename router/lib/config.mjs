// lib/config.mjs — load router config from outside the repo; secrets via env.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const routerDir = join(fileURLToPath(import.meta.url), '..', '..'); // lib/ -> router/

function validateConfig(cfg) { if (cfg.testFixtures === true && cfg.devMode !== true) throw new Error("testFixtures require devMode"); const maxWorker = Math.max(0, ...Object.values(cfg.workers || {}).filter(w => w.createsTask || w.repair).map(w => Number(w.timeoutMs || cfg.defaultTimeoutMs || 0))); const lease = Number(cfg.leaseDurationMs ?? 86400000); if (lease <= maxWorker + 2000 + 10000) throw new Error(`leaseDurationMs must exceed worker timeout + kill grace + safety margin (got ${lease}, need > ${maxWorker + 12000})`); return cfg; }

export function loadConfig() {
  const candidates = [
    process.env.CONFIG_PATH,
    join(routerDir, 'config.local.json'),
    join(process.env.SONORAN_CONFIG_DIR || join(os.homedir(), '.config', 'sonoran'), 'router.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      return validateConfig({ ...JSON.parse(readFileSync(p, 'utf8')), __path: p, __routerDir: routerDir });
    }
  }

  // Last resort: the committed example. It contains no secrets; secrets always
  // come from the environment (githubSecretEnv / slackWebhookEnv).
  const ex = join(routerDir, 'config.example.json');
  if (existsSync(ex)) {
    console.warn('[router] no config.local.json found; using config.example.json (dev fallback)');
    return validateConfig({ ...JSON.parse(readFileSync(ex, 'utf8')), __path: ex, __routerDir: routerDir });
  }
  throw new Error('no router config found');
}
