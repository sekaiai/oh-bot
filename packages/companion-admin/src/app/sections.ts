export interface Section { key: string; label: string; path: string; description: string; writeVerb?: 'POST' | 'PUT' | 'PATCH'; destructive?: boolean; }
export const sections: Section[] = [
  { key: 'overview', label: '系统概览', path: '/admin/overview', description: '服务健康、已配置能力与实际数据统计' },
  { key: 'identities', label: '身份与角色', path: '/admin/identities', description: '可信身份绑定与角色目录' },
  { key: 'persona', label: '人格版本', path: '/admin/persona', description: '按角色查看和发布带版本校验的人格设定', writeVerb: 'POST' },
  { key: 'relationships', label: '关系事件', path: '/admin/relationships', description: '查看有来源的关系事件并提交版本化更正', writeVerb: 'POST' },
  { key: 'memory-sources', label: '记忆来源', path: '/admin/memory-sources', description: '检查来源文本、范围、审核状态和出处' },
  { key: 'memory-revisions', label: '记忆修订', path: '/admin/memory-revisions', description: '审核候选、纠正事实并保留修订审计', writeVerb: 'POST' },
  { key: 'deletions', label: '删除保护', path: '/admin/deletions', description: '查看删除日志与清理作业；永久删除需二次确认', writeVerb: 'POST', destructive: true },
  { key: 'jobs', label: '任务与运行', path: '/admin/jobs', description: '任务队列、Agent运行、工具运行、对话与回执' },
  { key: 'models', label: '模型与工具', path: '/admin/model-profiles', description: '模型配置、工具注册与Agent能力；仅显示脱敏引用', writeVerb: 'PUT' },
  { key: 'commitments', label: '提醒事项', path: '/admin/commitments', description: '查看持久化提醒、执行状态与回执', writeVerb: 'POST' },
  { key: 'permissions', label: '主动权限', path: '/admin/proactive-permissions', description: '个人和群聊授权、安静时段与版本校验', writeVerb: 'PUT' },
  { key: 'operations', label: '备份与迁移', path: '/admin/operations/status', description: '健康、备份、迁移和恢复删除日志状态', writeVerb: 'POST' }
];
