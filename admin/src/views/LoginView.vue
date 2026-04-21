<template>
  <section class="panel">
    <h2>管理端登录</h2>
    <p>请输入 .env 中配置的 ADMIN_PASSWORD。</p>

    <form class="form" @submit.prevent="submit">
      <input v-model="password" class="input" type="password" placeholder="管理密码" autocomplete="current-password" />
      <button class="button" :disabled="auth.loading">{{ auth.loading ? '登录中...' : '登录' }}</button>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </form>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const password = ref('');
const errorMessage = ref('');

async function submit(): Promise<void> {
  errorMessage.value = '';

  if (!password.value.trim()) {
    errorMessage.value = '请输入管理密码';
    return;
  }

  try {
    await auth.login(password.value.trim());
    await router.push('/dashboard');
  } catch (error) {
    if (error instanceof ApiError) {
      errorMessage.value = error.message;
      return;
    }

    errorMessage.value = '登录失败，请稍后重试';
  }
}
</script>
