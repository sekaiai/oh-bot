// Trusted automation policy: never load this module from generated changes.
export function allowedPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(x => x === '..' || x === '.')) return false;
  if (path.split('/').some(x => x === '.env' || x.startsWith('.env.') || x === 'AGENTS.md' || x === '.git' || x === '.opencode')) return false;
  if (path === 'docs/implementation/unattended-tasks.md' || path.startsWith('scripts/unattended-')) return false;
  return ['src/', 'admin/src/', 'admin/test/', 'admin/tests/', 'packages/', 'docs/implementation/'].some(prefix => path.startsWith(prefix))
    || ['package.json', 'pnpm-lock.yaml'].includes(path);
}

export function assertManifest(before, after) {
  if (JSON.stringify(before.scripts ?? {}) !== JSON.stringify(after.scripts ?? {})) throw new Error('Existing package scripts changed');
  if (before.name !== after.name || before.packageManager !== after.packageManager || JSON.stringify(before.pnpm) !== JSON.stringify(after.pnpm)) throw new Error('Package execution configuration changed');
}

export function reviewApproved(review) {
  return review?.approved === true && Array.isArray(review.findings) && review.findings.every(f =>
    f && ['minor', 'info'].includes(f.severity) && typeof f.message === 'string');
}

export function selectTask(markdown) {
  const tasks = [...markdown.matchAll(/^- \[([ xX])\] ([A-Z]\d+[a-z0-9-]*)(?:：|:)\s*(.+)$/gm)];
  const ids = tasks.map(m => m[2]);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate task IDs');
  const next = tasks.find(m => m[1] === ' ');
  return next ? {id:next[2], text:next[3], line:next[0]} : null;
}

export function publicationTarget(state) {
  if (!state.safe || !state.changed) return 'none';
  return state.verified && state.reviewed && state.baseline === state.current ? 'target' : 'retry';
}

export function errorFeedback(error, env) {
  let message=[error.stdout,error.stderr].filter(x=>x && String(x).trim()).map(String).join('\n');
  if(!message) message=String(error.message || error);
  message=message.slice(-14000);
  for(const [key,value] of Object.entries(env)) if(/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value?.length>5) message=message.split(value).join('[REDACTED]');
  return message;
}
export function retryBacklog(markdown,task) {
  return markdown.replace(task.line.replace('- [ ]','- [x]'),task.line);
}
