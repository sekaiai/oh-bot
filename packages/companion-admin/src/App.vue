<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from './stores/auth';
import { sections } from './app/sections';
import AdminPanel from './components/AdminPanel.vue';
const auth = useAuthStore(); const active = ref('overview'); const password = ref(''); const loginError = ref('');
const current = computed(() => sections.find((section) => section.key === active.value) ?? sections[0]!);
async function login() { loginError.value = ''; try { await auth.login(password.value); password.value = ''; } catch (error) { loginError.value = error instanceof Error ? error.message : '登录失败'; } }
onMounted(() => auth.restore());
</script>

<template>
  <main v-if="!auth.authenticated" class="login-screen">
    <el-card class="login-card"><p class="eyebrow">陪伴系统管理端</p><h1>安全登录</h1><p>令牌仅保存在当前页面内存中，刷新后需要重新登录。</p>
      <el-alert v-if="loginError" type="error" :closable="false" :title="loginError" />
      <el-form @submit.prevent="login"><el-form-item label="管理员密码"><el-input v-model="password" type="password" show-password autocomplete="current-password" @keyup.enter="login" /></el-form-item><el-button type="primary" :loading="auth.busy" @click="login">登录</el-button></el-form>
      <small>管理接口地址由部署环境的 VITE_COMPANION_ADMIN_API_BASE_URL 提供。</small>
    </el-card>
  </main>
  <div v-else class="shell">
    <aside class="sidebar"><div class="brand"><span>南枝</span><small>陪伴系统管理端</small></div><nav aria-label="管理功能"><button v-for="section in sections" :key="section.key" :class="{ active: active === section.key }" @click="active = section.key">{{ section.label }}</button></nav><el-button class="logout" plain @click="auth.logout">退出登录</el-button></aside>
    <div class="content"><header><span>管理工作台</span><el-tag type="success" effect="plain">已认证</el-tag></header><AdminPanel :key="current.key" :section="current" /></div>
  </div>
</template>
