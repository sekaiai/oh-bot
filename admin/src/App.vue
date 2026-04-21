<template>
  <div class="shell">
    <aside v-if="showLayout" class="sidebar">
      <h1 class="brand">oh-bot</h1>
      <nav class="menu">
        <RouterLink to="/dashboard" class="menu-link">概览</RouterLink>
        <RouterLink to="/rules" class="menu-link">规则配置</RouterLink>
        <RouterLink to="/personas" class="menu-link">Persona</RouterLink>
        <RouterLink to="/sessions" class="menu-link">会话查询</RouterLink>
      </nav>
      <button class="button ghost" @click="handleLogout">退出登录</button>
    </aside>

    <main class="content" :class="{ 'content-full': !showLayout }">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const showLayout = computed(() => route.name !== 'login' && authStore.authenticated);

async function handleLogout(): Promise<void> {
  await authStore.logout();
  await router.push('/login');
}
</script>
