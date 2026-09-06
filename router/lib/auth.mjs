// lib/auth.mjs — authorization gate. ORCH-062..066.
// A random public issue must never be able to launch a worker.

export function isTrustedActor(ctx, allowlist) {
  return Array.isArray(allowlist) && allowlist.includes(ctx.actor);
}

export function hasReadyLabel(ctx, label) {
  return (ctx.labels || []).includes(label);
}

export function authorize(rule, ctx, cfg) {
  const mode = rule.authorize || 'trusted';
  const allowlist = cfg.allowlist || [];

  if (mode === 'trusted') {
    if (!isTrustedActor(ctx, allowlist)) {
      return { ok: false, reason: `actor '${ctx.actor}' is not in the trusted allowlist` };
    }
    return { ok: true };
  }

  if (mode === 'label') {
    // The authorizing signal must come from a trusted actor AND carry the label.
    if (!isTrustedActor(ctx, allowlist)) {
      return { ok: false, reason: `labeler '${ctx.actor}' is not trusted` };
    }
    if (!hasReadyLabel(ctx, cfg.requireLabel || 'agent:ready')) {
      return { ok: false, reason: `missing required '${cfg.requireLabel || 'agent:ready'}' label` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown authorize mode '${mode}'` };
}
