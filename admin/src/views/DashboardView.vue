<template>
  <section class="panel">
    <div class="row" style="justify-content: space-between;">
      <h2>运行概览</h2>
      <button class="button" :disabled="summary.loading" @click="refresh">刷新</button>
    </div>

    <p v-if="summary.loading">加载中...</p>
    <div v-else-if="summary.data" class="grid">
      <article class="kv" v-for="item in items" :key="item.label">
        <div class="label">{{ item.label }}</div>
        <div class="value">{{ item.value }}</div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useSummaryStore } from '../stores/summary';

const summary = useSummaryStore();

const items = computed(() => {
  if (!summary.data) {
    return [];
  }

  return [
    { label: 'NapCat WS', value: summary.data.napcatWsUrl },
    { label: 'AI 模型', value: summary.data.aiModel },
    { label: 'AI Base URL', value: summary.data.aiBaseUrl },
    { label: '天气能力', value: summary.data.qweatherEnabled ? '已启用' : '未启用' },
    { label: '数据目录', value: summary.data.dataDir },
    { label: '日志级别', value: summary.data.logLevel },
    { label: '管理端端口', value: String(summary.data.adminPort) },
    { label: '会话有效期(秒)', value: String(summary.data.adminSessionTtlSeconds) }
  ];
});

async function refresh(): Promise<void> {
  await summary.fetchSummary();
}

onMounted(() => {
  void refresh();
});
</script>
