<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">会话控制</p>
        <h2>会话列表、配置与消息日志</h2>
        <p class="page-description">
          面板每 5 秒自动同步一次列表与当前展开会话。可直接调整人格绑定和封禁状态。
        </p>
      </div>

      <div class="hero-actions">
        <button type="button" class="ui-button ui-button-primary" :disabled="store.loading" @click="refreshAll()">
          {{ store.loading ? '刷新中...' : '立即刷新' }}
        </button>
      </div>
    </div>

    <p v-if="notice.text" class="inline-feedback" :class="notice.error ? 'inline-feedback-error' : 'inline-feedback-success'">
      {{ notice.text }}
    </p>

    <article class="surface-panel">
      <div class="session-toolbar">
        <div class="session-toolbar-stats">
          <div class="stat-chip">
            <span>会话总数</span>
            <strong>{{ store.total }}</strong>
          </div>
          <div class="stat-chip">
            <span>筛选结果</span>
            <strong>{{ filteredSessions.length }}</strong>
          </div>
          <div class="toolbar-note">
            <span>自动刷新：每 5 秒</span>
            <span>上次同步：{{ refreshedAtLabel }}</span>
          </div>
        </div>

        <div class="session-toolbar-actions">
          <div class="filter-tabs">
            <button
              v-for="type in filterTypes"
              :key="type.value"
              type="button"
              class="filter-tab"
              :class="{ 'filter-tab-active': chatTypeFilter === type.value }"
              @click="chatTypeFilter = type.value"
            >
              {{ type.label }}
            </button>
          </div>

          <input
            v-model="keyword"
            class="ui-input session-search"
            type="search"
            placeholder="搜索名称、QQ 号或 chatKey"
          />
        </div>
      </div>
    </article>

    <div v-if="filteredSessions.length" class="session-grid">
      <article
        v-for="item in filteredSessions"
        :key="item.chatKey"
        class="surface-panel session-card"
        :class="{ 'session-card-active': item.chatKey === store.selectedChatKey }"
      >
        <div class="session-card-title">
          <div class="session-title-block">
            <div class="session-title-line">
              <span v-if="item.chatType === 'group'" class="mini-tag">群</span>
              <h3>{{ item.displayName }}</h3>
            </div>
            <p>{{ item.chatType === 'group' ? `群号 ${item.targetId}` : `QQ ${item.targetId}` }}</p>
          </div>

          <div class="session-card-actions">
            <button type="button" class="text-button" @click="openSettings(item)">设置</button>
            <button type="button" class="ui-button ui-button-ghost" @click="toggleDetail(item.chatKey)">
              {{ item.chatKey === store.selectedChatKey ? '收起消息' : '展开消息' }}
            </button>
          </div>
        </div>

        <div class="session-chip-row">
          <div class="info-chip">
            <span>人格</span>
            <strong>{{ item.personaName }}</strong>
            <span class="mini-tag" :class="item.usesDefaultPersona ? 'mini-tag-muted' : 'mini-tag-positive'">
              {{ item.usesDefaultPersona ? '默认' : '单独绑定' }}
            </span>
          </div>

          <div class="info-chip">
            <span>状态</span>
            <span class="mini-tag" :class="item.status === 'banned' ? 'mini-tag-danger' : 'mini-tag-positive'">
              {{ item.status === 'banned' ? '封禁' : '可用' }}
            </span>
          </div>

          <div class="info-chip">
            <span>消息</span>
            <strong>{{ item.messageCount }}</strong>
          </div>

          <div class="info-chip">
            <span>已处理</span>
            <strong>{{ item.handledCount }}</strong>
          </div>
        </div>

        <div class="session-preview">
          <div class="preview-head">
            <span>最新消息</span>
            <span>{{ formatRelativeTime(item.latestActivityAt) }}</span>
          </div>
          <p>{{ formatPreview(item.lastMessage) }}</p>
          <div class="preview-meta">
            <span>{{ item.lastMessage ? `${formatSpeaker(item.lastMessage)} · ${formatTime(item.lastMessage.time)}` : '暂无消息' }}</span>
            <span v-if="item.lastReplyAt">最近回复：{{ formatTime(item.lastReplyAt) }}</span>
          </div>
        </div>
      </article>
    </div>

    <article v-else class="surface-panel empty-panel">
      {{ store.loading ? '正在加载会话列表...' : '没有匹配的会话' }}
    </article>

    <article class="surface-panel session-log-card">
      <div class="session-log-head">
        <div>
          <strong>消息日志</strong>
          <p v-if="selectedSummary">{{ selectedSummary.displayName }} · {{ selectedSummary.chatKey }}</p>
          <p v-else>点击上方会话卡片中的“展开消息”查看日志。</p>
        </div>
        <span v-if="selectedSummary" class="mini-tag" :class="selectedSummary.status === 'banned' ? 'mini-tag-danger' : 'mini-tag-positive'">
          {{ selectedSummary.status === 'banned' ? '封禁中' : '当前可用' }}
        </span>
      </div>

      <template v-if="selectedSummary">
        <div class="session-log-summary">
          <div class="summary-pill">
            <span>会话人格</span>
            <strong>{{ selectedSummary.personaName }}</strong>
          </div>
          <div class="summary-pill">
            <span>会话类型</span>
            <strong>{{ selectedSummary.chatType === 'group' ? '群聊' : '私聊' }}</strong>
          </div>
          <div class="summary-pill">
            <span>处理进度</span>
            <strong>{{ selectedSummary.handledCount }} / {{ selectedSummary.messageCount }}</strong>
          </div>
        </div>

        <div ref="logViewport" class="session-log-viewport">
          <template v-if="store.detail?.session?.messages.length">
            <article
              v-for="(message, index) in store.detail.session.messages"
              :key="`${message.time}-${index}`"
              class="log-entry"
              :class="`log-entry-${message.role}`"
            >
              <div class="log-entry-head">
                <div class="log-entry-author">
                  <span class="log-role">{{ formatRole(message.role) }}</span>
                  <strong>{{ formatSpeaker(message) }}</strong>
                  <span v-if="message.isAtBot" class="mini-tag mini-tag-warning">提及机器人</span>
                </div>

                <div class="log-entry-meta">
                  <span>{{ formatTime(message.time) }}</span>
                  <span v-if="message.reason" class="mini-tag mini-tag-muted">
                    {{ formatReason(message.reason) }}
                  </span>
                </div>
              </div>

              <pre class="log-entry-content">{{ message.content }}</pre>
            </article>
          </template>

          <div v-else class="log-empty">
            {{ store.detailLoading ? '正在同步消息日志...' : '当前会话还没有可展示的消息。' }}
          </div>
        </div>
      </template>

      <div v-else class="empty-panel">
        尚未选择会话
      </div>
    </article>

    <AModal v-model:visible="settingsVisible" title="会话设置" :ok-loading="store.saving" @ok="saveSettings">
      <template v-if="settingsSummary">
        <div class="field-stack">
          <div class="modal-summary-list">
            <div class="modal-summary-item">
              <span>会话名称</span>
              <strong>{{ settingsSummary.displayName }}</strong>
            </div>
            <div class="modal-summary-item">
              <span>会话标识</span>
              <strong>{{ settingsSummary.chatKey }}</strong>
            </div>
            <div class="modal-summary-item">
              <span>当前状态</span>
              <strong>{{ settingsSummary.status === 'banned' ? '封禁' : '可用' }}</strong>
            </div>
          </div>

          <label class="field-block">
            <span class="field-label">会话人格</span>
            <select v-model="settingsForm.personaId" class="ui-select">
              <option :value="DEFAULT_PERSONA_VALUE">跟随默认人格</option>
              <option v-for="persona in personaOptions" :key="persona.id" :value="persona.id">
                {{ persona.name }}（{{ persona.id }}）
              </option>
            </select>
          </label>

          <fieldset class="radio-group-field">
            <legend class="field-label">会话状态</legend>
            <label class="radio-chip">
              <input v-model="settingsForm.status" type="radio" value="available" />
              <span>可用</span>
            </label>
            <label class="radio-chip">
              <input v-model="settingsForm.status" type="radio" value="banned" />
              <span>封禁</span>
            </label>
          </fieldset>
        </div>
      </template>
    </AModal>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Modal as AModal } from '@arco-design/web-vue';
import { ApiError } from '../api/client';
import { usePersonaStore } from '../stores/personas';
import { useSessionsStore } from '../stores/sessions';
import type { SessionItemSummary, SessionMessage, SessionStatus } from '../types';

const DEFAULT_PERSONA_VALUE = '__default__';

const store = useSessionsStore();
const personaStore = usePersonaStore();
const keyword = ref('');
const chatTypeFilter = ref<'all' | 'group' | 'private'>('all');
const settingsVisible = ref(false);
const settingsChatKey = ref('');
const logViewport = ref<HTMLDivElement | null>(null);
const notice = ref({
  text: '',
  error: false
});
const settingsForm = reactive<{
  personaId: string;
  status: SessionStatus;
}>({
  personaId: DEFAULT_PERSONA_VALUE,
  status: 'available'
});

const filterTypes = [
  { value: 'all', label: '全部' },
  { value: 'group', label: '群聊' },
  { value: 'private', label: '私聊' }
] as const;

let refreshTimer: number | null = null;

const roleLabels: Record<SessionMessage['role'], string> = {
  system: '系统',
  user: '用户',
  assistant: '机器人',
  tool: '工具'
};

const reasonLabels: Record<string, string> = {
  private_blacklist: '私聊黑名单',
  group_blacklist: '群聊黑名单',
  private_default: '私聊默认触发',
  group_at: '群聊 @ 触发',
  group_name_mention: '提到机器人名称',
  group_context_high_value: '群上下文高价值',
  group_context_related: '群上下文相关',
  group_low_value: '群上下文低价值',
  cooldown: '冷却中',
  duplicate: '重复消息',
  group_consecutive_reply_guard: '连续回复保护',
  ai_disabled: 'AI 已关闭',
  model_error: '模型异常',
  tool_weather: '天气工具回复',
  tool_ds2api: 'DS2API 插件回复',
  tool_qingmeng: '倾梦插件回复',
  tool_missing_location: '缺少地点',
  tool_error: '工具异常'
};

const filteredSessions = computed(() => {
  const search = keyword.value.trim().toLowerCase();

  return store.sessions.filter((item) => {
    const typeMatched = chatTypeFilter.value === 'all' || item.chatType === chatTypeFilter.value;
    if (!typeMatched) {
      return false;
    }

    if (!search) {
      return true;
    }

    const haystack = [
      item.chatKey,
      item.displayName,
      item.targetId,
      item.personaName,
      item.lastMessage?.content ?? ''
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(search);
  });
});

const selectedSummary = computed(() => {
  if (store.detail?.summary) {
    return store.detail.summary;
  }

  return store.sessions.find((item) => item.chatKey === store.selectedChatKey) ?? null;
});

const settingsSummary = computed(() => {
  return store.sessions.find((item) => item.chatKey === settingsChatKey.value) ?? store.detail?.summary ?? null;
});

const personaOptions = computed(() => personaStore.data?.personas ?? []);

const refreshedAtLabel = computed(() => {
  if (!store.refreshedAt) {
    return '尚未同步';
  }

  return new Date(store.refreshedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
});

function formatTime(value: number | null | undefined): string {
  if (!value) {
    return '-';
  }

  return new Date(value * 1000).toLocaleString('zh-CN');
}

function formatRelativeTime(value: number | null | undefined): string {
  if (!value) {
    return '暂无活跃记录';
  }

  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - value);
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} 小时前`;
  }

  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatPreview(message: SessionMessage | null): string {
  if (!message?.content) {
    return '暂无消息';
  }

  const content = message.content.replace(/\s+/g, ' ').trim();
  return content.length > 96 ? `${content.slice(0, 96)}...` : content;
}

function formatRole(role: SessionMessage['role']): string {
  return roleLabels[role] ?? role;
}

function formatReason(reason?: string): string {
  if (!reason) {
    return '';
  }

  return reasonLabels[reason] ?? reason;
}

function formatSpeaker(message: SessionMessage): string {
  if (message.role === 'assistant') {
    return 'oh-bot';
  }

  if (message.role === 'system') {
    return '系统';
  }

  if (message.role === 'tool') {
    return '工具链';
  }

  return message.senderNickname || message.userId || '未知用户';
}

async function ensurePersonas(): Promise<void> {
  if (!personaStore.data && !personaStore.loading) {
    await personaStore.fetchPersonas();
  }
}

async function refreshAll(silent = false): Promise<void> {
  await store.fetchSessions({ silent });
  if (store.selectedChatKey) {
    await store.fetchSessionDetail(store.selectedChatKey, { silent });
  }
}

async function toggleDetail(chatKey: string): Promise<void> {
  if (store.selectedChatKey === chatKey) {
    store.clearSelection();
    return;
  }

  await store.fetchSessionDetail(chatKey);
}

async function openSettings(summary: SessionItemSummary): Promise<void> {
  await ensurePersonas();
  settingsChatKey.value = summary.chatKey;
  settingsForm.personaId = summary.usesDefaultPersona ? DEFAULT_PERSONA_VALUE : summary.personaId;
  settingsForm.status = summary.status;
  settingsVisible.value = true;
}

async function saveSettings(): Promise<void> {
  if (!settingsChatKey.value) {
    return;
  }

  const chatKey = settingsChatKey.value;

  try {
    await store.saveSessionSettings({
      chatKey,
      personaId: settingsForm.personaId === DEFAULT_PERSONA_VALUE ? null : settingsForm.personaId,
      status: settingsForm.status
    });

    if (store.selectedChatKey === chatKey) {
      await store.fetchSessionDetail(chatKey, { silent: true });
    }

    notice.value = { text: '会话设置已保存', error: false };
    settingsVisible.value = false;
  } catch (error) {
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: '保存失败，请稍后重试', error: true };
  }
}

onMounted(() => {
  void refreshAll();
  refreshTimer = window.setInterval(() => {
    void refreshAll(true);
  }, 5000);
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

watch(
  () => store.detail?.session?.messages.length,
  async () => {
    await nextTick();
    if (logViewport.value) {
      logViewport.value.scrollTo({
        top: logViewport.value.scrollHeight,
        behavior: 'smooth'
      });
    }
  }
);
</script>
