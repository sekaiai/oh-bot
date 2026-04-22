<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">插件配置</p>
        <h2>接口插件与即时诊断</h2>
        <p class="page-description">主 AI 保持固定，插件负责接外部接口。倾梦接口支持分组、参数提取、单接口测试和实时诊断。</p>
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
              v-if="plugin.kind !== 'qingmeng'"
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
              <p>关闭后会直接阻断这个插件的调用入口。</p>
            </div>
            <input v-model="plugin.enabled" class="ui-checkbox" type="checkbox" />
          </label>

          <div v-if="plugin.kind !== 'qingmeng'" class="plugin-test-input">
            <span class="field-label">{{ plugin.kind === 'ds2api' ? '测试消息' : '测试城市' }}</span>
            <input
              v-model="pluginTestInputs[plugin.id]"
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

        <div v-else class="qingmeng-shell">
          <div class="qingmeng-toolbar">
            <label class="field-block">
              <span class="field-label">CKEY</span>
              <input v-model="plugin.ckey" class="ui-input" type="text" placeholder="PFEIWB8Z6KQBW850QTCL" />
            </label>

            <button type="button" class="ui-button" @click="addQingmengEndpoint(plugin.id)">
              新增接口
            </button>
          </div>

          <label class="field-block">
            <span class="field-label">意图分类提示词</span>
            <textarea v-model="plugin.classifierPrompt" class="ui-textarea" rows="5" />
          </label>

          <div v-for="group in groupedQingmeng(plugin)" :key="group.id" class="plugin-group">
            <div class="plugin-group-head">
              <div>
                <p class="plugin-kicker">{{ group.label }}</p>
                <strong>{{ group.items.length }} 个接口</strong>
              </div>
            </div>

            <div class="endpoint-stack">
              <article v-for="endpoint in group.items" :key="endpoint.id" class="endpoint-card">
                <div class="endpoint-head">
                  <div class="endpoint-title-stack">
                    <div class="endpoint-title-line">
                      <input v-model="endpoint.name" class="ui-input endpoint-title-input" placeholder="接口名称" />
                      <span class="plugin-id-badge">{{ endpoint.id }}</span>
                    </div>
                    <textarea v-model="endpoint.description" class="ui-textarea ui-textarea-compact" rows="2" placeholder="接口说明" />
                  </div>

                  <div class="endpoint-head-actions">
                    <label class="switch-card endpoint-switch">
                      <div>
                        <strong>启用</strong>
                        <p>命中意图后才会参与路由。</p>
                      </div>
                      <input v-model="endpoint.enabled" class="ui-checkbox" type="checkbox" />
                    </label>
                    <button type="button" class="ui-button" :disabled="isTesting(endpointTestKey(plugin.id, endpoint.id))" @click="testQingmengEndpoint(plugin.id, endpoint.id)">
                      {{ isTesting(endpointTestKey(plugin.id, endpoint.id)) ? '测试中...' : '测试接口' }}
                    </button>
                    <button type="button" class="ui-button ui-button-danger" @click="removeQingmengEndpoint(plugin.id, endpoint.id)">
                      删除
                    </button>
                  </div>
                </div>

                <div class="endpoint-grid">
                  <label class="field-block">
                    <span class="field-label">接口 ID</span>
                    <input v-model="endpoint.id" class="ui-input" placeholder="endpoint-id" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">分组</span>
                    <select v-model="endpoint.group" class="ui-select">
                      <option value="analysis">图片分析</option>
                      <option value="tool">工具</option>
                      <option value="text">文本</option>
                      <option value="image">图片</option>
                      <option value="video">视频</option>
                      <option value="audio">语音</option>
                    </select>
                  </label>

                  <label class="field-block">
                    <span class="field-label">请求方式</span>
                    <input v-model="endpoint.method" class="ui-input" readonly />
                  </label>

                  <label class="field-block field-span-2">
                    <span class="field-label">接口地址</span>
                    <input v-model="endpoint.url" class="ui-input" placeholder="https://api.317ak.cn/api/..." />
                  </label>

                  <label class="field-block field-span-2">
                    <span class="field-label">意图说明</span>
                    <textarea v-model="endpoint.intentPrompt" class="ui-textarea ui-textarea-compact" rows="3" />
                  </label>

                  <label class="field-block field-span-2">
                    <span class="field-label">意图别名</span>
                    <textarea
                      v-model="qingmengAliasForms[endpointTestKey(plugin.id, endpoint.id)]"
                      class="ui-textarea ui-textarea-compact"
                      rows="3"
                      placeholder="一行一个，例如：JK&#10;jk图片&#10;制服图"
                    />
                  </label>

                  <label class="switch-card endpoint-switch">
                    <div>
                      <strong>允许随机分发</strong>
                      <p>只在“来张图片 / 来个视频 / 来段语音”这类模糊意图下参与随机池。</p>
                    </div>
                    <input v-model="endpoint.fallbackEligible" class="ui-checkbox" type="checkbox" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">响应模式</span>
                    <select v-model="endpoint.responseMode" class="ui-select">
                      <option value="json_value">JSON 单值</option>
                      <option value="json_list">JSON 列表</option>
                      <option value="openai_text">OpenAI 文本</option>
                      <option value="redirect_media">媒体直出</option>
                    </select>
                  </label>

                  <label class="field-block">
                    <span class="field-label">标题文案</span>
                    <input v-model="endpoint.captionTemplate" class="ui-input" placeholder="发送前的说明文字" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">responsePath</span>
                    <input v-model="endpoint.responsePath" class="ui-input" placeholder="例如 text / choices.0.message.content / $self" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">listPath</span>
                    <input v-model="endpoint.listPath" class="ui-input" placeholder="例如 data" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">itemTitlePath</span>
                    <input v-model="endpoint.itemTitlePath" class="ui-input" placeholder="例如 title" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">itemUrlPath</span>
                    <input v-model="endpoint.itemUrlPath" class="ui-input" placeholder="例如 url / Url" />
                  </label>
                </div>

                <div class="endpoint-test-grid">
                  <label class="field-block">
                    <span class="field-label">测试文本</span>
                    <input v-model="qingmengTestInputs[endpointTestKey(plugin.id, endpoint.id)]" class="ui-input" placeholder="测试消息" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">测试图片 URL</span>
                    <input v-model="qingmengTestImages[endpointTestKey(plugin.id, endpoint.id)]" class="ui-input" placeholder="看图接口可填一张图片链接" />
                  </label>
                </div>

                <section class="endpoint-params">
                  <div class="plugin-group-head">
                    <div>
                      <p class="plugin-kicker">参数</p>
                      <strong>{{ endpoint.parameters.length }} 项</strong>
                    </div>
                    <button type="button" class="ui-button" @click="addEndpointParam(plugin.id, endpoint.id)">
                      新增参数
                    </button>
                  </div>

                  <div v-if="endpoint.parameters.length > 0" class="endpoint-param-stack">
                    <div v-for="parameter in endpoint.parameters" :key="parameter.id" class="endpoint-param-row">
                      <input v-model="parameter.id" class="ui-input" placeholder="param-id" />
                      <input v-model="parameter.name" class="ui-input" placeholder="参数名" />
                      <input v-model="parameter.label" class="ui-input" placeholder="标题" />
                      <select v-model="parameter.source" class="ui-select">
                        <option value="fixed">固定值</option>
                        <option value="intent">意图抽取</option>
                        <option value="image_url">图片 URL</option>
                      </select>
                      <input v-model="parameter.defaultValue" class="ui-input" placeholder="默认值" />
                      <label class="endpoint-param-check">
                        <input v-model="parameter.required" class="ui-checkbox" type="checkbox" />
                        <span>必填</span>
                      </label>
                      <button type="button" class="ui-button ui-button-ghost" @click="removeEndpointParam(plugin.id, endpoint.id, parameter.id)">
                        删除
                      </button>
                      <textarea v-model="parameter.description" class="ui-textarea ui-textarea-compact endpoint-param-description" rows="2" placeholder="参数含义与抽取方式" />
                    </div>
                  </div>

                  <p v-else class="inline-notice inline-notice-info">这个接口当前没有参数。</p>
                </section>

                <section v-if="testResults[endpointTestKey(plugin.id, endpoint.id)]" class="plugin-diagnostics" :class="testResults[endpointTestKey(plugin.id, endpoint.id)]?.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'">
                  <div class="plugin-diagnostics-head">
                    <div>
                      <p class="plugin-kicker">Diagnostic Output</p>
                      <strong>{{ testResults[endpointTestKey(plugin.id, endpoint.id)]?.message }}</strong>
                    </div>
                    <span class="plugin-diagnostics-latency">{{ testResults[endpointTestKey(plugin.id, endpoint.id)]?.elapsedMs }} ms</span>
                  </div>

                  <pre class="plugin-diagnostics-body">{{ formatDiagnostics(testResults[endpointTestKey(plugin.id, endpoint.id)]?.details) }}</pre>
                </section>
              </article>
            </div>
          </div>
        </div>

        <section
          v-if="plugin.kind !== 'qingmeng' && testResults[plugin.id]"
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
import type {
  Ds2ApiPluginConfig,
  PluginConfig,
  PluginTestResult,
  QingmengEndpointConfig,
  QingmengEndpointParameter,
  QingmengPluginConfig
} from '../types';

const pluginStore = usePluginStore();
const plugins = ref<PluginConfig[]>([]);
const keywordForms = ref<Record<string, string>>({});
const qingmengAliasForms = ref<Record<string, string>>({});
const pluginTestInputs = ref<Record<string, string>>({});
const qingmengTestInputs = ref<Record<string, string>>({});
const qingmengTestImages = ref<Record<string, string>>({});
const testResults = ref<Record<string, PluginTestResult | null>>({});
const notice = ref({
  text: '',
  error: false
});

function clonePlugins(items: PluginConfig[]): PluginConfig[] {
  return JSON.parse(JSON.stringify(items)) as PluginConfig[];
}

function pluginKicker(plugin: PluginConfig): string {
  if (plugin.kind === 'ds2api') {
    return 'AI Plugin';
  }

  if (plugin.kind === 'qweather') {
    return 'Weather Plugin';
  }

  return 'Interface Plugin';
}

function pluginDescription(plugin: PluginConfig): string {
  if (plugin.kind === 'ds2api') {
    return '命中关键词后切换到 DS2API 接口。';
  }

  if (plugin.kind === 'qweather') {
    return '处理天气、空气质量、预警等实时查询。';
  }

  return '用主 AI 做意图判断，再调用倾梦 API 的具体接口并发送图文、视频、语音或文本结果。';
}

function endpointTestKey(pluginId: string, endpointId: string): string {
  return `${pluginId}:${endpointId}`;
}

function syncLocalState(items: PluginConfig[]): void {
  const previousPluginInputs = { ...pluginTestInputs.value };
  const previousAliasForms = { ...qingmengAliasForms.value };
  const previousEndpointInputs = { ...qingmengTestInputs.value };
  const previousEndpointImages = { ...qingmengTestImages.value };

  plugins.value = clonePlugins(items);
  keywordForms.value = {};
  qingmengAliasForms.value = {};
  pluginTestInputs.value = {};
  qingmengTestInputs.value = {};
  qingmengTestImages.value = {};

  for (const plugin of plugins.value) {
    if (plugin.kind === 'ds2api') {
      keywordForms.value[plugin.id] = plugin.triggerKeywords.join('\n');
      pluginTestInputs.value[plugin.id] = previousPluginInputs[plugin.id] || '请认真分析一下这个问题';
      continue;
    }

    if (plugin.kind === 'qweather') {
      pluginTestInputs.value[plugin.id] = previousPluginInputs[plugin.id] || '北京';
      continue;
    }

    for (const endpoint of plugin.endpoints) {
      const key = endpointTestKey(plugin.id, endpoint.id);
      qingmengAliasForms.value[key] = previousAliasForms[key] || endpoint.intentAliases.join('\n');
      qingmengTestInputs.value[key] = previousEndpointInputs[key] || endpoint.sampleInput || '';
      qingmengTestImages.value[key] = previousEndpointImages[key] || endpoint.sampleImageUrl || '';
    }
  }
}

function getPlugin(pluginId: string): PluginConfig | undefined {
  return plugins.value.find((item) => item.id === pluginId);
}

function isSaving(key: string): boolean {
  return pluginStore.savingIds.includes(key);
}

function isTesting(key: string): boolean {
  return pluginStore.testingIds.includes(key);
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

  if (plugin.kind === 'qingmeng') {
    return {
      ...plugin,
      endpoints: plugin.endpoints.map((endpoint) => {
        const key = endpointTestKey(plugin.id, endpoint.id);
        return {
          ...endpoint,
          intentAliases: (qingmengAliasForms.value[key] ?? '')
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        };
      })
    };
  }

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

function buildDefaultEndpointParameter(): QingmengEndpointParameter {
  return {
    id: crypto.randomUUID(),
    name: '',
    label: '',
    description: '',
    source: 'intent',
    required: false,
    defaultValue: ''
  };
}

function buildDefaultEndpoint(): QingmengEndpointConfig {
  return {
    id: `endpoint-${Math.random().toString(36).slice(2, 8)}`,
    name: '新接口',
    enabled: true,
    group: 'tool',
    description: '',
    intentAliases: [],
    fallbackEligible: false,
    method: 'GET',
    url: '',
    intentPrompt: '',
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

function addQingmengEndpoint(pluginId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'qingmeng') {
    return;
  }

  const endpoint = buildDefaultEndpoint();
  plugin.endpoints.push(endpoint);
  const key = endpointTestKey(plugin.id, endpoint.id);
  qingmengAliasForms.value[key] = '';
  qingmengTestInputs.value[key] = '';
  qingmengTestImages.value[key] = '';
}

function removeQingmengEndpoint(pluginId: string, endpointId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'qingmeng') {
    return;
  }

  plugin.endpoints = plugin.endpoints.filter((endpoint) => endpoint.id !== endpointId);
  const key = endpointTestKey(plugin.id, endpointId);
  delete qingmengAliasForms.value[key];
  delete qingmengTestInputs.value[key];
  delete qingmengTestImages.value[key];
  delete testResults.value[key];
}

function addEndpointParam(pluginId: string, endpointId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'qingmeng') {
    return;
  }

  const endpoint = plugin.endpoints.find((item) => item.id === endpointId);
  if (!endpoint) {
    return;
  }

  endpoint.parameters.push(buildDefaultEndpointParameter());
}

function removeEndpointParam(pluginId: string, endpointId: string, paramId: string): void {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'qingmeng') {
    return;
  }

  const endpoint = plugin.endpoints.find((item) => item.id === endpointId);
  if (!endpoint) {
    return;
  }

  endpoint.parameters = endpoint.parameters.filter((parameter) => parameter.id !== paramId);
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
  if (!plugin || plugin.kind === 'qingmeng') {
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

async function testQingmengEndpoint(pluginId: string, endpointId: string): Promise<void> {
  const plugin = getPlugin(pluginId);
  if (!plugin || plugin.kind !== 'qingmeng') {
    return;
  }

  const payload = normalizePlugin(plugin);
  const key = endpointTestKey(pluginId, endpointId);

  try {
    const result = await pluginStore.testPlugin(payload, {
      endpointId,
      input: qingmengTestInputs.value[key] ?? '',
      imageUrl: qingmengTestImages.value[key] ?? ''
    }, key);
    testResults.value[key] = result;
    notice.value = { text: `接口测试完成：${endpointId}`, error: !result.ok };
  } catch (error) {
    testResults.value[key] = null;
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: `接口测试失败：${endpointId}`, error: true };
  }
}

void load();
</script>
