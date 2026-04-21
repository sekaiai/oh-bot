<template>
  <section class="panel">
    <div class="row" style="justify-content: space-between;">
      <h2>会话查询</h2>
      <button class="button" :disabled="store.loading" @click="load">刷新</button>
    </div>

    <p>总会话数：{{ store.total }}</p>

    <table class="table">
      <thead>
        <tr>
          <th>chatKey</th>
          <th>消息数</th>
          <th>已处理数</th>
          <th>最后回复时间</th>
          <th>最后消息</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in store.sessions" :key="item.chatKey">
          <td>{{ item.chatKey }}</td>
          <td>{{ item.messageCount }}</td>
          <td>{{ item.handledCount }}</td>
          <td>{{ formatTime(item.lastReplyAt) }}</td>
          <td>{{ item.lastMessage?.content ?? '-' }}</td>
          <td><button class="button ghost" @click="showDetail(item.chatKey)">查看</button></td>
        </tr>
      </tbody>
    </table>

    <article class="panel" v-if="store.selectedChatKey">
      <h3>会话详情：{{ store.selectedChatKey }}</h3>
      <p v-if="store.detailLoading">加载详情中...</p>
      <div v-else-if="store.detail" class="stack">
        <div v-for="(message, index) in store.detail.messages" :key="index" class="kv">
          <div class="label">{{ message.role }} · {{ formatTime(message.time) }}</div>
          <div class="value">{{ message.content }}</div>
          <div v-if="message.reason" class="label">reason: {{ message.reason }}</div>
        </div>
      </div>
      <p v-else>该会话不存在或暂无数据。</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { useSessionsStore } from '../stores/sessions';

const store = useSessionsStore();

function formatTime(value: number | null | undefined): string {
  if (!value) {
    return '-';
  }

  return new Date(value * 1000).toLocaleString('zh-CN');
}

async function load(): Promise<void> {
  await store.fetchSessions();
}

async function showDetail(chatKey: string): Promise<void> {
  await store.fetchSessionDetail(chatKey);
}

void load();
</script>
