<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">运行总览</p>
        <h2>服务状态与关键配置</h2>
        <p class="page-description">集中查看机器人连接、模型配置、天气工具和管理端运行参数。</p>
      </div>

      <button type="button" class="ui-button ui-button-primary" :disabled="summary.loading" @click="refresh">
        {{ summary.loading ? '刷新中...' : '刷新概览' }}
      </button>
    </div>

    <template v-if="summary.data">
      <div class="stats-grid">
        <article v-for="item in metrics" :key="item.label" class="surface-panel metric-card">
          <p class="metric-label">{{ item.label }}</p>
          <strong class="metric-value">{{ item.value }}</strong>
          <p class="metric-card-note">{{ item.note }}</p>
        </article>
      </div>

      <article class="surface-panel">
        <div class="panel-header">
          <h3>配置明细</h3>
        </div>

        <div class="summary-list">
          <div v-for="item in details" :key="item.label" class="summary-item">
            <span class="summary-item-label">{{ item.label }}</span>
            <strong class="summary-item-value">{{ item.value }}</strong>
          </div>
        </div>
      </article>
    </template>

    <article v-else class="surface-panel empty-panel">
      {{ summary.loading ? '正在读取服务配置...' : '暂无配置数据' }}
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useSummaryStore } from '../stores/summary';

const summary = useSummaryStore();

const metrics = computed(() => {
  if (!summary.data) {
    return [];
  }

  return [
    {
      label: 'AI 模型',
      value: summary.data.aiModel,
      note: '主 AI 固定由服务端环境变量控制。'
    },
    {
      label: '启用插件',
      value: `${summary.data.enabledPluginCount}/${summary.data.pluginCount}`,
      note: '插件配置独立保存，互不影响。'
    },
    {
      label: 'DS2API 插件',
      value: summary.data.ds2apiEnabled ? '已启用' : '未启用',
      note: '命中特定关键词时由插件接管回复。'
    },
    {
      label: '管理端端口',
      value: String(summary.data.adminPort),
      note: '前端请求默认连接的后台管理服务端口。'
    },
    {
      label: '会话有效期',
      value: `${summary.data.adminSessionTtlSeconds} 秒`,
      note: '登录态 Cookie 的有效时长。'
    },
    {
      label: '天气工具',
      value: summary.data.qweatherEnabled ? '已启用' : '未启用',
      note: '根据后台里的和风配置自动识别。'
    }
  ];
});

const details = computed(() => {
  if (!summary.data) {
    return [];
  }

  return [
    { label: 'NapCat WebSocket', value: summary.data.napcatWsUrl },
    { label: 'AI 接口地址', value: summary.data.aiBaseUrl },
    { label: '请求超时', value: `${summary.data.aiTimeoutMs} ms` },
    { label: '插件数量', value: `${summary.data.enabledPluginCount} / ${summary.data.pluginCount}` },
    { label: '天气接口域名', value: summary.data.qweatherApiHost },
    { label: '上下文上限', value: `${summary.data.maxContextMessages} 条` },
    { label: '日志级别', value: summary.data.logLevel },
    { label: '数据目录', value: summary.data.dataDir },
    { label: '天气能力状态', value: summary.data.qweatherEnabled ? '可用' : '未配置' }
  ];
});

async function refresh(): Promise<void> {
  await summary.fetchSummary();
}

onMounted(() => {
  void refresh();
});
</script>
