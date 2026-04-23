<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">人格仓库</p>
        <h2>默认人格与会话绑定</h2>
        <p class="page-description">管理全局默认人格、单独人设参数，以及针对具体会话的绑定关系。</p>
      </div>

      <div class="hero-actions">
        <button type="button" class="ui-button" :disabled="personaStore.loading" @click="load">
          {{ personaStore.loading ? '刷新中...' : '刷新' }}
        </button>
        <button type="button" class="ui-button ui-button-primary" :disabled="personaStore.saving" @click="save">
          {{ personaStore.saving ? '保存中...' : '保存人格' }}
        </button>
      </div>
    </div>

    <template v-if="draft">
      <article class="surface-panel">
        <div class="panel-header">
          <h3>默认人格与绑定</h3>
        </div>

        <div class="form-grid form-grid-two">
          <label class="field-block">
            <span class="field-label">默认人格</span>
            <select v-model="draft.defaultPersonaId" class="ui-select">
              <option v-for="persona in draft.personas" :key="persona.id" :value="persona.id">
                {{ persona.name }}（{{ persona.id }}）
              </option>
            </select>
          </label>

          <label class="field-block">
            <span class="field-label">会话绑定（每行：chatKey=personaId）</span>
            <textarea
              v-model="bindingsText"
              class="ui-textarea"
              rows="7"
              placeholder="例如：group:123456=assistant"
            />
          </label>
        </div>
      </article>

      <div class="section-toolbar">
        <div>
          <h3>人格列表</h3>
          <p>至少保留一个人格。默认人格会作为所有未绑定会话的兜底配置。</p>
        </div>
        <button type="button" class="ui-button" @click="addPersona">新增人格</button>
      </div>

      <div class="persona-grid">
        <article
          v-for="(persona, index) in draft.personas"
          :key="`${persona.id}-${index}`"
          class="surface-panel persona-card"
        >
          <div class="persona-card-head">
            <div>
              <strong>{{ persona.name || '未命名人格' }}</strong>
              <p>{{ persona.id || '未填写 ID' }}</p>
            </div>
            <span v-if="persona.id === draft.defaultPersonaId" class="mini-tag mini-tag-positive">默认</span>
          </div>

          <div class="field-stack">
            <div class="inline-fields">
              <label class="field-block">
                <span class="field-label">人格 ID</span>
                <input v-model="persona.id" class="ui-input" placeholder="例如 assistant" />
              </label>
              <label class="field-block">
                <span class="field-label">显示名称</span>
                <input v-model="persona.name" class="ui-input" placeholder="例如 默认助手" />
              </label>
            </div>

            <div class="inline-fields">
              <label class="field-block">
                <span class="field-label">温度</span>
                <input v-model.number="persona.temperature" class="ui-input" type="number" min="0" max="2" step="0.1" />
              </label>
              <label class="field-block">
                <span class="field-label">最大 Tokens</span>
                <input v-model.number="persona.maxTokens" class="ui-input" type="number" min="1" />
              </label>
            </div>

            <label class="field-block">
              <span class="field-label">系统提示词</span>
              <textarea v-model="persona.systemPrompt" class="ui-textarea" rows="10" />
            </label>

            <button
              type="button"
              class="ui-button ui-button-danger"
              :disabled="draft.personas.length <= 1"
              @click="removePersona(index)"
            >
              删除此人格
            </button>
          </div>
        </article>
      </div>
    </template>

    <article v-else class="surface-panel empty-panel">
      {{ personaStore.loading ? '正在读取人格配置...' : '暂无人格数据' }}
    </article>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ApiError } from '../api/client';
import { useMessage } from '../stores/message';
import { usePersonaStore } from '../stores/personas';
import type { PersonaRegistry } from '../types';

const personaStore = usePersonaStore();
const draft = ref<PersonaRegistry | null>(null);
const bindingsText = ref('');
const message = useMessage();

function formatBindings(bindings: Record<string, string>): string {
  return Object.entries(bindings)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseBindings(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const personaId = line.slice(separatorIndex + 1).trim();
    if (key && personaId) {
      output[key] = personaId;
    }
  }

  return output;
}

function addPersona(): void {
  if (!draft.value) {
    return;
  }

  const nextIndex = draft.value.personas.length + 1;
  draft.value.personas.push({
    id: `persona_${nextIndex}`,
    name: `人格 ${nextIndex}`,
    systemPrompt: '你是一个可靠、简洁、友好的 QQ 助手。',
    temperature: 0.7,
    maxTokens: 512
  });
}

function removePersona(index: number): void {
  if (!draft.value || draft.value.personas.length <= 1) {
    return;
  }

  draft.value.personas.splice(index, 1);
  const hasDefault = draft.value.personas.some((item) => item.id === draft.value?.defaultPersonaId);
  if (!hasDefault) {
    draft.value.defaultPersonaId = draft.value.personas[0].id;
  }
}

async function load(): Promise<void> {
  await personaStore.fetchPersonas();
  if (personaStore.data) {
    draft.value = JSON.parse(JSON.stringify(personaStore.data)) as PersonaRegistry;
    bindingsText.value = formatBindings(draft.value.bindings);
  }
}

async function save(): Promise<void> {
  if (!draft.value) {
    return;
  }

  const payload: PersonaRegistry = {
    ...draft.value,
    bindings: parseBindings(bindingsText.value)
  };

  try {
    await personaStore.savePersonas(payload);
    draft.value = JSON.parse(JSON.stringify(payload)) as PersonaRegistry;
    message.success('人格配置已保存');
  } catch (error) {
    if (error instanceof ApiError) {
      message.error(error.message);
      return;
    }

    message.error('保存失败，请稍后重试');
  }
}

void load();
</script>
