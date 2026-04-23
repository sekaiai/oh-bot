<template>
  <div class="admin-shell" :class="{ 'admin-shell-auth': !showLayout }">
    <div class="admin-ambient" />

    <template v-if="showLayout">
      <aside class="app-sidebar">
        <div class="sidebar-brand">
          <div class="brand-mark">OH</div>
          <div>
            <p class="brand-eyebrow">运行控制台</p>
            <h1>oh-bot 管理端</h1>
          </div>
        </div>

        <div class="sidebar-intro">
          <p>会话、人设、规则集中维护</p>
          <span>当前环境：本地运维面板</span>
        </div>

        <nav class="sidebar-nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="sidebar-link"
            :class="{ 'sidebar-link-active': item.key === selectedKey }"
            @click="navigate(item.path)"
          >
            <span class="sidebar-link-mark">{{ item.mark }}</span>
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <button type="button" class="ui-button ui-button-danger ui-button-block" @click="handleLogout">
            退出登录
          </button>
        </div>
      </aside>

      <div class="mobile-toolbar">
        <div>
          <p class="brand-eyebrow">运维入口</p>
          <strong>oh-bot 管理端</strong>
        </div>
        <button type="button" class="mobile-menu-button" @click="drawerVisible = true">
          菜单
        </button>
      </div>

      <BaseDrawer v-model:visible="drawerVisible" title="导航" width="280px" unmount-on-close>
        <nav class="drawer-nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="drawer-link"
            :class="{ 'drawer-link-active': item.key === selectedKey }"
            @click="navigateFromDrawer(item.path)"
          >
            <span class="sidebar-link-mark">{{ item.mark }}</span>
            <span>{{ item.label }}</span>
          </button>
        </nav>
      </BaseDrawer>
    </template>

    <main class="app-main" :class="{ 'app-main-auth': !showLayout }">
      <RouterView v-slot="{ Component }">
        <Transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseDrawer from './components/BaseDrawer.vue';
import { useAuthStore } from './stores/auth';

interface NavItem {
  key: string;
  label: string;
  path: string;
  mark: string;
}

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const drawerVisible = ref(false);

const navItems: NavItem[] = [
  { key: 'dashboard', label: '运行概览', path: '/dashboard', mark: '览' },
  { key: 'plugins', label: '插件配置', path: '/plugins', mark: '件' },
  { key: 'tasks', label: '任务中心', path: '/tasks', mark: '任' },
  { key: 'rules', label: '规则配置', path: '/rules', mark: '规' },
  { key: 'personas', label: '人格配置', path: '/personas', mark: '人' },
  { key: 'sessions', label: '会话控制', path: '/sessions', mark: '会' }
];

const showLayout = computed(() => route.name !== 'login' && authStore.authenticated);
const selectedKey = computed(() => String(route.name ?? 'dashboard'));

async function navigate(path: string): Promise<void> {
  if (route.path !== path) {
    await router.push(path);
  }
}

async function navigateFromDrawer(path: string): Promise<void> {
  drawerVisible.value = false;
  await navigate(path);
}

async function handleLogout(): Promise<void> {
  await authStore.logout();
  drawerVisible.value = false;
  await router.push('/login');
}
</script>
