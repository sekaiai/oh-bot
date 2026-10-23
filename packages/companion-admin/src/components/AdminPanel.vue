<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, redactSecrets } from '../api/client';
import { listSchema } from '../api/schemas';
import { z } from 'zod';
import type { Section } from '../app/sections';

const props = defineProps<{ section: Section }>();
const loading = ref(false); const saving = ref(false); const error = ref(''); const result = ref<{ items: Record<string, unknown>[]; configured?: boolean; message?: string } | null>(null);
const selected = ref(''); const targetId = ref(''); const version = ref(''); const auditReason = ref(''); const bodyText = ref('{\n  \n}');
const routeFor = computed(() => {
  if (props.section.key === 'jobs') return selected.value === '工具运行' ? '/admin/tool-runs' : selected.value === '任务' ? '/admin/jobs' : '/admin/agent-runs';
  if (props.section.key === 'operations' && selected.value === '备份') return '/admin/backups';
  if (props.section.key === 'operations' && selected.value === '迁移') return '/admin/migrations';
  if (props.section.key === 'models' && selected.value === '工具') return targetId.value.trim() ? `/admin/tools/${encodeURIComponent(targetId.value.trim())}` : '/admin/tools';
  if (props.section.key === 'models' && selected.value === 'Agent') return targetId.value.trim() ? `/admin/agents/${encodeURIComponent(targetId.value.trim())}` : '/admin/agents';
  if (props.section.key === 'persona' && targetId.value.trim()) return `/admin/persona/${encodeURIComponent(targetId.value.trim())}`;
  if (props.section.key === 'models' && targetId.value.trim()) return `/admin/model-profiles/${encodeURIComponent(targetId.value.trim())}`;
  return props.section.path;
});
async function load() {
  if (props.section.key === 'persona' && !targetId.value.trim()) { result.value = { items: [], configured: false, message: '请先填写角色 ID，再查看人格版本。' }; return; }
  loading.value = true; error.value = ''; result.value = null;
  try { result.value = await api.get(routeFor.value, undefined, listSchema); }
  catch (e) { error.value = e instanceof Error ? e.message : '读取失败'; }
  finally { loading.value = false; }
}
async function submit() {
  let body: unknown;
  try {
    body = JSON.parse(bodyText.value);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('内容必须是 JSON 对象');
    const required: Record<string, z.ZodTypeAny> = {
      persona: z.object({ content: z.string().min(1, '人格内容不能为空') }).passthrough(),
      relationships: z.object({ personId: z.string().min(1), characterId: z.string().min(1), event: z.string().min(1), sourceIds: z.array(z.string()).min(1) }).passthrough(),
      'memory-revisions': z.object({ sourceId: z.string().min(1), action: z.enum(['approve', 'correct', 'reject']), correction: z.string().optional() }).passthrough(),
      deletions: z.object({ scope: z.string().min(1), confirm: z.literal(true) }).passthrough(),
      models: z.object({ label: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), secretRef: z.string().min(1) }).passthrough(),
      agents: z.object({ enabled: z.boolean(), settings: z.record(z.string(), z.unknown()).optional() }).passthrough(),
      commitments: z.object({ personId: z.string().min(1), characterId: z.string().min(1), text: z.string().min(1), dueAt: z.string().datetime(), scope: z.string().min(1) }).passthrough(),
      permissions: z.object({ personId: z.string().min(1), scope: z.string().min(1), enabled: z.boolean() }).passthrough(),
      operations: z.object({ action: z.enum(['create', 'verify', 'restore', 'inspect', 'backup', 'apply']) }).passthrough()
    };
    const schema = required[props.section.key]; if (schema) { const checked = schema.safeParse(body); if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? '必填字段不完整'); }
  }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : 'JSON 格式不正确'); return; }
  if (!auditReason.value.trim()) { ElMessage.warning('请填写操作原因，便于审计追踪'); return; }
  if (version.value.trim()) (body as Record<string, unknown>).expectedVersion = Number(version.value);
  (body as Record<string, unknown>).auditReason = auditReason.value.trim();
  const operation = (body as Record<string, unknown>).action;
  if (props.section.destructive || operation === 'restore' || operation === 'apply') {
    try { await ElMessageBox.confirm('此操作可能永久删除记忆内容，且不能撤销。请确认目标与范围正确。', '确认删除操作', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消', distinguishCancelAndClose: true }); }
    catch { return; }
  }
  saving.value = true;
  try { await api.request(routeFor.value, props.section.writeVerb ?? 'POST', body); ElMessage.success('操作已提交'); await load(); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '提交失败'); }
  finally { saving.value = false; }
}
async function act(action: 'approve' | 'reject' | 'forget', item: Record<string, unknown>) {
  const id = String(item.id ?? item.sourceId ?? item.revisionId ?? ''); if (!id) { ElMessage.warning('记录缺少可操作的 ID'); return; }
  if (action === 'forget') { try { await ElMessageBox.confirm('这会启动永久遗忘流程，并记录审计。继续吗？', '确认遗忘', { type: 'warning' }); } catch { return; } }
  try {
    const body = { sourceId: id, revisionId: id, action, expectedVersion: Number(item.version ?? 0), auditReason: `管理端${action}` };
    if (props.section.key === 'memory-sources') await api.post('/admin/memory-revisions', body);
    else await api.post(`/admin/memory-revisions/${encodeURIComponent(id)}/${action}`, body);
    ElMessage.success('已提交'); await load();
  }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '操作失败'); }
}
watch([() => props.section.key, routeFor], load); onMounted(load);
function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, /^(?:secret|api.?key|password|credential|token|.*secret.*)$/i.test(key) ? (key.toLowerCase().includes('ref') ? '[引用已隐藏]' : '[已隐藏]') : safeValue(nested)]));
  return value;
}
function display(value: unknown, key = ''): string { if (/^(?:secret|api.?key|password|credential|token|.*secret.*)$/i.test(key)) return key.toLowerCase().includes('ref') ? '[引用已隐藏]' : '[已隐藏]'; const safe = safeValue(value); if (safe === null || safe === undefined) return '—'; if (typeof safe === 'object') return JSON.stringify(safe); return String(safe); }
function columns(item: Record<string, unknown>): string[] { return Object.keys(item); }
</script>

<template>
  <section class="panel">
    <div class="panel-head"><div><h1>{{ section.label }}</h1><p>{{ section.description }}</p></div><el-button :loading="loading" @click="load">刷新</el-button></div>
    <div v-if="section.key === 'jobs' || section.key === 'operations' || section.key === 'models'" class="subnav">
      <el-button v-for="name in (section.key === 'jobs' ? ['Agent运行', '工具运行', '任务'] : section.key === 'operations' ? ['健康状态', '备份', '迁移'] : ['模型', '工具', 'Agent'])" :key="name" :type="(selected || (section.key === 'jobs' ? 'Agent运行' : section.key === 'operations' ? '健康状态' : '模型')) === name ? 'primary' : 'default'" @click="selected = name">{{ name }}</el-button>
    </div>
    <el-form v-if="section.key === 'persona' || section.key === 'models'" inline class="target-form">
      <el-form-item :label="section.key === 'persona' ? '角色 ID' : '配置 ID'"><el-input v-model="targetId" :placeholder="section.key === 'persona' ? '输入角色 ID 后读取版本' : '输入模型/工具/Agent ID'" @keyup.enter="load" /></el-form-item><el-button @click="load">读取</el-button>
    </el-form>
    <el-alert v-if="error" type="error" show-icon :closable="false" :title="error" description="请检查管理服务连接与权限后重试。" />
    <el-skeleton v-else-if="loading && !result" :rows="5" animated />
    <el-alert v-else-if="result && result.configured === false" type="warning" show-icon :closable="false" title="此能力尚未配置" :description="result.message || '当前环境没有返回可用配置。'" />
    <template v-else-if="result">
      <el-alert v-if="result.message" type="info" :closable="false" :title="result.message" />
      <el-empty v-if="result.items.length === 0" description="当前没有可显示的记录" />
      <div v-else class="records">
        <article v-for="(item, i) in result.items" :key="String(item.id ?? item.version ?? i)" class="record">
          <div v-for="key in columns(item)" :key="key" class="field"><span>{{ key }}</span><strong>{{ display(item[key]) }}</strong></div>
          <div v-if="section.key === 'memory-revisions' || section.key === 'memory-sources'" class="actions"><el-button size="small" type="success" @click="act('approve', item)">通过候选</el-button><el-button size="small" type="warning" @click="act('reject', item)">退回修正</el-button><el-button size="small" type="danger" @click="act('forget', item)">遗忘</el-button></div>
        </article>
      </div>
    </template>
    <el-divider v-if="section.writeVerb" content-position="left">提交版本化操作</el-divider>
    <el-form v-if="section.writeVerb" label-position="top" class="editor" @submit.prevent="submit">
      <el-form-item label="操作内容（JSON）"><el-input v-model="bodyText" type="textarea" :rows="5" aria-label="操作内容 JSON" /></el-form-item>
      <el-form-item label="期望版本（防止覆盖新修改）"><el-input v-model="version" type="number" placeholder="按接口要求填写" /></el-form-item>
      <el-form-item label="操作原因（写入审计）"><el-input v-model="auditReason" maxlength="240" placeholder="例如：修正经用户确认的事实" /></el-form-item>
      <el-button type="primary" :loading="saving" :disabled="result?.configured === false" @click="submit">提交</el-button>
      <p class="hint">凭据字段只展示服务端脱敏引用。页面不会保存输入内容到浏览器存储。</p>
    </el-form>
  </section>
</template>
