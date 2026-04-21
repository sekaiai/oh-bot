<template>
  <section class="panel">
    <div class="row" style="justify-content: space-between;">
      <h2>规则配置</h2>
      <button class="button" :disabled="rulesStore.loading" @click="load">刷新</button>
    </div>

    <p v-if="rulesStore.loading">加载中...</p>
    <form v-else-if="draft" class="form" @submit.prevent="save">
      <label>
        admins（每行一个）
        <textarea v-model="form.admins" class="textarea" />
      </label>
      <label>
        whitelistGroups（每行一个）
        <textarea v-model="form.whitelistGroups" class="textarea" />
      </label>
      <label>
        privateBlacklist（每行一个）
        <textarea v-model="form.privateBlacklist" class="textarea" />
      </label>
      <label>
        groupBlacklist（每行一个）
        <textarea v-model="form.groupBlacklist" class="textarea" />
      </label>
      <label>
        botNames（每行一个）
        <textarea v-model="form.botNames" class="textarea" />
      </label>

      <label>
        commandPrefix
        <input v-model="draft.commandPrefix" class="input" />
      </label>

      <label>
        cooldownSeconds
        <input v-model.number="draft.cooldownSeconds" class="input" type="number" min="0" />
      </label>

      <label class="row">
        <input v-model="draft.aiEnabled" type="checkbox" />
        AI 启用
      </label>
      <label class="row">
        <input v-model="draft.requireAtInGroup" type="checkbox" />
        群聊必须 @
      </label>

      <div class="row">
        <button class="button" :disabled="rulesStore.saving">{{ rulesStore.saving ? '保存中...' : '保存' }}</button>
      </div>
      <p v-if="message" :class="isError ? 'error' : 'success'">{{ message }}</p>
    </form>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ApiError } from '../api/client';
import { useRuleStore } from '../stores/rules';
import type { RuleConfig } from '../types';

const rulesStore = useRuleStore();
const draft = ref<RuleConfig | null>(null);
const message = ref('');
const isError = ref(false);

const form = reactive({
  admins: '',
  whitelistGroups: '',
  privateBlacklist: '',
  groupBlacklist: '',
  botNames: ''
});

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function fromLines(values: string[]): string {
  return values.join('\n');
}

function syncFromDraft(value: RuleConfig): void {
  form.admins = fromLines(value.admins);
  form.whitelistGroups = fromLines(value.whitelistGroups);
  form.privateBlacklist = fromLines(value.privateBlacklist);
  form.groupBlacklist = fromLines(value.groupBlacklist);
  form.botNames = fromLines(value.botNames);
}

async function load(): Promise<void> {
  message.value = '';
  await rulesStore.fetchRules();
  if (rulesStore.rules) {
    draft.value = { ...rulesStore.rules };
    syncFromDraft(rulesStore.rules);
  }
}

async function save(): Promise<void> {
  if (!draft.value) {
    return;
  }

  message.value = '';
  isError.value = false;

  const payload: RuleConfig = {
    ...draft.value,
    admins: toLines(form.admins),
    whitelistGroups: toLines(form.whitelistGroups),
    blacklistUsers: toLines(form.privateBlacklist),
    privateBlacklist: toLines(form.privateBlacklist),
    groupBlacklist: toLines(form.groupBlacklist),
    botNames: toLines(form.botNames)
  };

  try {
    await rulesStore.saveRules(payload);
    message.value = '保存成功';
    draft.value = payload;
  } catch (error) {
    isError.value = true;
    if (error instanceof ApiError) {
      message.value = error.message;
      return;
    }

    message.value = '保存失败';
  }
}

void load();
</script>
