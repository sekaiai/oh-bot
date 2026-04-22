<template>
  <section class="auth-stage">
    <div class="auth-copy">
      <p class="page-eyebrow">安全入口</p>
      <h2>进入 oh-bot 管理控制台</h2>
      <p class="page-description">
        当前面板用于维护规则、人格和会话状态。登录密码取自当前项目 `.env` 中的 `ADMIN_PASSWORD`。
      </p>
    </div>

    <article class="surface-panel auth-card">
      <div class="auth-card-head">
        <div class="auth-badge">安</div>
        <div>
          <h3>身份校验</h3>
          <p>输入管理密码后进入运维面板。</p>
        </div>
      </div>

      <div class="inline-notice inline-notice-info">
        登录成功后会写入 Cookie，会话有效期由 `ADMIN_SESSION_TTL_SECONDS` 控制。
      </div>

      <form class="field-stack" @submit.prevent="submit">
        <label class="field-block">
          <span class="field-label">管理密码</span>
          <input
            v-model="password"
            class="ui-input"
            type="text"
            autocomplete="off"
            placeholder="请输入管理密码"
          />
        </label>

        <p v-if="errorMessage" class="inline-feedback inline-feedback-error">{{ errorMessage }}</p>

        <button type="submit" class="ui-button ui-button-primary ui-button-block" :disabled="auth.loading">
          {{ auth.loading ? '登录中...' : '登录管理端' }}
        </button>
      </form>
    </article>
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
