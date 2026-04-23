<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">任务中心</p>
        <h2>定时发送与插件任务</h2>
        <p class="page-description">用普通表单配置每天、每周、每月或每年的定时消息，再把内容发到指定群聊或私聊。</p>
      </div>

      <div class="hero-actions">
        <button type="button" class="ui-button" :disabled="store.loading" @click="load">
          {{ store.loading ? '刷新中...' : '刷新任务' }}
        </button>
        <button type="button" class="ui-button ui-button-primary" @click="openEditor()">
          新建任务
        </button>
      </div>
    </div>

    <p v-if="notice.text" class="inline-feedback" :class="notice.error ? 'inline-feedback-error' : 'inline-feedback-success'">
      {{ notice.text }}
    </p>

    <div v-if="store.tasks.length > 0" class="plugin-stack">
      <article v-for="task in store.tasks" :key="task.id" class="surface-panel plugin-card">
        <div class="plugin-card-top">
          <div class="plugin-title-block">
            <p class="plugin-kicker">Scheduled Task</p>
            <div class="plugin-title-line">
              <h3>{{ task.name }}</h3>
              <span class="plugin-id-badge">{{ task.id }}</span>
            </div>
            <p class="panel-description">
              {{ scheduleSummary(task) }} · {{ task.pluginId ? pluginLabel(task.pluginId) : '固定文案' }}
              <span v-if="task.jitterSeconds > 0"> · 最多延后 {{ task.jitterSeconds }} 秒</span>
            </p>
          </div>

          <div class="plugin-actions">
            <button type="button" class="ui-button" :disabled="isRunning(task.id)" @click="runTask(task.id)">
              {{ isRunning(task.id) ? '执行中...' : '立即执行' }}
            </button>
            <button type="button" class="ui-button" @click="openEditor(task.id)">
              修改
            </button>
            <button type="button" class="ui-button ui-button-danger" @click="removeTask(task.id)">
              删除
            </button>
          </div>
        </div>

        <div class="plugin-meta-strip">
          <label class="switch-card plugin-switch">
            <div>
              <strong>启用任务</strong>
              <p>关闭后调度器不会再执行这个任务。</p>
            </div>
            <input :checked="task.enabled" class="ui-checkbox" type="checkbox" @change="toggleTask(task.id)" />
          </label>

          <div class="plugin-test-input">
            <span class="field-label">发送目标</span>
            <p class="field-note">{{ task.targets.length }} 个目标：{{ targetSummary(task) }}</p>
          </div>
        </div>

        <div class="plugin-section-stack">
          <section class="plugin-subpanel">
            <div class="plugin-subpanel-head">
              <div>
                <p class="plugin-kicker">任务内容</p>
                <strong>{{ task.pluginId ? '插件输出' : '固定文案' }}</strong>
              </div>
            </div>

            <div class="field-stack">
              <div class="task-preview-block">
                <span class="field-label">当前配置</span>
                <pre class="task-preview-text">{{ taskContentPreview(task) }}</pre>
              </div>
            </div>
          </section>

          <section
            v-if="task.logs?.[0]"
            class="plugin-diagnostics"
            :class="task.logs[0].status === 'success' ? 'plugin-diagnostics-success' : task.logs[0].status === 'partial' ? 'plugin-diagnostics-warn' : 'plugin-diagnostics-error'"
          >
            <div class="plugin-diagnostics-head">
              <div>
                <p class="plugin-kicker">Latest Run</p>
                <strong>{{ task.logs[0].message }}</strong>
              </div>
              <span class="plugin-diagnostics-latency">{{ formatExecutionTime(task.logs[0].executedAt) }}</span>
            </div>

            <pre class="plugin-diagnostics-body">{{ formatJson(task.logs[0]) }}</pre>
          </section>
        </div>
      </article>
    </div>

    <article v-else class="surface-panel empty-panel">
      {{ store.loading ? '正在读取任务配置...' : '还没有定时任务' }}
    </article>

    <BaseModal
      v-model:visible="editor.visible"
      :title="editor.taskId ? '修改任务' : '新建任务'"
      :footer="false"
      :width="1080"
      unmount-on-close
      @close="closeEditor"
      @cancel="closeEditor"
    >
      <div class="field-stack">
        <p v-if="editor.feedback" class="inline-feedback" :class="editor.feedbackError ? 'inline-feedback-error' : 'inline-feedback-success'">
          {{ editor.feedback }}
        </p>

        <div class="plugin-compact-grid plugin-compact-grid-3">
          <label class="field-block">
            <span class="field-label">任务名称</span>
            <input v-model="editor.form.name" class="ui-input" placeholder="例如：早间天气播报" />
          </label>

          <label class="field-block">
            <span class="field-label">触发方式</span>
            <select v-model="editor.schedule.mode" class="ui-select">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
              <option value="custom">高级 Cron</option>
            </select>
          </label>

          <label class="field-block field-size-xs">
            <span class="field-label">抖动秒数</span>
            <input v-model.number="editor.form.jitterSeconds" class="ui-input" type="number" min="0" max="86400" />
          </label>
        </div>

        <div v-if="editor.schedule.mode !== 'custom'" class="plugin-compact-grid plugin-compact-grid-4">
          <label class="field-block">
            <span class="field-label">时间</span>
            <input v-model="editor.schedule.time" class="ui-input" type="time" />
          </label>

          <label v-if="editor.schedule.mode === 'weekly'" class="field-block">
            <span class="field-label">星期</span>
            <select v-model.number="editor.schedule.weekday" class="ui-select">
              <option v-for="item in weekdayOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>

          <label v-if="editor.schedule.mode === 'monthly' || editor.schedule.mode === 'yearly'" class="field-block">
            <span class="field-label">日期</span>
            <input v-model.number="editor.schedule.dayOfMonth" class="ui-input" type="number" min="1" max="31" />
          </label>

          <label v-if="editor.schedule.mode === 'yearly'" class="field-block">
            <span class="field-label">月份</span>
            <input v-model.number="editor.schedule.month" class="ui-input" type="number" min="1" max="12" />
          </label>

          <label class="field-block">
            <span class="field-label">时区</span>
            <input v-model="editor.form.timezone" class="ui-input" placeholder="Asia/Shanghai" />
          </label>
        </div>

        <label v-else class="field-block">
          <span class="field-label">Cron 表达式</span>
          <input v-model="editor.schedule.rawCron" class="ui-input" placeholder="例如：0 8 * * *" />
          <span class="field-note">只有复杂调度才需要直接写 Cron。</span>
        </label>

        <div class="task-schedule-note">
          <span class="field-label">当前计划</span>
          <strong>{{ currentSchedulePreview }}</strong>
        </div>

        <div class="plugin-compact-grid plugin-compact-grid-2">
          <label class="field-block">
            <span class="field-label">插件模块</span>
            <select v-model="editor.form.pluginId" class="ui-select" @change="handlePluginChange">
              <option value="">不使用插件</option>
              <option value="ds2api">DS2API</option>
              <option value="qweather">和风天气</option>
              <option value="qingmeng">倾梦 API</option>
            </select>
          </label>

          <label class="switch-card plugin-switch">
            <div>
              <strong>启用任务</strong>
              <p>保存后进入调度。</p>
            </div>
            <input v-model="editor.form.enabled" class="ui-checkbox" type="checkbox" />
          </label>
        </div>

        <label v-if="!editor.form.pluginId" class="field-block">
          <span class="field-label">发送文案</span>
          <textarea
            v-model="editor.form.messageTemplate"
            class="ui-textarea ui-textarea-tight"
            rows="4"
            placeholder="不选插件时必须填写，例如：早上好，今天也要元气满满。"
          />
        </label>

        <div v-else class="field-stack">
          <div v-if="editor.form.pluginId === 'ds2api'" class="plugin-compact-grid plugin-compact-grid-2">
            <label class="field-block">
              <span class="field-label">模型路由</span>
              <select v-model="editor.ds2api.routeId" class="ui-select">
                <option value="">自动选择第一个可用路由</option>
                <option v-for="route in ds2apiRoutes" :key="route.id" :value="route.id">
                  {{ route.name }}（{{ route.model }}）
                </option>
              </select>
            </label>

            <label class="field-block field-span-2">
              <span class="field-label">你希望这个插件做什么</span>
              <textarea
                v-model="editor.ds2api.prompt"
                class="ui-textarea ui-textarea-tight"
                rows="4"
                placeholder="例如：写一条适合早上发送到群里的简短晨间问候。"
              />
            </label>
          </div>

          <div v-else-if="editor.form.pluginId === 'qweather'" class="plugin-compact-grid plugin-compact-grid-2">
            <label class="field-block">
              <span class="field-label">天气地点</span>
              <input
                v-model="editor.qweather.location"
                class="ui-input"
                placeholder="例如：上海"
              />
            </label>
          </div>

          <div v-else-if="editor.form.pluginId === 'qingmeng'" class="field-stack">
            <div class="plugin-compact-grid plugin-compact-grid-3">
              <label class="field-block">
                <span class="field-label">大类</span>
                <select v-model="editor.qingmeng.group" class="ui-select" @change="handleQingmengGroupChange">
                  <option v-for="group in qingmengGroupOptions" :key="group.value" :value="group.value">
                    {{ group.label }}
                  </option>
                </select>
              </label>

              <label class="field-block field-span-2">
                <span class="field-label">具体功能</span>
                <select v-model="editor.qingmeng.endpointId" class="ui-select" @change="handleQingmengEndpointChange">
                  <option v-for="endpoint in qingmengEndpointsByGroup" :key="endpoint.id" :value="endpoint.id">
                    {{ endpoint.name }}
                  </option>
                </select>
              </label>
            </div>

            <label
              v-if="selectedQingmengEndpoint && (selectedQingmengEndpoint.parameters.some((item) => item.source === 'intent') || selectedQingmengEndpoint.sampleInput)"
              class="field-block"
            >
              <span class="field-label">补充说明</span>
              <input
                v-model="editor.qingmeng.input"
                class="ui-input"
                :placeholder="selectedQingmengEndpoint.sampleInput || selectedQingmengEndpoint.intentPrompt"
              />
            </label>

            <label
              v-if="selectedQingmengEndpoint?.parameters.some((item) => item.source === 'image_url')"
              class="field-block"
            >
              <span class="field-label">图片链接</span>
              <input
                v-model="editor.qingmeng.imageUrl"
                class="ui-input"
                placeholder="看图类接口需要一张图片 URL"
              />
            </label>

            <div v-if="qingmengIntentParameters.length > 0" class="plugin-compact-grid plugin-compact-grid-2">
              <label v-for="parameter in qingmengIntentParameters" :key="parameter.id" class="field-block">
                <span class="field-label">{{ parameter.label }}</span>
                <input
                  v-model="editor.qingmeng.params[parameter.name]"
                  class="ui-input"
                  :placeholder="parameter.description || parameter.defaultValue || '请输入参数值'"
                />
              </label>
            </div>
          </div>
        </div>

        <div class="task-target-toolbar">
          <div class="filter-tabs">
            <button
              v-for="type in targetFilters"
              :key="type.value"
              type="button"
              class="filter-tab"
              :class="{ 'filter-tab-active': editor.targetFilter === type.value }"
              @click="editor.targetFilter = type.value"
            >
              {{ type.label }}
            </button>
          </div>

          <input
            v-model="editor.targetKeyword"
            class="ui-input session-search"
            type="search"
            placeholder="搜索名称或 QQ / 群号"
          />
        </div>

        <div class="task-target-grid">
          <label v-for="target in filteredTargets" :key="target.chatKey" class="task-target-card">
            <input
              :checked="editor.selectedTargetKeys.includes(target.chatKey)"
              class="ui-checkbox"
              type="checkbox"
              @change="toggleTarget(target)"
            />
            <div>
              <strong>{{ target.displayName }}</strong>
              <p>{{ target.chatType === 'group' ? `群号 ${target.targetId}` : `QQ ${target.targetId}` }}</p>
            </div>
            <span class="mini-tag" :class="target.chatType === 'group' ? 'mini-tag-positive' : 'mini-tag-muted'">
              {{ target.chatType === 'group' ? '群聊' : '私聊' }}
            </span>
          </label>
        </div>

        <div class="modal-footer-actions">
          <button type="button" class="ui-button" @click="closeEditor">
            取消
          </button>
          <button
            v-if="editor.taskId"
            type="button"
            class="ui-button"
            :disabled="editor.running"
            @click="runEditorTask"
          >
            {{ editor.running ? '执行中...' : '立即执行' }}
          </button>
          <button
            type="button"
            class="ui-button ui-button-primary"
            :disabled="store.saving"
            @click="saveEditor"
          >
            {{ store.saving ? '保存中...' : '保存任务' }}
          </button>
        </div>
      </div>
    </BaseModal>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import BaseModal from '../components/BaseModal.vue';
import { ApiError, request } from '../api/client';
import { useTasksStore } from '../stores/tasks';
import type {
  Ds2ApiPluginConfig,
  Ds2ApiRouteConfig,
  PluginConfig,
  QingmengEndpointConfig,
  QingmengPluginConfig,
  ScheduledTask,
  ScheduledTaskTarget,
  TaskTargetOption
} from '../types';

type ScheduleMode = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

const store = useTasksStore();
const plugins = ref<PluginConfig[]>([]);
const notice = ref({
  text: '',
  error: false
});

const targetFilters = [
  { value: 'all', label: '全部目标' },
  { value: 'group', label: '群聊' },
  { value: 'private', label: '私聊' }
] as const;

const weekdayOptions = [
  { value: 0, label: '周日' },
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' }
];

const qingmengGroupLabels: Record<string, string> = {
  analysis: '图片分析',
  tool: '工具与查询',
  text: '文本输出',
  image: '图片接口',
  video: '视频接口',
  audio: '语音接口'
};

const editor = reactive({
  visible: false,
  taskId: '',
  targetKeyword: '',
  targetFilter: 'all' as 'all' | 'group' | 'private',
  selectedTargetKeys: [] as string[],
  feedback: '',
  feedbackError: false,
  running: false,
  form: buildDefaultTask(),
  schedule: {
    mode: 'daily' as ScheduleMode,
    time: '08:00',
    weekday: 1,
    dayOfMonth: 1,
    month: 1,
    rawCron: '0 8 * * *'
  },
  ds2api: {
    routeId: '',
    prompt: ''
  },
  qweather: {
    location: ''
  },
  qingmeng: {
    group: 'tool',
    endpointId: '',
    input: '',
    imageUrl: '',
    params: {} as Record<string, string>
  }
});

const ds2apiPlugin = computed(() => plugins.value.find((item): item is Ds2ApiPluginConfig => item.kind === 'ds2api'));
const qingmengPlugin = computed(() => plugins.value.find((item): item is QingmengPluginConfig => item.kind === 'qingmeng'));
const ds2apiRoutes = computed(() => ds2apiPlugin.value?.routes.filter((item) => item.enabled) ?? []);
const qingmengGroupOptions = computed(() => {
  const groups = Array.from(new Set((qingmengPlugin.value?.endpoints ?? []).filter((item) => item.enabled).map((item) => item.group)));
  return groups.map((value) => ({
    value,
    label: qingmengGroupLabels[value] ?? value
  }));
});
const qingmengEndpointsByGroup = computed(() => {
  return (qingmengPlugin.value?.endpoints ?? []).filter(
    (item) => item.enabled && item.group === editor.qingmeng.group
  );
});
const selectedQingmengEndpoint = computed(() => {
  return qingmengEndpointsByGroup.value.find((item) => item.id === editor.qingmeng.endpointId) ?? null;
});
const qingmengIntentParameters = computed(() => {
  return selectedQingmengEndpoint.value?.parameters.filter((item) => item.source === 'intent') ?? [];
});

const filteredTargets = computed(() => {
  const keyword = editor.targetKeyword.trim().toLowerCase();
  return store.targets.filter((target) => {
    if (editor.targetFilter !== 'all' && target.chatType !== editor.targetFilter) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return `${target.displayName} ${target.targetId} ${target.chatKey}`.toLowerCase().includes(keyword);
  });
});

const currentSchedulePreview = computed(() => {
  if (editor.schedule.mode === 'custom') {
    return `自定义 Cron：${editor.schedule.rawCron || '未填写'}`;
  }

  if (editor.schedule.mode === 'daily') {
    return `每天 ${editor.schedule.time}`;
  }

  if (editor.schedule.mode === 'weekly') {
    const weekday = weekdayOptions.find((item) => item.value === editor.schedule.weekday)?.label ?? '周一';
    return `每周 ${weekday} ${editor.schedule.time}`;
  }

  if (editor.schedule.mode === 'monthly') {
    return `每月 ${editor.schedule.dayOfMonth} 日 ${editor.schedule.time}`;
  }

  return `每年 ${editor.schedule.month} 月 ${editor.schedule.dayOfMonth} 日 ${editor.schedule.time}`;
});

function buildDefaultTask(): ScheduledTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    name: '新任务',
    enabled: true,
    cronExpression: '0 8 * * *',
    timezone: 'Asia/Shanghai',
    jitterSeconds: 0,
    messageTemplate: '',
    pluginId: '',
    pluginPayload: {},
    targets: [],
    logs: []
  };
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return JSON.parse(JSON.stringify(task)) as ScheduledTask;
}

function pluginLabel(pluginId: string): string {
  if (pluginId === 'ds2api') {
    return 'DS2API';
  }
  if (pluginId === 'qweather') {
    return '和风天气';
  }
  if (pluginId === 'qingmeng') {
    return '倾梦API';
  }

  return '固定文案';
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatExecutionTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('zh-CN');
}

function isRunning(taskId: string): boolean {
  return store.runningIds.includes(taskId);
}

function parseCron(cronExpression: string): {
  mode: ScheduleMode;
  time: string;
  weekday: number;
  dayOfMonth: number;
  month: number;
  rawCron: string;
} {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      mode: 'custom',
      time: '08:00',
      weekday: 1,
      dayOfMonth: 1,
      month: 1,
      rawCron: cronExpression
    };
  }

  const [minute, hour, dayOfMonth, month, weekday] = parts;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  if (dayOfMonth === '*' && month === '*' && weekday === '*') {
    return {
      mode: 'daily',
      time,
      weekday: 1,
      dayOfMonth: 1,
      month: 1,
      rawCron: cronExpression
    };
  }

  if (dayOfMonth === '*' && month === '*' && /^\d+$/.test(weekday)) {
    return {
      mode: 'weekly',
      time,
      weekday: Number(weekday),
      dayOfMonth: 1,
      month: 1,
      rawCron: cronExpression
    };
  }

  if (/^\d+$/.test(dayOfMonth) && month === '*' && weekday === '*') {
    return {
      mode: 'monthly',
      time,
      weekday: 1,
      dayOfMonth: Number(dayOfMonth),
      month: 1,
      rawCron: cronExpression
    };
  }

  if (/^\d+$/.test(dayOfMonth) && /^\d+$/.test(month) && weekday === '*') {
    return {
      mode: 'yearly',
      time,
      weekday: 1,
      dayOfMonth: Number(dayOfMonth),
      month: Number(month),
      rawCron: cronExpression
    };
  }

  return {
    mode: 'custom',
    time,
    weekday: 1,
    dayOfMonth: 1,
    month: 1,
    rawCron: cronExpression
  };
}

function buildCronExpression(): string {
  if (editor.schedule.mode === 'custom') {
    return editor.schedule.rawCron.trim();
  }

  const [hour = '8', minute = '0'] = editor.schedule.time.split(':');
  if (editor.schedule.mode === 'daily') {
    return `${Number(minute)} ${Number(hour)} * * *`;
  }

  if (editor.schedule.mode === 'weekly') {
    return `${Number(minute)} ${Number(hour)} * * ${editor.schedule.weekday}`;
  }

  if (editor.schedule.mode === 'monthly') {
    return `${Number(minute)} ${Number(hour)} ${editor.schedule.dayOfMonth} * *`;
  }

  return `${Number(minute)} ${Number(hour)} ${editor.schedule.dayOfMonth} ${editor.schedule.month} *`;
}

function scheduleSummary(task: ScheduledTask): string {
  const parsed = parseCron(task.cronExpression);
  if (parsed.mode === 'custom') {
    return `自定义计划：${task.cronExpression}`;
  }

  if (parsed.mode === 'daily') {
    return `每天 ${parsed.time}`;
  }

  if (parsed.mode === 'weekly') {
    const weekday = weekdayOptions.find((item) => item.value === parsed.weekday)?.label ?? `周${parsed.weekday}`;
    return `每周 ${weekday} ${parsed.time}`;
  }

  if (parsed.mode === 'monthly') {
    return `每月 ${parsed.dayOfMonth} 日 ${parsed.time}`;
  }

  return `每年 ${parsed.month} 月 ${parsed.dayOfMonth} 日 ${parsed.time}`;
}

function targetSummary(task: ScheduledTask): string {
  return task.targets.slice(0, 3).map((item) => item.displayName).join('、') || '未选择';
}

function taskContentPreview(task: ScheduledTask): string {
  if (!task.pluginId) {
    return task.messageTemplate.trim() || '未填写固定文案';
  }

  const payload = task.pluginPayload ?? {};
  if (task.pluginId === 'qweather') {
    return `天气地点：${String(payload.location ?? '未填写')}`;
  }

  if (task.pluginId === 'ds2api') {
    return [
      payload.routeId ? `模型路由：${String(payload.routeId)}` : '模型路由：自动',
      `任务描述：${String(payload.prompt ?? '未填写')}`
    ].join('\n');
  }

  if (task.pluginId === 'qingmeng') {
    const endpoint = qingmengPlugin.value?.endpoints.find((item) => item.id === payload.endpointId);
    return [
      `大类：${endpoint ? qingmengGroupLabels[endpoint.group] ?? endpoint.group : '未选择'}`,
      `功能：${endpoint?.name ?? String(payload.endpointId ?? '未选择')}`,
      payload.input ? `补充说明：${String(payload.input)}` : ''
    ].filter(Boolean).join('\n');
  }

  return '未配置';
}

function resetEditorFeedback(): void {
  editor.feedback = '';
  editor.feedbackError = false;
}

function applyTaskToEditor(task: ScheduledTask): void {
  editor.form = task;
  const schedule = parseCron(task.cronExpression);
  editor.schedule.mode = schedule.mode;
  editor.schedule.time = schedule.time;
  editor.schedule.weekday = schedule.weekday;
  editor.schedule.dayOfMonth = schedule.dayOfMonth;
  editor.schedule.month = schedule.month;
  editor.schedule.rawCron = schedule.rawCron;

  const payload = task.pluginPayload ?? {};
  editor.ds2api.routeId = String(payload.routeId ?? '');
  editor.ds2api.prompt = String(payload.prompt ?? '');
  editor.qweather.location = String(payload.location ?? '');
  editor.qingmeng.input = String(payload.input ?? '');
  editor.qingmeng.imageUrl = String(payload.imageUrl ?? '');
  editor.qingmeng.params = payload.params && typeof payload.params === 'object'
    ? Object.fromEntries(Object.entries(payload.params).map(([key, value]) => [key, String(value ?? '')]))
    : {};

  const endpointId = String(payload.endpointId ?? '');
  const endpoint = qingmengPlugin.value?.endpoints.find((item) => item.id === endpointId);
  editor.qingmeng.group = endpoint?.group ?? qingmengGroupOptions.value[0]?.value ?? 'tool';
  editor.qingmeng.endpointId = endpointId || qingmengPlugin.value?.endpoints.find((item) => item.group === editor.qingmeng.group)?.id || '';
}

function handlePluginChange(): void {
  resetEditorFeedback();

  if (!editor.form.pluginId) {
    return;
  }

  editor.form.messageTemplate = '';

  if (editor.form.pluginId === 'ds2api' && !editor.ds2api.prompt) {
    editor.ds2api.prompt = '写一条适合定时发送的内容。';
  }

  if (editor.form.pluginId === 'qweather' && !editor.qweather.location) {
    editor.qweather.location = '上海';
  }

  if (editor.form.pluginId === 'qingmeng') {
    const group = qingmengGroupOptions.value[0]?.value ?? 'tool';
    editor.qingmeng.group = group;
    handleQingmengGroupChange();
  }
}

function handleQingmengGroupChange(): void {
  const firstEndpoint = qingmengEndpointsByGroup.value[0];
  if (!firstEndpoint) {
    editor.qingmeng.endpointId = '';
    return;
  }

  if (!qingmengEndpointsByGroup.value.some((item) => item.id === editor.qingmeng.endpointId)) {
    editor.qingmeng.endpointId = firstEndpoint.id;
  }

  handleQingmengEndpointChange();
}

function handleQingmengEndpointChange(): void {
  const endpoint = selectedQingmengEndpoint.value;
  if (!endpoint) {
    editor.qingmeng.params = {};
    return;
  }

  editor.qingmeng.input = endpoint.sampleInput || editor.qingmeng.input;
  const nextParams: Record<string, string> = {};
  for (const parameter of endpoint.parameters.filter((item) => item.source === 'intent')) {
    nextParams[parameter.name] = editor.qingmeng.params[parameter.name] ?? parameter.defaultValue ?? '';
  }
  editor.qingmeng.params = nextParams;
}

function openEditor(taskId = ''): void {
  resetEditorFeedback();
  const task = taskId ? store.tasks.find((item) => item.id === taskId) : undefined;
  const nextTask = task ? cloneTask(task) : buildDefaultTask();
  editor.visible = true;
  editor.taskId = taskId;
  editor.targetKeyword = '';
  editor.targetFilter = 'all';
  editor.selectedTargetKeys = nextTask.targets.map((target) => `${target.chatType}:${target.targetId}`);
  applyTaskToEditor(nextTask);
}

function closeEditor(): void {
  editor.visible = false;
}

function toggleTarget(target: TaskTargetOption): void {
  const key = target.chatKey;
  if (editor.selectedTargetKeys.includes(key)) {
    editor.selectedTargetKeys = editor.selectedTargetKeys.filter((item) => item !== key);
    return;
  }

  editor.selectedTargetKeys = [...editor.selectedTargetKeys, key];
}

function buildTargetsFromSelection(): ScheduledTaskTarget[] {
  return editor.selectedTargetKeys
    .map((chatKey) => store.targets.find((target) => target.chatKey === chatKey))
    .filter((target): target is TaskTargetOption => Boolean(target))
    .map((target) => ({
      chatType: target.chatType,
      targetId: target.targetId,
      displayName: target.displayName
    }));
}

function buildPluginPayload(): Record<string, unknown> {
  if (!editor.form.pluginId) {
    return {};
  }

  if (editor.form.pluginId === 'qweather') {
    return {
      location: editor.qweather.location.trim()
    };
  }

  if (editor.form.pluginId === 'ds2api') {
    return {
      routeId: editor.ds2api.routeId.trim(),
      prompt: editor.ds2api.prompt.trim()
    };
  }

  return {
    endpointId: editor.qingmeng.endpointId,
    input: editor.qingmeng.input.trim(),
    imageUrl: editor.qingmeng.imageUrl.trim(),
    params: Object.fromEntries(
      Object.entries(editor.qingmeng.params)
        .filter(([, value]) => value.trim())
        .map(([key, value]) => [key, value.trim()])
    )
  };
}

function validatePluginPayload(payload: Record<string, unknown>): void {
  if (!editor.form.pluginId) {
    if (!editor.form.messageTemplate.trim()) {
      throw new Error('未选择插件时，必须填写发送文案');
    }
    return;
  }

  if (editor.form.pluginId === 'qweather' && !String(payload.location ?? '').trim()) {
    throw new Error('和风天气任务必须填写地点');
  }

  if (editor.form.pluginId === 'ds2api') {
    if (!String(payload.prompt ?? '').trim()) {
      throw new Error('DS2API 任务必须填写“你希望这个插件做什么”');
    }

    if (String(payload.routeId ?? '').trim()) {
      const exists = ds2apiRoutes.value.some((route) => route.id === String(payload.routeId));
      if (!exists) {
        throw new Error('所选 DS2API 路由不存在或未启用');
      }
    }
  }

  if (editor.form.pluginId === 'qingmeng') {
    if (!String(payload.endpointId ?? '').trim()) {
      throw new Error('请选择倾梦具体功能');
    }
  }
}

function buildEditorTask(): ScheduledTask {
  const nextTask = cloneTask(editor.form);
  nextTask.targets = buildTargetsFromSelection();
  nextTask.cronExpression = buildCronExpression();
  nextTask.pluginPayload = buildPluginPayload();
  nextTask.pluginId = editor.form.pluginId || '';
  nextTask.messageTemplate = nextTask.pluginId ? '' : editor.form.messageTemplate.trim();

  validatePluginPayload(nextTask.pluginPayload ?? {});

  if (nextTask.targets.length === 0) {
    throw new Error('至少选择一个发送目标');
  }

  return nextTask;
}

async function persistTasks(nextTasks: ScheduledTask[], successText: string): Promise<void> {
  try {
    await store.saveTasks(nextTasks);
    notice.value = { text: successText, error: false };
  } catch (error) {
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: '任务保存失败', error: true };
  }
}

async function saveEditor(): Promise<void> {
  resetEditorFeedback();

  try {
    const nextTask = buildEditorTask();
    const tasks = [...store.tasks];
    const existingIndex = tasks.findIndex((item) => item.id === nextTask.id);

    if (existingIndex >= 0) {
      tasks.splice(existingIndex, 1, nextTask);
    } else {
      tasks.unshift(nextTask);
    }

    await persistTasks(tasks, `任务 ${nextTask.name} 已保存`);
    closeEditor();
  } catch (error) {
    editor.feedback = error instanceof Error ? error.message : '任务保存失败';
    editor.feedbackError = true;
  }
}

async function load(): Promise<void> {
  notice.value = { text: '', error: false };
  const [_, loadedPlugins] = await Promise.all([
    store.fetchAll(),
    request<PluginConfig[]>('/admin/plugins')
  ]);
  plugins.value = loadedPlugins;
}

async function removeTask(taskId: string): Promise<void> {
  const target = store.tasks.find((item) => item.id === taskId);
  if (!target) {
    return;
  }

  await persistTasks(store.tasks.filter((item) => item.id !== taskId), `任务 ${target.name} 已删除`);
}

async function toggleTask(taskId: string): Promise<void> {
  const tasks = store.tasks.map((task) => task.id === taskId ? { ...task, enabled: !task.enabled } : task);
  const target = tasks.find((item) => item.id === taskId);
  await persistTasks(tasks, `任务 ${target?.name ?? taskId} 状态已更新`);
}

async function runTask(taskId: string): Promise<void> {
  try {
    const log = await store.runTask(taskId);
    notice.value = { text: log.message, error: log.status === 'failed' };
  } catch (error) {
    if (error instanceof ApiError) {
      notice.value = { text: error.message, error: true };
      return;
    }

    notice.value = { text: '任务执行失败', error: true };
  }
}

async function runEditorTask(): Promise<void> {
  if (!editor.taskId) {
    editor.feedback = '请先保存任务，再执行';
    editor.feedbackError = true;
    return;
  }

  editor.running = true;
  try {
    const log = await store.runTask(editor.taskId);
    editor.feedback = log.message;
    editor.feedbackError = log.status === 'failed';
  } catch (error) {
    editor.feedback = error instanceof ApiError ? error.message : '任务执行失败';
    editor.feedbackError = true;
  } finally {
    editor.running = false;
  }
}

void load();
</script>
