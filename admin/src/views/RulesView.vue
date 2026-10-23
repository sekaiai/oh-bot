<template>
  <section class="page-stack">
    <div class="page-hero">
      <div>
        <p class="page-eyebrow">规则引擎</p>
        <h2>触发与名单配置</h2>
        <p class="page-description">统一维护管理员、白名单、黑名单、群聊触发条件和基础运行开关。</p>
      </div>

      <div class="hero-actions">
        <button type="button" class="ui-button" :disabled="rulesStore.loading" @click="load">
          {{ rulesStore.loading ? '刷新中...' : '刷新' }}
        </button>
        <button type="button" class="ui-button ui-button-primary" :disabled="rulesStore.saving" @click="save">
          {{ rulesStore.saving ? '保存中...' : '保存规则' }}
        </button>
      </div>
    </div>

    <template v-if="draft">
      <div class="form-grid form-grid-two">
        <article class="surface-panel">
          <div class="panel-header">
            <h3>名单控制</h3>
          </div>
          <div class="field-stack">
            <label class="field-block">
              <span class="field-label">管理员 QQ（每行一个）</span>
              <textarea v-model="form.admins" class="ui-textarea" rows="7" />
            </label>
            <label class="field-block">
              <span class="field-label">群白名单（每行一个群号）</span>
              <textarea v-model="form.whitelistGroups" class="ui-textarea" rows="7" />
            </label>
            <label class="field-block">
              <span class="field-label">私聊黑名单（每行一个 QQ）</span>
              <textarea v-model="form.privateBlacklist" class="ui-textarea" rows="7" />
            </label>
            <label class="field-block">
              <span class="field-label">群聊黑名单（每行一个群号）</span>
              <textarea v-model="form.groupBlacklist" class="ui-textarea" rows="7" />
            </label>
          </div>
        </article>

        <article class="surface-panel">
          <div class="panel-header">
            <h3>触发参数</h3>
          </div>
          <div class="field-stack">
            <label class="field-block">
              <span class="field-label">机器人名称（每行一个别名）</span>
              <textarea v-model="form.botNames" class="ui-textarea" rows="8" />
            </label>

            <div class="inline-fields">
              <label class="field-block">
                <span class="field-label">指令前缀</span>
                <input v-model="draft.commandPrefix" class="ui-input" placeholder="例如 / 或 #" />
              </label>
              <label class="field-block">
                <span class="field-label">冷却时间（秒）</span>
                <input v-model.number="draft.cooldownSeconds" class="ui-input" type="number" min="0" />
              </label>
            </div>

            <div class="switch-card-list">
              <label class="switch-card">
                <div>
                  <strong>启用 AI 回复</strong>
                  <p>关闭后会直接阻断大模型回复链路。</p>
                </div>
                <input v-model="draft.aiEnabled" class="ui-checkbox" type="checkbox" />
              </label>

              <label class="switch-card">
                <div>
                  <strong>群聊必须 @ 机器人</strong>
                  <p>关闭后，群上下文评分也可以直接触发回复。</p>
                </div>
                <input v-model="draft.requireAtInGroup" class="ui-checkbox" type="checkbox" />
              </label>
            </div>
          </div>
        </article>
      </div>
    </template>

    <article v-else class="surface-panel empty-panel">
      {{ rulesStore.loading ? '正在读取规则配置...' : '暂无规则数据' }}
    </article>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ApiError } from '../api/client';
import { useMessage } from '../stores/message';
import { useRuleStore } from '../stores/rules';
import type { RuleConfig } from '../types';

const rulesStore = useRuleStore();
const draft = ref<RuleConfig | null>(null);
const message = useMessage();

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
    draft.value = payload;
    message.success('规则配置已保存');
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
