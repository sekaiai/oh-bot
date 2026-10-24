<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { z } from 'zod';
import { api, ApiError } from '../api/client';
import { parseOperationBody, responseFor, safeForDisplay, type PanelList, type PanelOperation, type PanelOverview } from '../api/panel-contract';
import type { Section } from '../app/sections';
import CharactersPanel from './CharactersPanel.vue';

const props = defineProps<{ section: Section }>();
const loading = ref(false); const saving = ref(false); const error = ref(''); const result = ref<PanelList | PanelOverview | { personId: string | null } | null>(null);
const selected = ref(props.section.key === 'identities' ? '角色目录' : props.section.key === 'jobs' ? '任务日志' : props.section.key === 'operations' ? '健康状态' : props.section.key === 'models' ? '模型配置' : ''); const targetId = ref(''); const version = ref(''); const reason = ref(''); const evidenceQuote = ref('');
let listRequestGeneration = 0; let selectedRecordOperation = ''; let profileActionGeneration = 0;
const model = ref({ name: '', provider: '', baseUrl: '', model: '', credentialRef: '', dimensions: '', maxTokens: '1024', timeoutMs: '30000', monthlyBudgetUsd: '' });
const enabled = ref(false); const settingsText = ref('{}'); const toolApiUrl = ref(''); const toolCredentialRef = ref(''); const personId = ref(''); const characterId = ref(''); const eventKind = ref('conversation'); const sourceIds = ref(''); const commitmentText = ref(''); const sourceMessageId = ref(''); const dueAt = ref(''); const scope = ref(''); const conversationId = ref(''); const quietStart = ref(''); const quietEnd = ref(''); const timeZone = ref('UTC'); const maxPerDay = ref('1');
const factText = ref(''); const reviewMode = ref<'approve' | 'correct'>('approve');
const personaContent = ref(''); const backupAction = ref('verify'); const backupId = ref(''); const migrationAction = ref('inspect'); const sourceId = ref('');
const route = computed(() => {
  switch (props.section.key) {
    case 'overview': return { path: '/admin/overview', operation: 'overview' as PanelOperation };
    case 'identities': return selected.value === '身份绑定' ? { path: '/admin/identities', operation: 'identities' as PanelOperation } : null;
    case 'persona': return targetId.value ? { path: `/admin/persona/${encodeURIComponent(targetId.value)}`, operation: 'persona' as PanelOperation } : null;
    case 'relationships': return { path: '/admin/relationships', operation: 'relationships' as PanelOperation };
    case 'memory-sources': return { path: '/admin/memory-sources', operation: 'memory-sources' as PanelOperation };
    case 'memory-revisions': return { path: '/admin/memory-revisions', operation: 'memory-revisions' as PanelOperation };
    case 'deletions': return { path: '/admin/deletions', operation: 'deletions' as PanelOperation };
    case 'jobs': return selected.value === '工具运行' ? { path: '/admin/tool-runs', operation: 'tool-runs' as PanelOperation } : selected.value === 'Agent运行' ? { path: '/admin/agent-runs', operation: 'agent-runs' as PanelOperation } : selected.value === '对话回合' ? { path: '/admin/turns', operation: 'turns' as PanelOperation } : selected.value === '发送回执' ? { path: '/admin/deliveries', operation: 'deliveries' as PanelOperation } : { path: '/admin/job-logs', operation: 'jobs' as PanelOperation };
    case 'models': return selected.value === '工具' ? { path: '/admin/tools', operation: 'tools' as PanelOperation } : selected.value === 'Agent' ? { path: '/admin/agents', operation: 'agents' as PanelOperation } : { path: '/admin/model-profiles', operation: 'model-profiles' as PanelOperation };
    case 'commitments': return { path: '/admin/commitments', operation: 'commitments' as PanelOperation };
    case 'permissions': return { path: '/admin/proactive-permissions', operation: 'permissions' as PanelOperation };
    case 'operations': return selected.value === '备份' ? { path: '/admin/backups', operation: 'backups' as PanelOperation } : selected.value === '迁移' ? { path: '/admin/migrations', operation: 'migrations' as PanelOperation } : { path: '/admin/operations/status', operation: 'operations' as PanelOperation };
    default: return null;
  }
});
const overview = computed(() => props.section.key === 'overview' && result.value && 'health' in result.value);
const overviewData = computed(() => overview.value ? result.value as PanelOverview : null);
const listResult = computed(() => result.value && 'items' in result.value ? result.value as PanelList : null);
const hasWriteForm = computed(() => props.section.key === 'persona' || props.section.key === 'memory-revisions' || props.section.key === 'relationships' || props.section.key === 'commitments' || props.section.key === 'permissions' || (props.section.key === 'models' && Boolean(targetId.value) && selectedRecordOperation === route.value?.operation) || (props.section.key === 'operations' && (selected.value === '备份' || selected.value === '迁移')));

function selectedItem(item: Record<string, unknown>, mode: 'approve' | 'correct' = 'approve') {
  profileActionGeneration++;
  const id = String(item.id ?? ''); targetId.value = id; version.value = String(item.version ?? ''); selectedRecordOperation = route.value?.operation ?? '';
  if (props.section.key === 'operations' && selected.value === '备份') backupId.value = String(item.backupId ?? '');
  if (props.section.key === 'operations' && selected.value === '迁移') sourceId.value = String(item.sourceId ?? '');
  if (props.section.key === 'memory-revisions') { reviewMode.value = mode; evidenceQuote.value = String(item.sourceQuote ?? item.evidenceQuote ?? ''); factText.value = String(item.factText ?? item.claimText ?? ''); }
  personId.value = String(item.personId ?? ''); characterId.value = String(item.characterId ?? ''); conversationId.value = String(item.conversationId ?? '');
  scope.value = String(item.scope ?? (conversationId.value ? 'group' : 'person')); enabled.value = scope.value === 'group' ? Boolean(item.proactiveEnabled ?? item.enabled) : Boolean(item.enabled);
  quietStart.value = String(item.quietStart ?? ''); quietEnd.value = String(item.quietEnd ?? ''); timeZone.value = String(item.timeZone ?? 'UTC'); maxPerDay.value = String(item.maxPerDay ?? '1');
  if (props.section.key === 'models') {
    model.value = { name: String(item.name ?? ''), provider: String(item.provider ?? ''), baseUrl: String(item.baseUrl ?? ''), model: String(item.model ?? ''), credentialRef: String(item.credentialRef ?? ''), dimensions: item.dimensions == null ? '' : String(item.dimensions), maxTokens: String(item.maxTokens ?? 1024), timeoutMs: String(item.timeoutMs ?? 30000), monthlyBudgetUsd: item.monthlyBudgetUsd == null ? '' : String(item.monthlyBudgetUsd) };
    if (selected.value === '工具') {
      const settings = item.settings && typeof item.settings === 'object' && !Array.isArray(item.settings) ? item.settings as Record<string, unknown> : {};
      toolApiUrl.value = String(settings.apiUrl ?? ''); toolCredentialRef.value = String(settings.credentialRef ?? '');
    }
  }
  if (props.section.key === 'memory-revisions') evidenceQuote.value = String(item.sourceQuote ?? item.evidenceQuote ?? '');
}
function resetEditor() {
  selectedRecordOperation = ''; targetId.value = ''; version.value = ''; reason.value = ''; evidenceQuote.value = ''; factText.value = ''; enabled.value = false; settingsText.value = '{}'; toolApiUrl.value = ''; toolCredentialRef.value = '';
  personId.value = ''; characterId.value = ''; conversationId.value = ''; scope.value = ''; quietStart.value = ''; quietEnd.value = ''; timeZone.value = 'UTC'; maxPerDay.value = '1';
  backupId.value = ''; sourceId.value = ''; sourceMessageId.value = '';
  model.value = { name: '', provider: '', baseUrl: '', model: '', credentialRef: '', dimensions: '', maxTokens: '1024', timeoutMs: '30000', monthlyBudgetUsd: '' };
}
async function load() {
  const generation = ++listRequestGeneration; const requestRoute = route.value;
  if (props.section.key === 'identities' && selected.value !== '身份绑定') { result.value = { items: [] }; loading.value = false; return; }
  if (!requestRoute) { result.value = { items: [], configured: false, message: '请先选择或填写目标 ID。' }; loading.value = false; return; }
  loading.value = true; error.value = ''; result.value = null;
  try {
    const response = await api.get(requestRoute.path);
    if (generation !== listRequestGeneration || route.value?.path !== requestRoute.path) return;
    result.value = responseFor(requestRoute.operation, response);
  }
  catch (e) { if (generation === listRequestGeneration && route.value?.path === requestRoute.path) error.value = e instanceof Error ? e.message : '读取失败'; }
  finally { if (generation === listRequestGeneration) loading.value = false; }
}
async function confirmDestructive(title: string): Promise<boolean> {
  try { await ElMessageBox.confirm(title, '确认操作', { type: 'warning', confirmButtonText: '确认执行', cancelButtonText: '取消' }); return true; }
  catch { return false; }
}
async function requestAuditReason(): Promise<string | null> {
  try { const result = await ElMessageBox.prompt('请输入操作原因，服务端会记录审计。', '审计说明', { inputType: 'textarea', inputValidator: (value) => (value?.trim().length ?? 0) >= 8 || '操作原因至少需要 8 个字符', confirmButtonText: '继续', cancelButtonText: '取消' }); return result.value.trim(); }
  catch { return null; }
}
async function profileAction(item: Record<string, unknown>, action: 'test' | 'enabled') {
  const id = String(item.id ?? ''); const profileVersion = Number(item.version); const purpose = String(item.purpose ?? '');
  if (!id || !Number.isInteger(profileVersion) || profileVersion < 1) { ElMessage.error('模型配置缺少有效 ID 或版本号'); return; }
  if (action === 'test' && (item.provider !== 'openai' || !['chat', 'memory', 'search'].includes(purpose))) return;
  const routePath = route.value?.path; const generation = profileActionGeneration;
  const current = () => generation === profileActionGeneration && route.value?.path === routePath && selected.value === '模型配置' && props.section.key === 'models';
  let body: unknown; let path: string; let method: string;
  try {
    if (action === 'test') { method = 'POST'; path = `/admin/model-profiles/${encodeURIComponent(id)}/test`; body = parseOperationBody('model-test', { version: profileVersion }); }
    else {
      const auditReason = await requestAuditReason();
      if (!auditReason || !current()) return;
      method = 'PUT'; path = `/admin/model-profiles/${encodeURIComponent(id)}/enabled`;
      body = parseOperationBody('model-enabled', { version: profileVersion, enabled: !Boolean(item.enabled), auditReason });
    }
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : '模型操作内容不合法'); return; }
  saving.value = true;
  try {
    const response = await api.request(path, method, body, z.record(z.string(), z.unknown()));
    if (!current()) return;
    if (action === 'test' && response.lastTestStatus === 'failed') ElMessage.error('模型测试未通过，请检查凭据、价格与服务配置');
    else if (action === 'test' && response.lastTestStatus !== 'passed') ElMessage.error('模型测试结果无效，请刷新后重试');
    else ElMessage.success(action === 'test' ? '模型测试已完成' : '模型启用状态已更新');
    await load();
  } catch (e) {
    if (current()) ElMessage.error(e instanceof ApiError && e.status === 409 ? `记录已发生版本冲突（409 ${e.message}），请刷新后重新提交。` : e instanceof Error ? e.message : '模型操作失败');
  } finally { saving.value = false; }
}
async function forgetRevision(item: Record<string, unknown>) {
  const revisionId = String(item.id ?? ''); const expectedVersion = Number(item.version);
  if (!revisionId || !Number.isInteger(expectedVersion) || expectedVersion < 1) { ElMessage.error('此修订缺少有效 ID 或版本号'); return; }
  const auditReason = await requestAuditReason(); if (!auditReason) return;
  if (!await confirmDestructive('遗忘会立即隐藏相关事实并安排删除处理。请确认来源和范围。')) return;
  try { await api.post(`/admin/memory-revisions/${encodeURIComponent(revisionId)}/forget`, parseOperationBody('memory-forget', { expectedVersion, auditReason, confirm: true }), z.record(z.string(), z.unknown())); ElMessage.success('遗忘请求已提交'); await load(); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '遗忘请求失败'); }
}
async function forgetSource(item: Record<string, unknown>) {
  const sourceId = String(item.id ?? ''); const scope = String(item.scope ?? '');
  if (!sourceId || !scope) { ElMessage.error('来源缺少 ID 或范围'); return; }
  const auditReason = await requestAuditReason(); if (!auditReason) return;
  if (!await confirmDestructive('删除请求会为所选来源建立保护记录。请确认来源与范围。')) return;
  try { await api.post('/admin/deletions', parseOperationBody('source-delete', { sourceIds: [sourceId], scope, auditReason, confirmed: true })); ElMessage.success('删除请求已提交'); await load(); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '删除请求失败'); }
}
async function correctRevision() {
  if (!targetId.value) { ElMessage.warning('请先选择一条待修正修订'); return; }
  const auditReason = await requestAuditReason(); if (!auditReason) return;
  if (!await confirmDestructive('更正会创建新的事实版本并使旧结论失效。请核对原文证据与新事实。')) return;
  let payload: unknown;
  try { payload = parseOperationBody('memory-correct', { expectedVersion: version.value, evidenceQuote: evidenceQuote.value, factText: factText.value, auditReason, confirm: true }); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '更正内容不完整'); return; }
  saving.value = true;
  try { await api.post(`/admin/memory-revisions/${encodeURIComponent(targetId.value)}/correct`, payload, z.record(z.string(), z.unknown())); ElMessage.success('更正请求已提交'); await load(); }
  catch (e) { ElMessage.error(e instanceof ApiError && e.status === 409 ? `记录已发生版本冲突（409 ${e.message}），请刷新后重新提交。` : e instanceof Error ? e.message : '更正请求失败'); }
  finally { saving.value = false; }
}
async function submit() {
  let path = ''; let method = 'POST'; let payload: unknown; let operation = '';
  try {
    if (props.section.key === 'persona') { operation = 'persona-publish'; path = `/admin/persona/${encodeURIComponent(targetId.value)}`; method = 'POST'; payload = parseOperationBody(operation, { expectedVersion: version.value, content: personaContent.value, auditReason: reason.value }); }
    else if (props.section.key === 'memory-revisions') {
      if (!targetId.value) throw new Error('请先选择一条候选修订');
      operation = 'memory-approve'; path = `/admin/memory-revisions/${encodeURIComponent(targetId.value)}/approve`; method = 'POST';
      payload = parseOperationBody(operation, { expectedVersion: version.value, claimKind: 'direct', evidenceQuote: evidenceQuote.value });
    }
    else if (props.section.key === 'models') {
      if (!targetId.value || selectedRecordOperation !== route.value?.operation) throw new Error('请先从当前标签选择要更新的记录');
      method = 'PUT';
      if (selected.value === 'Agent') { operation = 'agent-update'; path = `/admin/agents/${encodeURIComponent(targetId.value)}`; payload = parseOperationBody(operation, { expectedVersion: version.value, enabled: enabled.value, settings: JSON.parse(settingsText.value), auditReason: reason.value }); }
      else if (selected.value === '工具') { operation = 'tool-update'; path = `/admin/tools/${encodeURIComponent(targetId.value)}`; payload = parseOperationBody(operation, { expectedVersion: version.value, enabled: enabled.value, settings: { apiUrl: toolApiUrl.value, credentialRef: toolCredentialRef.value }, auditReason: reason.value }); }
      else { operation = 'model-update'; path = `/admin/model-profiles/${encodeURIComponent(targetId.value)}`; payload = parseOperationBody(operation, { ...model.value, version: version.value }); }
    }
    else if (props.section.key === 'relationships') { operation = 'relationship-create'; path = '/admin/relationships'; payload = parseOperationBody(operation, { personId: personId.value, characterId: characterId.value, event: eventKind.value, sourceIds: sourceIds.value.split(',').map((id) => id.trim()).filter(Boolean), auditReason: reason.value }); }
    else if (props.section.key === 'commitments') { operation = 'commitment-create'; path = '/admin/commitments'; payload = parseOperationBody(operation, { personId: personId.value, characterId: characterId.value, sourceMessageId: sourceMessageId.value, text: commitmentText.value, dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : '', scope: scope.value, auditReason: reason.value }); }
    else if (props.section.key === 'permissions') { operation = 'permission-update'; path = '/admin/proactive-permissions'; const fields = { characterId: characterId.value, ...(scope.value === 'person' ? { personId: personId.value } : { conversationId: conversationId.value }), scope: scope.value, enabled: enabled.value, quietStart: quietStart.value || undefined, quietEnd: quietEnd.value || undefined, timeZone: timeZone.value || undefined, maxPerDay: maxPerDay.value || undefined, expectedVersion: version.value, auditReason: reason.value }; payload = parseOperationBody(operation, fields); method = 'PUT'; }
    else if (props.section.key === 'operations' && selected.value === '备份') {
      if (!reason.value.trim()) throw new Error('请填写操作原因，便于审计追踪');
      operation = 'backup-action'; path = '/admin/backups';
      const title = backupAction.value === 'create' ? '创建操作会写入已配置的备份根目录，请确认配置范围。' : backupAction.value === 'verify' ? '请确认要校验所选备份的清单与资产。' : '恢复会写入隔离恢复目标，请确认备份目标和恢复窗口。';
      if (!await confirmDestructive(title)) return;
      payload = parseOperationBody(operation, { action: backupAction.value, ...(backupAction.value === 'create' ? {} : { backupId: backupId.value, expectedVersion: version.value }), auditReason: reason.value, confirm: true });
    }
    else if (props.section.key === 'operations' && selected.value === '迁移') {
      if (!reason.value.trim()) throw new Error('请填写操作原因，便于审计追踪');
      operation = 'migration-action'; path = '/admin/migrations';
      const title = migrationAction.value === 'inspect' ? '请确认要检查所选迁移来源的当前内容与版本。' : migrationAction.value === 'backup' ? '请确认要为所选迁移来源创建备份。' : '应用迁移会写入业务数据，请确认已完成备份并检查迁移计划。';
      if (!await confirmDestructive(title)) return;
      payload = parseOperationBody(operation, { action: migrationAction.value, sourceId: sourceId.value, ...(version.value ? { expectedVersion: version.value } : {}), auditReason: reason.value, confirm: true });
    }
    else throw new Error('当前环境暂不支持此项写入操作');
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : '表单内容不合法'); return; }
  saving.value = true;
  try { await api.request(path, method, payload, z.record(z.string(), z.unknown())); ElMessage.success('操作已提交'); await load(); }
  catch (e) { ElMessage.error(e instanceof ApiError && e.status === 409 ? `记录已发生版本冲突（409 ${e.message}），请刷新后重新提交。` : e instanceof Error ? e.message : '提交失败'); }
  finally { saving.value = false; }
}
function keys(item: Record<string, unknown>): string[] { return Object.keys(item); }
const fieldLabels: Record<string, string> = { id: '记录 ID', name: '名称', status: '状态', version: '版本或 SHA-256', expectedVersion: '预期版本', backupId: '备份 ID', sourceId: '来源 ID', sourceHash: '来源 SHA-256', manifestPath: '备份清单路径', createdAt: '创建时间', updatedAt: '更新时间', personId: '人物 ID', characterId: '角色 ID', conversationId: '会话 ID', sourceIds: '来源消息 ID', sourceMessageId: '来源消息 ID', sourceText: '来源内容', sourceQuote: '来源原句', role: '发言身份', scope: '作用范围', enabled: '已启用', configured: '已配置', ready: '就绪', errorCode: '错误代码', model: '模型', provider: '服务商', credentialRef: '凭据引用', apiUrl: '工具 API 地址', dueAt: '提醒时间', quietStart: '安静时段开始', quietEnd: '安静时段结束', timeZone: '时区', maxPerDay: '每日上限', attempts: '尝试次数', queueName: '任务队列', permission: '授权范围', receipt: '发送回执', operationKey: '操作编号', threadId: '对话线程', graphVersion: '流程版本', assetCount: '资产数量', localOnly: '仅本地保存', deletionJournalSequence: '删除日志序号', sizeBytes: '文件字节数', sourceKind: '来源类型', backupManifest: '备份清单' };
function fieldLabel(key: string): string { return fieldLabels[key] ?? key; }
function display(value: unknown, key: string): string { const safe = safeForDisplay({ [key]: value })[key]; if (safe == null) return '—'; return typeof safe === 'object' ? JSON.stringify(safe) : String(safe); }
watch(() => route.value?.operation, () => { profileActionGeneration++; resetEditor(); });
watch(() => route.value?.path, load); onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="panel-head"><div><h1>{{ section.label }}</h1><p>{{ section.description }}</p></div><el-button :loading="loading" @click="load">刷新</el-button></div>
    <div v-if="section.key === 'identities' || section.key === 'jobs' || section.key === 'operations' || section.key === 'models'" class="subnav">
      <el-button v-for="name in (section.key === 'identities' ? ['角色目录', '身份绑定'] : section.key === 'jobs' ? ['任务日志', 'Agent运行', '工具运行', '对话回合', '发送回执'] : section.key === 'operations' ? ['健康状态', '备份', '迁移'] : ['模型配置', '工具', 'Agent'])" :key="name" :type="selected === name ? 'primary' : 'default'" @click="selected = name">{{ name }}</el-button>
    </div>
    <el-form v-if="section.key === 'persona'" inline><el-form-item label="角色 ID"><el-input v-model="targetId" placeholder="输入角色 ID" @keyup.enter="load" /></el-form-item><el-button @click="load">读取版本</el-button></el-form>
    <el-alert v-if="error" type="error" show-icon :closable="false" :title="error" description="请检查管理服务连接与权限后重试。" />
    <el-skeleton v-else-if="loading && !result" :rows="5" animated />
    <el-alert v-if="listResult?.configured === false" type="warning" show-icon :closable="false" title="此能力尚未配置" :description="listResult.message || '当前环境没有返回可用配置。'" />
    <el-alert v-else-if="section.key === 'operations' && (selected === '备份' || selected === '迁移') && listResult?.configured === true" type="success" :closable="false" title="操作运行器已由服务器报告为已配置" description="列表中的目标 ID、状态和 SHA-256 版本来自服务器返回记录。" />
    <template v-if="result">
      <template v-if="overviewData"><div class="overview-grid"><article><span>服务状态</span><strong>{{ overviewData.health }}</strong></article><article v-for="(value, key) in overviewData.counts" :key="key"><span>{{ key }}</span><strong>{{ value }}</strong></article><article v-for="(value, key) in overviewData.configured" :key="key"><span>{{ key }}</span><strong>{{ value ? '已配置' : '未配置' }}</strong></article><article v-if="overviewData.queueReady !== undefined"><span>任务队列</span><strong>{{ overviewData.queueReady ? '就绪' : '未就绪' }}</strong></article></div></template>
      <template v-else-if="section.key === 'identities' && selected !== '身份绑定'"><CharactersPanel /></template>
      <template v-else>
        <el-alert v-if="listResult?.message" type="info" :closable="false" :title="listResult.message" />
        <el-empty v-if="listResult?.items.length === 0" description="当前没有可显示的记录" />
        <div v-else-if="listResult" class="records">
          <article v-for="(item, i) in listResult.items" :key="String(item.id ?? item.version ?? i)" class="record" :class="{ selectable: section.key === 'models' || section.key === 'memory-revisions' || section.key === 'permissions' || section.key === 'operations' }" @click="section.key === 'models' || section.key === 'memory-revisions' || section.key === 'permissions' || section.key === 'operations' ? selectedItem(item) : undefined">
            <div v-for="key in keys(item)" :key="key" class="field"><span>{{ fieldLabel(key) }}</span><strong>{{ display(item[key], key) }}</strong></div>
            <div v-if="section.key === 'memory-revisions'" class="actions"><el-button v-if="item.status === 'candidate'" size="small" type="primary" @click.stop="selectedItem(item, 'approve')">审阅并批准</el-button><el-button size="small" type="warning" @click.stop="selectedItem(item, 'correct')">更正事实</el-button><el-button size="small" type="danger" @click.stop="forgetRevision(item)">忘记此修订</el-button></div>
            <div v-if="section.key === 'memory-sources'" class="actions"><el-button size="small" type="danger" @click.stop="forgetSource(item)">删除此来源</el-button></div>
            <div v-if="section.key === 'models' && selected === '模型配置'" class="actions"><el-button size="small" :disabled="saving || item.provider !== 'openai' || !['chat', 'memory', 'search'].includes(String(item.purpose ?? ''))" @click.stop="selectedItem(item); profileAction(item, 'test')">测试模型（可能产生费用）</el-button><el-button size="small" :type="item.enabled ? 'warning' : 'primary'" :disabled="saving || (!item.enabled && (item.provider !== 'openai' || !['chat', 'memory', 'search'].includes(String(item.purpose ?? ''))))" @click.stop="selectedItem(item); profileAction(item, 'enabled')">{{ item.enabled ? '禁用模型' : '启用模型' }}</el-button></div>
          </article>
        </div>
      </template>
    </template>
    <el-divider v-if="hasWriteForm" content-position="left">管理操作</el-divider>
    <el-form v-if="section.key === 'persona' && targetId" label-position="top" class="editor">
      <el-form-item label="预期角色版本"><el-input v-model="version" type="number" /></el-form-item><el-form-item label="人格设定 JSON"><el-input v-model="personaContent" type="textarea" :rows="5" /></el-form-item><el-form-item label="审计原因"><el-input v-model="reason" maxlength="1000" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">发布新版本</el-button>
    </el-form>
    <el-form v-if="section.key === 'memory-revisions' && targetId" label-position="top" class="editor">
      <el-alert v-if="reviewMode === 'approve'" type="info" :closable="false" title="批准仅接受直接、可核对的来源证据；服务端会验证候选来源归属与当前版本。"/><el-form-item label="候选版本"><el-input v-model="version" type="number" /></el-form-item><el-form-item label="来源原句（证据）"><el-input v-model="evidenceQuote" type="textarea" :rows="3" maxlength="4000" /></el-form-item><template v-if="reviewMode === 'approve'"><el-button type="primary" :loading="saving" @click="submit">批准候选</el-button></template><template v-else><el-form-item label="更正后的事实"><el-input v-model="factText" type="textarea" :rows="3" maxlength="4000" /></el-form-item><el-button type="warning" :loading="saving" @click="correctRevision">提交更正</el-button></template>
    </el-form>
    <el-form v-if="section.key === 'models' && selected !== '工具' && selected !== 'Agent' && targetId" label-position="top" class="editor">
      <div class="form-grid"><el-form-item label="版本"><el-input v-model="version" type="number" /></el-form-item><el-form-item label="显示名称"><el-input v-model="model.name" /></el-form-item><el-form-item label="供应商"><el-input v-model="model.provider" /></el-form-item><el-form-item label="API 地址"><el-input v-model="model.baseUrl" /></el-form-item><el-form-item label="模型名"><el-input v-model="model.model" /></el-form-item><el-form-item label="密钥环境变量引用"><el-input v-model="model.credentialRef" autocomplete="off" /></el-form-item><el-form-item label="向量维度（无则留空）"><el-input v-model="model.dimensions" type="number" /></el-form-item><el-form-item label="最大输出 token"><el-input v-model="model.maxTokens" type="number" /></el-form-item><el-form-item label="请求超时毫秒"><el-input v-model="model.timeoutMs" type="number" /></el-form-item><el-form-item label="月预算美元（无则留空）"><el-input v-model="model.monthlyBudgetUsd" /></el-form-item></div><el-form-item label="审计原因"><el-input v-model="reason" maxlength="1000" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">保存模型配置</el-button>
    </el-form>
        <el-form v-if="section.key === 'models' && (selected === 'Agent' || selected === '工具') && targetId" label-position="top" class="editor">
      <el-form-item label="期望配置版本"><el-input v-model="version" type="number" /></el-form-item><el-form-item label="启用"><el-switch v-model="enabled" /></el-form-item><template v-if="selected === 'Agent'"><el-form-item label="Agent 设置（当前仅允许空对象）"><el-input v-model="settingsText" type="textarea" :rows="3" /></el-form-item></template><template v-else><el-form-item label="工具 HTTP API 地址"><el-input v-model="toolApiUrl" autocomplete="off" /></el-form-item><el-form-item label="凭据环境变量名"><el-input v-model="toolCredentialRef" autocomplete="off" /></el-form-item></template><el-form-item label="审计原因"><el-input v-model="reason" maxlength="1000" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">保存{{ selected }}</el-button>
    </el-form>
    <el-form v-if="section.key === 'relationships'" label-position="top" class="editor">
      <div class="form-grid"><el-form-item label="人物 ID"><el-input v-model="personId" /></el-form-item><el-form-item label="角色 ID"><el-input v-model="characterId" /></el-form-item><el-form-item label="事件类型"><el-select v-model="eventKind"><el-option label="对话" value="conversation"/><el-option label="感谢" value="appreciation"/><el-option label="共同经历" value="shared_experience"/><el-option label="尊重边界" value="boundary_respected"/><el-option label="明确困扰" value="distress"/><el-option label="直接攻击" value="direct_attack"/><el-option label="转述攻击" value="quoted_attack"/><el-option label="拒绝" value="refusal"/><el-option label="延迟回复" value="late_reply"/><el-option label="延迟" value="delay"/></el-select></el-form-item><el-form-item label="来源消息 ID（逗号分隔）"><el-input v-model="sourceIds" /></el-form-item></div><el-form-item label="审计原因"><el-input v-model="reason" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">提交关系事件</el-button>
    </el-form>
    <el-form v-if="section.key === 'commitments'" label-position="top" class="editor">
      <div class="form-grid"><el-form-item label="人物 ID"><el-input v-model="personId" /></el-form-item><el-form-item label="角色 ID"><el-input v-model="characterId" /></el-form-item><el-form-item label="来源消息 ID"><el-input v-model="sourceMessageId" /></el-form-item><el-form-item label="提醒内容"><el-input v-model="commitmentText" maxlength="1000" /></el-form-item><el-form-item label="提醒时间"><el-date-picker v-model="dueAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" /></el-form-item><el-form-item label="提醒范围（须与来源一致）"><el-input v-model="scope" /></el-form-item></div><el-form-item label="审计原因"><el-input v-model="reason" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">提交提醒请求</el-button>
    </el-form>
    <el-form v-if="section.key === 'permissions'" label-position="top" class="editor">
      <el-alert type="info" :closable="false" title="个人与群聊授权分开保存。开启后仍受服务端安静时段与每日上限约束。"/><div class="form-grid"><el-form-item label="角色 ID"><el-input v-model="characterId" /></el-form-item><el-form-item label="范围"><el-select v-model="scope"><el-option label="个人" value="person"/><el-option label="群聊" value="group"/></el-select></el-form-item><el-form-item v-if="scope === 'person'" label="人物 ID"><el-input v-model="personId" /></el-form-item><el-form-item v-if="scope === 'group'" label="会话 ID"><el-input v-model="conversationId" /></el-form-item><el-form-item label="启用主动提醒"><el-switch v-model="enabled" /></el-form-item><el-form-item label="安静开始（HH:mm）"><el-input v-model="quietStart" placeholder="22:00" /></el-form-item><el-form-item label="安静结束（HH:mm）"><el-input v-model="quietEnd" placeholder="08:00" /></el-form-item><el-form-item label="时区"><el-input v-model="timeZone" /></el-form-item><el-form-item label="每日上限"><el-input v-model="maxPerDay" type="number" /></el-form-item><el-form-item label="期望版本"><el-input v-model="version" type="number" /></el-form-item></div><el-form-item label="审计原因"><el-input v-model="reason" /></el-form-item><el-button type="primary" :loading="saving" @click="submit">保存授权</el-button>
    </el-form>
    <el-form v-if="section.key === 'operations' && selected === '备份'" label-position="top" class="editor"><el-form-item label="操作"><el-select v-model="backupAction"><el-option label="验证备份" value="verify"/><el-option label="创建备份" value="create"/><el-option label="恢复备份" value="restore"/></el-select></el-form-item><el-form-item v-if="backupAction === 'restore' || backupAction === 'verify'" label="所选备份 ID"><el-input v-model="backupId" readonly /></el-form-item><el-form-item v-if="backupAction === 'restore' || backupAction === 'verify'" label="所选清单 SHA-256"><el-input v-model="version" readonly /></el-form-item><el-form-item label="审计原因"><el-input v-model="reason" /></el-form-item><el-button type="primary" :disabled="listResult?.configured === false" :loading="saving" @click="submit">提交</el-button></el-form>
    <el-form v-if="section.key === 'operations' && selected === '迁移'" label-position="top" class="editor"><el-form-item label="操作"><el-select v-model="migrationAction"><el-option label="检查迁移" value="inspect"/><el-option label="准备备份" value="backup"/><el-option label="应用迁移" value="apply"/></el-select></el-form-item><el-form-item label="所选迁移来源"><el-input v-model="sourceId" readonly /></el-form-item><el-form-item v-if="migrationAction !== 'inspect'" label="所选来源 SHA-256"><el-input v-model="version" readonly /></el-form-item><el-form-item label="审计原因"><el-input v-model="reason" /></el-form-item><el-button type="primary" :disabled="listResult?.configured === false" :loading="saving" @click="submit">提交</el-button></el-form>
    <p class="hint">凭据字段只显示引用值。页面不会保存表单或令牌到浏览器存储。</p>
    <p v-if="section.key === 'models' && selected === '模型配置'" class="hint">测试会实际调用供应商并可能产生费用；测试失败会自动停用模型。启用仅支持 OpenAI chat、memory、search profile，且须通过测试并配置凭据与价格。</p>
  </section>
</template>
