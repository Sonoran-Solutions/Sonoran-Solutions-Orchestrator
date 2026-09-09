// lib/events.mjs — normalize a raw GitHub delivery into a bounded event context.
// ORCH-050: a single normalized context with every field the router may act on.
export function normalize(headers, body) {
  const pr = body.pull_request;
  const issue = body.issue;
  const comment = body.comment;
  const labels = (pr?.labels || issue?.labels || [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);
  if (body.label?.name) labels.push(body.label.name);
  const ref = body.ref || pr?.head?.ref || '';

  return {
    deliveryId: String(headers['x-github-delivery'] || ''),
    triggerLabel: String(body.label?.name || ''),
    event: String(headers['x-github-event'] || ''),
    action: String(body.action || ''),
    repo: String(body.repository?.full_name || ''),
    issueNumber: issue?.number ?? pr?.number ?? null,
    prNumber: pr?.number ?? null,
    actor: String(body.sender?.login || ''),
    branch: String(ref).replace(/^refs\/heads\//, ''),
    headSha: String(body.after || pr?.head?.sha || ''),
    baseSha: String(body.before || pr?.base?.sha || ''),
    baseRef: String(pr?.base?.ref || ''),
    labels,
    ref,
    title: String(pr?.title || issue?.title || ''),
    bodyText: String(pr?.body || issue?.body || comment?.body || ''),
  };
}

// The template vars workers are allowed to interpolate. Everything else is
// derived from these validated fields — never from raw/unbounded body content.
export function templateVars(ctx, extra = {}) {
  return {
    repo: ctx.repo,
    branch: ctx.branch,
    event: ctx.event,
    action: ctx.action,
    actor: ctx.actor,
    issue: ctx.issueNumber != null ? String(ctx.issueNumber) : '',
    task: ctx.task || ctx.title || ctx.issueNumber || ctx.branch || 'task',
    link: ctx.link || '',
    head: ctx.headSha,
    base: ctx.baseSha,
    ...extra,
  };
}
