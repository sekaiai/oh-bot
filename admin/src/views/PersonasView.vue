<template>
  <section class="panel">
    <div class="row" style="justify-content: space-between;">
      <h2>Persona 管理</h2>
      <button class="button" :disabled="personaStore.loading" @click="load">刷新</button>
    </div>

    <p v-if="personaStore.loading">加载中...</p>
    <div v-else-if="draft" class="stack">
      <label>
        默认 Persona
        <select v-model="draft.defaultPersonaId" class="select">
          <option v-for="persona in draft.personas" :key="persona.id" :value="persona.id">
            {{ persona.name }} ({{ persona.id }})
          </option>
        </select>
      </label>

      <table class="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>名称</th>
            <th>温度</th>
            <th>Max Tokens</th>
            <th>System Prompt</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(persona, index) in draft.personas" :key="persona.id">
            <td><input v-model="persona.id" class="input" /></td>
            <td><input v-model="persona.name" class="input" /></td>
            <td><input v-model.number="persona.temperature" class="input" type="number" step="0.1" min="0" max="2" /></td>
            <td><input v-model.number="persona.maxTokens" class="input" type="number" min="1" /></td>
            <td><textarea v-model="persona.systemPrompt" class="textarea" /></td>
            <td>
              <button class="button ghost" @click="removePersona(index)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="row">
        <button class="button ghost" @click="addPersona">新增 Persona</button>
      </div>

      <label>
        会话绑定（每行：chatKey=personaId）
        <textarea v-model="bindingsText" class="textarea" />
      </label>

      <div class="row">
        <button class="button" :disabled="personaStore.saving" @click="save">{{ personaStore.saving ? '保存中...' : '保存' }}</button>
      </div>
      <p v-if="message" :class="isError ? 'error' : 'success'">{{ message }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ApiError } from '../api/client';
import { usePersonaStore } from '../stores/personas';
import type { PersonaRegistry } from '../types';

const personaStore = usePersonaStore();
const draft = ref<PersonaRegistry | null>(null);
const bindingsText = ref('');
const message = ref('');
const isError = ref(false);

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
    name: `Persona ${nextIndex}`,
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
  message.value = '';
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

  message.value = '';
  isError.value = false;

  const payload: PersonaRegistry = {
    ...draft.value,
    bindings: parseBindings(bindingsText.value)
  };

  try {
    await personaStore.savePersonas(payload);
    message.value = '保存成功';
    draft.value = JSON.parse(JSON.stringify(payload)) as PersonaRegistry;
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
