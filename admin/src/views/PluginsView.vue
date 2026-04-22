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
              <button type="button" class="ui-button" @click="addQingmengEndpoint(plugin.id)">
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
              <article v-for="endpoint in group.items" :key="endpoint.id" class="endpoint-card">
                <div class="endpoint-head">
                  <div class="endpoint-title-stack">
                    <div class="endpoint-title-line">
                      <input v-model="endpoint.name" class="ui-input endpoint-title-input" placeholder="接口名称" />
                      <span class="plugin-id-badge">{{ endpoint.id }}</span>
                    </div>
                    <textarea
                      v-model="endpoint.description"
                      class="ui-textarea ui-textarea-tight"
                      rows="2"
                      placeholder="接口说明"
                    />
                  </div>

                  <div class="endpoint-head-actions">
                    <label class="switch-card compact-switch">
                      <div>
                        <strong>启用</strong>
                        <p>关闭后不参与接口路由。</p>
                      </div>
                      <input v-model="endpoint.enabled" class="ui-checkbox" type="checkbox" />
                    </label>
                    <button
                      type="button"
                      class="ui-button"
                      :disabled="isTesting(endpointTestKey(plugin.id, endpoint.id))"
                      @click="testQingmengEndpoint(plugin.id, endpoint.id)"
                    >
                      {{ isTesting(endpointTestKey(plugin.id, endpoint.id)) ? '测试中...' : '测试接口' }}
                    </button>
                    <button type="button" class="ui-button ui-button-danger" @click="removeQingmengEndpoint(plugin.id, endpoint.id)">
                      删除
                    </button>
                  </div>
                </div>

                <div class="endpoint-core-grid">
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

                  <label class="switch-card compact-switch">
                    <div>
                      <strong>随机分发</strong>
                      <p>只在模糊意图下加入随机池。</p>
                    </div>
                    <input v-model="endpoint.fallbackEligible" class="ui-checkbox" type="checkbox" />
                  </label>

                  <label class="field-block field-span-3">
                    <span class="field-label">接口地址</span>
                    <input v-model="endpoint.url" class="ui-input" placeholder="https://api.317ak.cn/api/..." />
                  </label>

                  <label class="field-block field-span-3">
                    <span class="field-label">意图说明</span>
                    <textarea v-model="endpoint.intentPrompt" class="ui-textarea ui-textarea-tight" rows="2" placeholder="描述用户什么意图时应该命中这个接口" />
                  </label>

                  <label class="field-block field-span-3">
                    <span class="field-label">意图别名</span>
                    <textarea
                      v-model="qingmengAliasForms[endpointTestKey(plugin.id, endpoint.id)]"
                      class="ui-textarea ui-textarea-tight"
                      rows="2"
                      placeholder="一行一个，例如：JK&#10;jk图片&#10;制服图"
                    />
                  </label>
                </div>

                <div class="plugin-compact-grid plugin-compact-grid-2">
                  <label class="field-block">
                    <span class="field-label">测试文本</span>
                    <input v-model="qingmengTestInputs[endpointTestKey(plugin.id, endpoint.id)]" class="ui-input" placeholder="测试消息" />
                  </label>

                  <label class="field-block">
                    <span class="field-label">测试图片 URL</span>
                    <input v-model="qingmengTestImages[endpointTestKey(plugin.id, endpoint.id)]" class="ui-input" placeholder="看图接口可填一张图片链接" />
                  </label>
                </div>

                <details class="config-disclosure">
                  <summary>高级配置</summary>
                  <div class="disclosure-body endpoint-advanced-stack">
                    <div class="plugin-compact-grid plugin-compact-grid-3">
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
                        <span class="field-label">请求方式</span>
                        <input v-model="endpoint.method" class="ui-input" readonly />
                      </label>

                      <label class="field-block">
                        <span class="field-label">responsePath</span>
                        <input v-model="endpoint.responsePath" class="ui-input" placeholder="例如 text / $self" />
                      </label>

                      <label class="field-block">
                        <span class="field-label">listPath</span>
                        <input v-model="endpoint.listPath" class="ui-input" placeholder="例如 data" />
                      </label>

                      <label class="field-block">
                        <span class="field-label">itemTitlePath</span>
                        <input v-model="endpoint.itemTitlePath" class="ui-input" placeholder="例如 title" />
                      </label>

                      <label class="field-block field-span-3">
                        <span class="field-label">itemUrlPath</span>
                        <input v-model="endpoint.itemUrlPath" class="ui-input" placeholder="例如 url / Url" />
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
                          <textarea v-model="parameter.description" class="ui-textarea ui-textarea-tight endpoint-param-description" rows="2" placeholder="参数含义与抽取方式" />
                        </div>
                      </div>

                      <p v-else class="inline-notice inline-notice-info">这个接口当前没有参数。</p>
                    </section>
                  </div>
                </details>

                <section
                  v-if="testResults[endpointTestKey(plugin.id, endpoint.id)]"
                  class="plugin-diagnostics"
                  :class="testResults[endpointTestKey(plugin.id, endpoint.id)]?.ok ? 'plugin-diagnostics-success' : 'plugin-diagnostics-error'"
                >
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
  Ds2ApiRouteConfig,
  PluginConfig,
  PluginTestResult,
  QingmengEndpointConfig,
  QingmengEndpointParameter,
  QingmengPluginConfig
} from '../types';

const pluginStore = usePluginStore();
const plugins = ref<PluginConfig[]>([]);
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

function endpointTestKey(pluginId: string, endpointId: string): string {
  return `${pluginId}:${endpointId}`;
}

function routeTestKey(pluginId: string, routeId: string): string {
  return `${pluginId}:route:${routeId}`;
}

function syncLocalState(items: PluginConfig[]): void {
  const previousPluginInputs = { ...pluginTestInputs.value };
  const previousAliasForms = { ...qingmengAliasForms.value };
  const previousEndpointInputs = { ...qingmengTestInputs.value };
  const previousEndpointImages = { ...qingmengTestImages.value };

  plugins.value = clonePlugins(items);
  pluginTestInputs.value = {};
  qingmengAliasForms.value = {};
  qingmengTestInputs.value = {};
  qingmengTestImages.value = {};

  for (const plugin of plugins.value) {
    if (plugin.kind === 'ds2api') {
      pluginTestInputs.value[plugin.id] = previousPluginInputs[plugin.id] || '帮我分析这个方案的优缺点';
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
