<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">插件配置</p>
        <h2>接口插件与即时诊断</h2>
        <p class="page-description">把配置、测试和结果放在同一张插件面板里。长字段占主位，短字段压缩成辅助列，减少无效留白。</p>
      </div>

      <button type="button" class="ui-button" :disabled="pluginStore.loading" @click="load">
        {{ pluginStore.loading ? '刷新中...' : '刷新插件' }}
      </button>
    </div>

    <p v-if="notice.text" class="inline-feedback" :class="notice.error ? 'inline-feedback-error' : 'inline-feedback-success'">
      {{ notice.text }}
    </p>

    <div v-if="plugins.length > 0" class="plugin-stack">
      <article v-for="plugin in plugins" :key="plugin.id" class="surface-panel plugin-card">
        <div class="plugin-card-top">
          <div class="plugin-title-block">
            <p class="plugin-kicker">{{ plugin.kind === 'ds2api' ? 'AI Plugin' : 'Weather Plugin' }}</p>
            <div class="plugin-title-line">
              <h3>{{ plugin.name }}</h3>
              <span class="plugin-id-badge">{{ plugin.id }}</span>
            </div>
            <p class="panel-description">
              {{ plugin.kind === 'ds2api' ? '命中关键词后切换到 DS2API 接口。' : '处理天气、空气质量、预警等实时查询。' }}
            </p>
          </div>

          <div class="plugin-actions">
            <button
              type="button"
              class="ui-button"
              :disabled="isTesting(plugin.id)"
              @click="testPlugin(plugin.id)"
            >
              {{ isTesting(plugin.id) ? '测试中...' : `测试 ${plugin.name}` }}
            </button>
            <button
              type="button"
              class="ui-button ui-button-primary"
              :disabled="isSaving(plugin.id)"
              @click="savePlugin(plugin.id)"
            >
              {{ isSaving(plugin.id) ? '保存中...' : `保存 ${plugin.name}` }}
            </button>
          </div>
        </div>

        <div class="plugin-meta-strip">
          <label class="switch-card plugin-switch">
            <div>
              <strong>启用插件</strong>
              <p>关闭后将直接阻断这个插件的调用入口。</p>
            </div>
            <input v-model="plugin.enabled" class="ui-checkbox" type="checkbox" />
          </label>

          <div class="plugin-test-input">
            <span class="field-label">{{ plugin.kind === 'ds2api' ? '测试消息' : '测试城市' }}</span>
            <input
              v-model="testInputs[plugin.id]"
              class="ui-input"
              :placeholder="plugin.kind === 'ds2api' ? '例如：请认真分析一下这个问题' : '例如：北京'"
            />
          </div>
        </div>

        <div v-if="plugin.kind === 'ds2api'" class="plugin-form-grid plugin-form-grid-ds2api">
          <label class="field-block field-span-2">
            <span class="field-label">接口地址</span>
            <input v-model="plugin.baseUrl" class="ui-input" placeholder="例如 http://127.0.0.1:6011/v1" />
          </label>

          <label class="field-block">
            <span class="field-label">模型名</span>
            <input v-model="plugin.model" class="ui-input" placeholder="例如 gpt-4o / o3" />
          </label>

          <label class="field-block field-size-xs">
            <span class="field-label">超时（ms）</span>
            <input v-model.number="plugin.timeoutMs" class="ui-input" type="number" min="1000" />
          </label>

          <label class="field-block field-span-3">
            <span class="field-label">API Key</span>
            <input v-model="plugin.apiKey" class="ui-input" type="text" placeholder="sk-..." />
          </label>

          <label class="field-block field-span-2">
            <span class="field-label">触发关键词</span>
            <textarea v-model="keywordForms[plugin.id]" class="ui-textarea ui-textarea-compact" rows="5" />
          </label>

          <div class="plugin-side-stack">
            <label class="field-block">
              <span class="field-label">温度</span>
              <input v-model.number="plugin.temperature" class="ui-input" type="number" min="0" max="2" step="0.1" />
            </label>

            <label class="field-block">
              <span class="field-label">最大输出</span>
              <input v-model.number="plugin.maxTokens" class="ui-input" type="number" min="1" />
            </label>
          </div>

          <label class="field-block field-span-3">
            <span class="field-label">插件提示词</span>
            <textarea v-model="plugin.systemPrompt" class="ui-textarea" rows="7" />
          </label>
        </div>

        <div v-else-if="plugin.kind === 'qweather'" class="plugin-form-grid plugin-form-grid-qweather">
          <label class="field-block field-span-2">
            <span class="field-label">API Host</span>
            <input v-model="plugin.apiHost" class="ui-input" placeholder="https://devapi.qweather.com" />
          </label>

          <label class="field-block field-size-sm">
            <span class="field-label">语言</span>
            <input v-model="plugin.lang" class="ui-input" placeholder="zh" />
          </label>

          <label class="field-block field-span-3">
            <span class="field-label">API Key</span>
            <input v-model="plugin.apiKey" class="ui-input" type="text" placeholder="和风天气 Key" />
          </label>
        </div>

        <section v-if="testResults[plugin.id]" class="plugin-diagnostics" :class="testResults[plugin.id]?.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'">
          <div class="plugin-diagnostics-head">
            <div>
              <p class="plugin-kicker">Diagnostic Output</p>
              <strong>{{ testResults[plugin.id]?.message }}</strong>
            </div>
            <span class="plugin-diagnostics-latency">{{ testResults[plugin.id]?.elapsedMs }} ms</span>
          </div>

          <pre class="plugin-diagnostics-body">{{ formatDiagnostics(testResults[plugin.id]?.details) }}</pre>
        </section>
      </article>
    </div>

    <article v-else class="surface-panel empty-panel">
      {{ pluginStore.loading ? '正在读取插件配置...' : '暂无插件配置数据' }}
    </article>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ApiError } from '../api/client';
import { usePluginStore } from '../stores/plugins';
import type { Ds2ApiPluginConfig, PluginConfig, PluginTestResult } from '../types';

const pluginStore = usePluginStore();
const plugins = ref<PluginConfig[]>([]);
const keywordForms = ref<Record<string, string>>({});
const testInputs = ref<Record<string, string>>({});
const testResults = ref<Record<string, PluginTestResult | null>>({});
const notice = ref({
  text: '',
  error: false
});

function clonePlugins(items: PluginConfig[]): PluginConfig[] {
  return JSON.parse(JSON.stringify(items)) as PluginConfig[];
}

function syncLocalState(items: PluginConfig[]): void {
  const previousTestInputs = { ...testInputs.value };
  plugins.value = clonePlugins(items);
  keywordForms.value = {};
  testInputs.value = {};

  for (const plugin of plugins.value) {
    if (plugin.kind === 'ds2api') {
      keywordForms.value[plugin.id] = plugin.triggerKeywords.join('\n');
      testInputs.value[plugin.id] = previousTestInputs[plugin.id] || '请认真分析一下这个问题';
    } else if (plugin.kind === 'qweather') {
      testInputs.value[plugin.id] = previousTestInputs[plugin.id] || '北京';
    }
  }
}

function getPlugin(pluginId: string): PluginConfig | undefined {
  return plugins.value.find((item) => item.id === pluginId);
}

function isSaving(pluginId: string): boolean {
  return pluginStore.savingIds.includes(pluginId);
}

function isTesting(pluginId: string): boolean {
  return pluginStore.testingIds.includes(pluginId);
}

function normalizePlugin(plugin: PluginConfig): PluginConfig {
  if (plugin.kind === 'ds2api') {
    const nextPlugin: Ds2ApiPluginConfig = {
      ...plugin,
      triggerKeywords: (keywordForms.value[plugin.id] ?? '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    };
    return nextPlugin;
  }

  return { ...plugin };
}

function formatDiagnostics(details: unknown): string {
  if (!details) {
    return '无诊断输出';
  }

  return JSON.stringify(details, null, 2);
}

async function load(): Promise<void> {
  notice.value = { text: '', error: false };
  await pluginStore.fetchPlugins();
  syncLocalState(pluginStore.items);
}

async function savePlugin(pluginId: string): Promise<void> {
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    return;
  }

  const payload = normalizePlugin(plugin);

  try {
    await pluginStore.savePlugin(payload);
    syncLocalState(pluginStore.items);
    notice.value = { text: `插件 ${payload.name} 已保存`, error: false };
  } catch (error) {
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: `插件 ${payload.name} 保存失败`, error: true };
  }
}

async function testPlugin(pluginId: string): Promise<void> {
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    return;
  }

  const payload = normalizePlugin(plugin);

  try {
    const result = await pluginStore.testPlugin(payload, testInputs.value[pluginId] ?? '');
    testResults.value[pluginId] = result;
    notice.value = { text: `插件 ${payload.name} 测试完成`, error: !result.ok };
  } catch (error) {
    testResults.value[pluginId] = null;
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: `插件 ${payload.name} 测试失败`, error: true };
  }
}

void load();
</script>
