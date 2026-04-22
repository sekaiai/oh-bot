<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">插件配置</p>
        <h2>主路由与插件执行层</h2>
        <p class="page-description">主 AI 负责统一路由，QWeather 和倾梦处理专门能力，DS2API 作为默认执行层并支持多模型分发。</p>
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
            <p class="plugin-kicker">{{ pluginKicker(plugin) }}</p>
            <div class="plugin-title-line">
              <h3>{{ plugin.name }}</h3>
              <span class="plugin-id-badge">{{ plugin.id }}</span>
            </div>
            <p class="panel-description">{{ pluginDescription(plugin) }}</p>
          </div>

          <div class="plugin-actions">
            <button
              v-if="plugin.kind === 'qweather'"
              type="button"
              class="ui-button"
              :disabled="isTesting(plugin.id)"
              @click="testPlugin(plugin.id)"
            >
              {{ isTesting(plugin.id) ? '测试中...' : '测试插件' }}
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
              <p>{{ pluginEnabledDescription(plugin) }}</p>
            </div>
            <input v-model="plugin.enabled" class="ui-checkbox" type="checkbox" />
          </label>

          <div v-if="plugin.kind === 'ds2api'" class="plugin-test-input">
            <span class="field-label">路由测试消息</span>
            <input v-model="pluginTestInputs[plugin.id]" class="ui-input" placeholder="例如：帮我分析这个方案的优缺点" />
          </div>

          <div v-else-if="plugin.kind === 'qweather'" class="plugin-test-input">
            <span class="field-label">测试城市</span>
            <input v-model="pluginTestInputs[plugin.id]" class="ui-input" placeholder="例如：上海" />
          </div>
        </div>

        <div v-if="plugin.kind === 'ds2api'" class="plugin-section-stack">
          <section class="plugin-subpanel">
            <div class="plugin-subpanel-head">
              <div>
                <p class="plugin-kicker">连接配置</p>
                <strong>统一接入地址</strong>
              </div>
            </div>

            <div class="plugin-compact-grid plugin-compact-grid-3">
              <label class="field-block field-span-2">
                <span class="field-label">接口地址</span>
                <input v-model="plugin.baseUrl" class="ui-input" placeholder="例如 http://127.0.0.1:6011/v1" />
              </label>

              <label class="field-block field-size-xs">
                <span class="field-label">超时（ms）</span>
                <input v-model.number="plugin.timeoutMs" class="ui-input" type="number" min="1000" />
              </label>

              <label class="field-block field-span-3">
                <span class="field-label">API Key</span>
                <input v-model="plugin.apiKey" class="ui-input" type="text" placeholder="sk-..." />
              </label>
            </div>
          </section>

          <section class="plugin-subpanel">
            <div class="plugin-subpanel-head">
              <div>
                <p class="plugin-kicker">模型路由</p>
                <strong>{{ plugin.routes.length }} 条路由</strong>
                <p class="panel-description">主 AI 先判断任务类型，再从这里选择合适模型。普通消息默认会落到这里处理。</p>
              </div>
              <button type="button" class="ui-button" @click="addDs2ApiRoute(plugin.id)">
                新增路由
              </button>
            </div>

            <div class="ds2api-route-list">
              <article v-for="route in plugin.routes" :key="route.id" class="route-card">
                <div class="route-card-head">
                  <div class="route-title-stack">
                    <div class="route-title-line">
                      <input v-model="route.name" class="ui-input route-title-input" placeholder="路由名称" />
                      <span class="plugin-id-badge">{{ route.id }}</span>
                    </div>
                    <p class="field-note">主路由命中后会把消息发送给这里配置的模型。</p>
                  </div>

                  <div class="route-card-actions">
                    <label class="switch-card compact-switch">
                      <div>
                        <strong>启用</strong>
                        <p>关闭后不参与主路由选择。</p>
                      </div>
                      <input v-model="route.enabled" class="ui-checkbox" type="checkbox" />
                    </label>
                    <button
                      type="button"
                      class="ui-button"
                      :disabled="isTesting(routeTestKey(plugin.id, route.id))"
                      @click="testDs2ApiRoute(plugin.id, route.id)"
                    >
                      {{ isTesting(routeTestKey(plugin.id, route.id)) ? '测试中...' : '测试此路由' }}
                    </button>
                    <button type="button" class="ui-button ui-button-danger" @click="removeDs2ApiRoute(plugin.id, route.id)">
                      删除
                    </button>
                  </div>
                </div>

                <div class="route-core-grid">
                  <label class="field-block">
                    <span class="field-label">模型名</span>
                    <input v-model="route.model" class="ui-input" placeholder="例如 gpt-4o / o3 / gpt-5-codex" />
                  </label>

                  <label class="field-block field-size-xs">
                    <span class="field-label">温度</span>
                    <input v-model.number="route.temperature" class="ui-input" type="number" min="0" max="2" step="0.1" />
                  </label>

                  <label class="field-block field-size-xs">
                    <span class="field-label">最大输出</span>
                    <input v-model.number="route.maxTokens" class="ui-input" type="number" min="1" />
                  </label>

                  <label class="field-block field-span-3">
                    <span class="field-label">适用意图</span>
                    <textarea
                      v-model="route.intentPrompt"
                      class="ui-textarea ui-textarea-tight"
                      rows="2"
                      placeholder="例如：复杂分析、多步骤推理、方案比较、决策建议"
                    />
                  </label>
                </div>

                <details class="config-disclosure">
                  <summary>高级配置</summary>
                  <div class="disclosure-body">
                    <label class="field-block">
                      <span class="field-label">系统提示词</span>
                      <textarea
                        v-model="route.systemPrompt"
                        class="ui-textarea ui-textarea-tight"
                        rows="4"
                        placeholder="这个路由的额外系统提示词"
                      />
                    </label>
                  </div>
                </details>

                <section
                  v-if="testResults[routeTestKey(plugin.id, route.id)]"
                  class="plugin-diagnostics"
                  :class="testResults[routeTestKey(plugin.id, route.id)]?.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'"
                >
                  <div class="plugin-diagnostics-head">
                    <div>
                      <p class="plugin-kicker">Diagnostic Output</p>
                      <strong>{{ testResults[routeTestKey(plugin.id, route.id)]?.message }}</strong>
                    </div>
                    <span class="plugin-diagnostics-latency">{{ testResults[routeTestKey(plugin.id, route.id)]?.elapsedMs }} ms</span>
                  </div>

                  <pre class="plugin-diagnostics-body">{{ formatDiagnostics(testResults[routeTestKey(plugin.id, route.id)]?.details) }}</pre>
                </section>
              </article>
            </div>
          </section>
        </div>

        <div v-else-if="plugin.kind === 'qweather'" class="plugin-section-stack">
          <section class="plugin-subpanel">
            <div class="plugin-subpanel-head">
              <div>
                <p class="plugin-kicker">天气接口</p>
                <strong>主路由命中后直接调用</strong>
              </div>
            </div>

            <div class="plugin-compact-grid plugin-compact-grid-3">
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
          </section>

          <section
            v-if="testResults[plugin.id]"
            class="plugin-diagnostics"
            :class="testResults[plugin.id]?.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'"
          >
            <div class="plugin-diagnostics-head">
              <div>
                <p class="plugin-kicker">Diagnostic Output</p>
                <strong>{{ testResults[plugin.id]?.message }}</strong>
              </div>
              <span class="plugin-diagnostics-latency">{{ testResults[plugin.id]?.elapsedMs }} ms</span>
            </div>

            <pre class="plugin-diagnostics-body">{{ formatDiagnostics(testResults[plugin.id]?.details) }}</pre>
          </section>
        </div>

        <div v-else class="plugin-section-stack">
          <section class="plugin-subpanel">
            <div class="plugin-subpanel-head">
              <div>
                <p class="plugin-kicker">插件概览</p>
                <strong>接口网关与参数规则</strong>
              </div>
              <button type="button" class="ui-button" @click="openQingmengEditor(plugin.id)">
                新增接口
              </button>
            </div>

            <div class="plugin-compact-grid plugin-compact-grid-3">
              <label class="field-block field-span-2">
                <span class="field-label">CKEY</span>
                <input v-model="plugin.ckey" class="ui-input" type="text" placeholder="PFEIWB8Z6KQBW850QTCL" />
              </label>

              <details class="config-disclosure field-span-3">
                <summary>显示高级路由提示词</summary>
                <div class="disclosure-body">
                  <label class="field-block">
                    <span class="field-label">分类提示词</span>
                    <textarea v-model="plugin.classifierPrompt" class="ui-textarea ui-textarea-tight" rows="4" />
                  </label>
                </div>
              </details>
            </div>
          </section>

          <div v-for="group in groupedQingmeng(plugin)" :key="group.id" class="plugin-group">
            <div class="plugin-group-head">
              <div>
                <p class="plugin-kicker">{{ group.label }}</p>
                <strong>{{ group.items.length }} 个接口</strong>
              </div>
            </div>

            <div class="endpoint-stack">
              <article v-for="endpoint in group.items" :key="endpoint.id" class="endpoint-summary-card">
                <div class="endpoint-summary-copy">
                  <h4>{{ endpoint.name }}</h4>
                  <p class="endpoint-intent-text">{{ endpoint.intentPrompt || '未配置意图说明' }}</p>
                </div>

                <div class="endpoint-summary-actions">
                  <button type="button" class="ui-button" @click="openQingmengEditor(plugin.id, endpoint.id)">
                    修改
                  </button>
                </div>
              </article>
            </div>
          </div>
        </div>
      </article>
    </div>

    <article v-else class="surface-panel empty-panel">
      {{ pluginStore.loading ? '正在读取插件配置...' : '暂无插件配置数据' }}
    </article>

    <AModal
      v-model:visible="qingmengEditor.visible"
      :title="qingmengEditorTitle"
      :footer="false"
      :width="980"
      unmount-on-close
      @cancel="closeQingmengEditor"
    >
      <div class="field-stack">
        <div class="modal-summary-list">
          <div class="modal-summary-item">
            <span>插件</span>
            <strong>{{ qingmengEditor.pluginName || '倾梦API' }}</strong>
          </div>
          <div class="modal-summary-item">
            <span>当前接口</span>
            <strong>{{ qingmengEditor.endpointId || '新接口' }}</strong>
          </div>
          <div class="modal-summary-item">
            <span>状态</span>
            <strong>{{ qingmengEditor.isCreating ? '新增中' : '编辑中' }}</strong>
          </div>
        </div>

        <p v-if="qingmengEditor.feedback" class="inline-feedback" :class="qingmengEditor.feedbackError ? 'inline-feedback-error' : 'inline-feedback-success'">
          {{ qingmengEditor.feedback }}
        </p>

        <label class="field-block">
          <span class="field-label">接口 JSON</span>
          <textarea
            v-model="qingmengEditor.json"
            class="ui-textarea qingmeng-json-editor"
            spellcheck="false"
            rows="22"
          />
        </label>

        <div class="plugin-compact-grid plugin-compact-grid-2">
          <label class="field-block">
            <span class="field-label">测试文本</span>
            <input v-model="qingmengEditor.testInput" class="ui-input" placeholder="测试消息" />
          </label>

          <label class="field-block">
            <span class="field-label">测试图片 URL</span>
            <input v-model="qingmengEditor.testImageUrl" class="ui-input" placeholder="看图接口可填一张图片链接" />
          </label>
        </div>

        <section
          v-if="qingmengEditor.testResult"
          class="plugin-diagnostics"
          :class="qingmengEditor.testResult.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'"
        >
          <div class="plugin-diagnostics-head">
            <div>
              <p class="plugin-kicker">Diagnostic Output</p>
              <strong>{{ qingmengEditor.testResult.message }}</strong>
            </div>
            <span class="plugin-diagnostics-latency">{{ qingmengEditor.testResult.elapsedMs }} ms</span>
          </div>

          <pre class="plugin-diagnostics-body">{{ formatDiagnostics(qingmengEditor.testResult.details) }}</pre>
        </section>

        <div class="modal-footer-actions">
          <button type="button" class="ui-button" @click="closeQingmengEditor">
            取消
          </button>
          <button type="button" class="ui-button" :disabled="qingmengEditor.testing" @click="testQingmengEditor">
            {{ qingmengEditor.testing ? '测试中...' : '测试' }}
          </button>
          <button type="button" class="ui-button ui-button-primary" :disabled="qingmengEditor.saving" @click="saveQingmengEditor">
            {{ qingmengEditor.saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </AModal>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Modal as AModal } from '@arco-design/web-vue';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { usePluginStore } from '../stores/plugins';
import type {
  Ds2ApiPluginConfig,
  Ds2ApiRouteConfig,
  PluginConfig,
  PluginTestResult,
  QingmengEndpointConfig,
  QingmengPluginConfig
} from '../types';

const qingmengParameterJsonSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  source: z.enum(['fixed', 'intent', 'image_url']),
  required: z.boolean(),
  defaultValue: z.string()
});

const qingmengEndpointJsonSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  group: z.enum(['image', 'video', 'audio', 'text', 'tool', 'analysis']),
  description: z.string().min(1),
  intentAliases: z.array(z.string().min(1)),
  fallbackEligible: z.boolean(),
  method: z.literal('GET'),
  url: z.string().url(),
  intentPrompt: z.string().min(1),
  parameters: z.array(qingmengParameterJsonSchema),
  responseMode: z.enum(['json_value', 'json_list', 'openai_text', 'redirect_media']),
  responsePath: z.string().optional(),
  listPath: z.string().optional(),
  itemTitlePath: z.string().optional(),
  itemUrlPath: z.string().optional(),
  captionTemplate: z.string().optional(),
  sampleInput: z.string(),
  sampleImageUrl: z.union([z.string().url(), z.literal('')]).optional()
});

const pluginStore = usePluginStore();
const plugins = ref<PluginConfig[]>([]);
const pluginTestInputs = ref<Record<string, string>>({});
const testResults = ref<Record<string, PluginTestResult | null>>({});
const notice = ref({
  text: '',
  error: false
});

const qingmengEditor = ref({
  visible: false,
  pluginId: '',
  pluginName: '',
  endpointId: '',
  isCreating: false,
  json: '',
  testInput: '',
  testImageUrl: '',
  testResult: null as PluginTestResult | null,
  feedback: '',
  feedbackError: false,
  saving: false,
  testing: false
});

const qingmengEditorTitle = computed(() => {
  return qingmengEditor.value.isCreating ? '新增倾梦接口' : `修改接口：${qingmengEditor.value.endpointId}`;
});

function clonePlugins(items: PluginConfig[]): PluginConfig[] {
  return JSON.parse(JSON.stringify(items)) as PluginConfig[];
}

function pluginKicker(plugin: PluginConfig): string {
  if (plugin.kind === 'ds2api') {
    return 'Default Execution Layer';
  }

  if (plugin.kind === 'qweather') {
    return 'Realtime Tool Plugin';
  }

  return 'Interface Capability Plugin';
}

function pluginDescription(plugin: PluginConfig): string {
  if (plugin.kind === 'ds2api') {
    return '主 AI 识别普通问答、复杂分析和代码类问题后，会从这里选择合适的模型路由执行。';
  }

  if (plugin.kind === 'qweather') {
    return '处理天气、空气质量、预警、紫外线、日出日落等实时查询。';
  }

  return '主 AI 先判断是否需要外部接口能力，再由倾梦插件继续细分到具体接口。';
}

function pluginEnabledDescription(plugin: PluginConfig): string {
  if (plugin.kind === 'ds2api') {
    return '关闭后，主路由无法把普通消息交给 DS2API 多模型执行层。';
  }

  if (plugin.kind === 'qweather') {
    return '关闭后，天气相关消息不会再走实时天气插件。';
  }

  return '关闭后，主路由不再把图片、视频、新闻、分析类请求交给倾梦插件。';
}

function routeTestKey(pluginId: string, routeId: string): string {
  return `${pluginId}:route:${routeId}`;
}

function syncLocalState(items: PluginConfig[]): void {
  const previousPluginInputs = { ...pluginTestInputs.value };

  plugins.value = clonePlugins(items);
  pluginTestInputs.value = {};

  for (const plugin of plugins.value) {
    if (plugin.kind === 'ds2api') {
      pluginTestInputs.value[plugin.id] = previousPluginInputs[plugin.id] || '帮我分析这个方案的优缺点';
      continue;
    }

    if (plugin.kind === 'qweather') {
      pluginTestInputs.value[plugin.id] = previousPluginInputs[plugin.id] || '北京';
    }
  }
}

function getPlugin(pluginId: string): PluginConfig | undefined {
  return plugins.value.find((item) => item.id === pluginId);
}

function getQingmengPlugin(pluginId: string): QingmengPluginConfig | undefined {
  const plugin = getPlugin(pluginId);
  return plugin?.kind === 'qingmeng' ? plugin : undefined;
}

function isSaving(key: string): boolean {
  return pluginStore.savingIds.includes(key);
}

function isTesting(key: string): boolean {
  return pluginStore.testingIds.includes(key);
}

function normalizePlugin(plugin: PluginConfig): PluginConfig {
  return JSON.parse(JSON.stringify(plugin)) as PluginConfig;
}

function formatDiagnostics(details: unknown): string {
  if (!details) {
    return '无诊断输出';
  }

  return JSON.stringify(details, null, 2);
}

function groupedQingmeng(plugin: QingmengPluginConfig): Array<{ id: string; label: string; items: QingmengEndpointConfig[] }> {
  const labels: Record<QingmengEndpointConfig['group'], string> = {
    analysis: '图片分析',
    tool: '工具与查询',
    text: '文本输出',
    image: '图片接口',
    video: '视频接口',
    audio: '语音接口'
  };

  const order: QingmengEndpointConfig['group'][] = ['analysis', 'tool', 'text', 'image', 'video', 'audio'];
  return order
    .map((group) => ({
      id: group,
      label: labels[group],
      items: plugin.endpoints.filter((endpoint) => endpoint.group === group)
    }))
    .filter((group) => group.items.length > 0);
}

function buildDefaultDs2ApiRoute(): Ds2ApiRouteConfig {
  return {
    id: `route-${Math.random().toString(36).slice(2, 8)}`,
    name: '新路由',
    enabled: true,
    model: 'gpt-4o',
    intentPrompt: '',
    systemPrompt: '',
    temperature: 0.3,
    maxTokens: 1024
  };
}

function buildDefaultEndpoint(): QingmengEndpointConfig {
  return {
    id: `endpoint-${Math.random().toString(36).slice(2, 8)}`,
    name: '新接口',
    enabled: true,
    group: 'tool',
    description: '请填写接口说明',
    intentAliases: [],
    fallbackEligible: false,
    method: 'GET',
    url: 'https://api.317ak.cn/api/example',
    intentPrompt: '请填写这个接口应该命中的用户意图',
    parameters: [],
    responseMode: 'json_value',
    responsePath: '',
    listPath: '',
    itemTitlePath: '',
    itemUrlPath: '',
    captionTemplate: '',
    sampleInput: '',
    sampleImageUrl: ''
  };
}

function buildQingmengEditorPlugin(plugin: QingmengPluginConfig, originalEndpointId: string, nextEndpoint: QingmengEndpointConfig): QingmengPluginConfig {
  const nextPlugin = normalizePlugin(plugin) as QingmengPluginConfig;
  const endpointIndex = nextPlugin.endpoints.findIndex((item) => item.id === originalEndpointId);

  if (endpointIndex >= 0) {
    nextPlugin.endpoints.splice(endpointIndex, 1, nextEndpoint);
  } else {
    nextPlugin.endpoints.push(nextEndpoint);
  }

  return nextPlugin;
}

function parseQingmengEndpointJson(): QingmengEndpointConfig {
  const parsedJson = JSON.parse(qingmengEditor.value.json) as unknown;
  const endpoint = qingmengEndpointJsonSchema.parse(parsedJson);
  return {
    ...endpoint,
    sampleImageUrl: endpoint.sampleImageUrl ?? ''
  };
}

function validateEndpointIdUniqueness(plugin: QingmengPluginConfig, originalEndpointId: string, nextEndpointId: string): void {
  const exists = plugin.endpoints.some((endpoint) => endpoint.id === nextEndpointId && endpoint.id !== originalEndpointId);
  if (exists) {
    throw new Error(`接口 ID「${nextEndpointId}」已存在，请更换后再保存。`);
  }
}

function resetQingmengEditorFeedback(): void {
  qingmengEditor.value.feedback = '';
  qingmengEditor.value.feedbackError = false;
}

function openQingmengEditor(pluginId: string, endpointId = ''): void {
  const plugin = getQingmengPlugin(pluginId);
  if (!plugin) {
    return;
  }

  const endpoint = endpointId
    ? plugin.endpoints.find((item) => item.id === endpointId) ?? buildDefaultEndpoint()
    : buildDefaultEndpoint();

  qingmengEditor.value = {
    visible: true,
    pluginId,
    pluginName: plugin.name,
    endpointId,
    isCreating: !endpointId,
    json: JSON.stringify(endpoint, null, 2),
    testInput: endpoint.sampleInput || '',
    testImageUrl: endpoint.sampleImageUrl || '',
    testResult: null,
    feedback: '',
    feedbackError: false,
    saving: false,
    testing: false
  };
}

function closeQingmengEditor(): void {
  qingmengEditor.value.visible = false;
}

function addDs2ApiRoute(pluginId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'ds2api') {
    return;
  }

  plugin.routes.push(buildDefaultDs2ApiRoute());
}

function removeDs2ApiRoute(pluginId: string, routeId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'ds2api') {
    return;
  }

  plugin.routes = plugin.routes.filter((route) => route.id !== routeId);
  delete testResults.value[routeTestKey(pluginId, routeId)];
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
  if (!plugin || plugin.kind !== 'qweather') {
    return;
  }

  const payload = normalizePlugin(plugin);

  try {
    const result = await pluginStore.testPlugin(payload, {
      input: pluginTestInputs.value[pluginId] ?? ''
    }, plugin.id);
    testResults.value[plugin.id] = result;
    notice.value = { text: `插件 ${payload.name} 测试完成`, error: !result.ok };
  } catch (error) {
    testResults.value[plugin.id] = null;
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: `插件 ${payload.name} 测试失败`, error: true };
  }
}

async function testDs2ApiRoute(pluginId: string, routeId: string): Promise<void> {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'ds2api') {
    return;
  }

  const payload = normalizePlugin(plugin);
  const key = routeTestKey(plugin.id, routeId);

  try {
    const result = await pluginStore.testPlugin(payload, {
      input: pluginTestInputs.value[pluginId] ?? '',
      routeId
    }, key);
    testResults.value[key] = result;
    notice.value = { text: `DS2API 路由测试完成：${routeId}`, error: !result.ok };
  } catch (error) {
    testResults.value[key] = null;
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: `DS2API 路由测试失败：${routeId}`, error: true };
  }
}

async function testQingmengEditor(): Promise<void> {
  const plugin = getQingmengPlugin(qingmengEditor.value.pluginId);
  if (!plugin) {
    return;
  }

  resetQingmengEditorFeedback();
  qingmengEditor.value.testing = true;

  try {
    const endpoint = parseQingmengEndpointJson();
    validateEndpointIdUniqueness(plugin, qingmengEditor.value.endpointId, endpoint.id);
    const payload = buildQingmengEditorPlugin(plugin, qingmengEditor.value.endpointId, endpoint);
    const result = await pluginStore.testPlugin(
      payload,
      {
        endpointId: endpoint.id,
        input: qingmengEditor.value.testInput,
        imageUrl: qingmengEditor.value.testImageUrl
      },
      'qingmeng-editor'
    );
    qingmengEditor.value.testResult = result;
    qingmengEditor.value.feedback = `接口测试完成：${endpoint.id}`;
    qingmengEditor.value.feedbackError = !result.ok;
  } catch (error) {
    qingmengEditor.value.testResult = null;
    qingmengEditor.value.feedback = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '接口测试失败';
    qingmengEditor.value.feedbackError = true;
  } finally {
    qingmengEditor.value.testing = false;
  }
}

async function saveQingmengEditor(): Promise<void> {
  const plugin = getQingmengPlugin(qingmengEditor.value.pluginId);
  if (!plugin) {
    return;
  }

  resetQingmengEditorFeedback();
  qingmengEditor.value.saving = true;

  try {
    const endpoint = parseQingmengEndpointJson();
    validateEndpointIdUniqueness(plugin, qingmengEditor.value.endpointId, endpoint.id);
    const payload = buildQingmengEditorPlugin(plugin, qingmengEditor.value.endpointId, endpoint);
    await pluginStore.savePlugin(payload);
    syncLocalState(pluginStore.items);
    notice.value = { text: `倾梦接口 ${endpoint.name} 已保存`, error: false };
    closeQingmengEditor();
  } catch (error) {
    qingmengEditor.value.feedback = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '接口保存失败';
    qingmengEditor.value.feedbackError = true;
  } finally {
    qingmengEditor.value.saving = false;
  }
}

void load();
</script>
