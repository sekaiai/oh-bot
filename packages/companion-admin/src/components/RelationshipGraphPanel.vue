<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { z } from 'zod';
import { api } from '../api/client';
import type { Section } from '../app/sections';

type Character = { id: string; name: string };
type RelationshipItem = {
  personId: string; displayName: string | null; familiarity: number | null; trust: number | null;
  stage: string | null; eventCount: number; lastInteractionAt: string | null; isPrimaryPartner: boolean;
};
type Graph = { character: Character; items: RelationshipItem[]; truncated: boolean };
const props = defineProps<{ section: Section }>();
const characterSchema = z.array(z.object({ id: z.string(), name: z.string() }).passthrough());
const graphSchema = z.object({
  character: z.object({ id: z.string(), name: z.string() }).passthrough(),
  items: z.array(z.object({
    personId: z.string(), displayName: z.string().nullable(), familiarity: z.number().nullable(), trust: z.number().nullable(),
    stage: z.string().nullable(), eventCount: z.number(), lastInteractionAt: z.string().nullable(), isPrimaryPartner: z.boolean()
  }).passthrough()), truncated: z.boolean()
}).passthrough();
const characters = ref<Character[]>([]); const selectedCharacterId = ref(''); const graph = ref<Graph | null>(null);
const selectedPersonId = ref(''); const loadingCharacters = ref(false); const loadingGraph = ref(false); const error = ref('');
const query = ref(''); const sort = ref<'events' | 'name' | 'familiarity' | 'trust'>('events');
let generation = 0; let characterLoadGeneration = 0;
const character = computed(() => characters.value.find((item) => item.id === selectedCharacterId.value));
const sortedItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return [...(graph.value?.items ?? [])].filter((item) => !needle || `${item.displayName ?? ''} ${item.personId}`.toLocaleLowerCase().includes(needle)).sort((a, b) => {
    if (sort.value === 'name') return nameOf(a).localeCompare(nameOf(b), 'zh-CN') || a.personId.localeCompare(b.personId);
    if (sort.value === 'familiarity') return (b.familiarity ?? -1) - (a.familiarity ?? -1) || b.eventCount - a.eventCount || a.personId.localeCompare(b.personId);
    if (sort.value === 'trust') return (b.trust ?? -1) - (a.trust ?? -1) || b.eventCount - a.eventCount || a.personId.localeCompare(b.personId);
    return b.eventCount - a.eventCount || nameOf(a).localeCompare(nameOf(b), 'zh-CN') || a.personId.localeCompare(b.personId);
  });
});
const chartItems = computed(() => sortedItems.value.slice(0, 10));
const selectedItem = computed(() => graph.value?.items.find((item) => item.personId === selectedPersonId.value) ?? null);
const truncated = computed(() => Boolean(graph.value?.truncated));
function nameOf(item: RelationshipItem) { return item.displayName?.trim() || '未命名人物'; }
function shortId(id: string) { return id.slice(0, 8); }
function selectItem(item: RelationshipItem) { selectedPersonId.value = item.personId; }
function percent(value: number | null) { return value == null ? '未知' : `${Math.round(value * 100)}%`; }
function stageName(stage: string | null) { return ({ new: '初识', known: '熟悉', close: '亲近', partner: '伴侣' } as Record<string, string>)[stage ?? ''] ?? stage ?? '未知'; }
function dateLabel(value: string | null) {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function point(index: number, count: number) {
  const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(count, 1);
  return { x: 240 + Math.cos(angle) * 108, y: 158 + Math.sin(angle) * 108 };
}
function lineWidth(eventCount: number) { return Math.min(7, 1.5 + Math.sqrt(Math.max(0, eventCount)) * 0.75); }
async function selectCharacter(id: string) {
  if (!id) return;
  selectedCharacterId.value = id; graph.value = null; selectedPersonId.value = ''; error.value = '';
  const request = ++generation; loadingGraph.value = true;
  try {
    const data = await api.get(`/admin/characters/${encodeURIComponent(id)}/relationship-graph`, undefined, graphSchema);
    if (request !== generation || selectedCharacterId.value !== id) return;
    if (data.character.id !== id) throw new Error('关系图谱返回了其他角色的数据');
    graph.value = data; selectedPersonId.value = data.items[0]?.personId ?? '';
  } catch (e) {
    if (request === generation && selectedCharacterId.value === id) error.value = e instanceof Error ? e.message : '读取关系图谱失败';
  } finally { if (request === generation && selectedCharacterId.value === id) loadingGraph.value = false; }
}
async function load() {
  const request = ++generation; const characterRequest = ++characterLoadGeneration; loadingCharacters.value = true; loadingGraph.value = false; error.value = ''; graph.value = null;
  try {
    const data = await api.get('/admin/characters', { limit: 100, offset: 0 }, characterSchema);
    if (request !== generation) return;
    characters.value = data;
    const nextId = data.some((item) => item.id === selectedCharacterId.value) ? selectedCharacterId.value : data[0]?.id ?? '';
    if (nextId) void selectCharacter(nextId);
    else selectedCharacterId.value = '';
  } catch (e) { if (request === generation) error.value = e instanceof Error ? e.message : '读取角色目录失败'; }
  finally { if (characterRequest === characterLoadGeneration) loadingCharacters.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="panel relationship-graph-panel">
    <div class="panel-head"><div><h1>{{ section.label }}</h1><p>{{ section.description }}</p></div><el-button :loading="loadingCharacters || loadingGraph" @click="load">刷新</el-button></div>
    <el-skeleton v-if="loadingCharacters && !characters.length" :rows="4" animated />
    <el-alert v-if="error" role="alert" type="error" :closable="false" :title="error" show-icon />
    <el-empty v-if="!loadingCharacters && !error && !characters.length" description="暂无角色，关系图谱暂不可用" />
    <template v-if="characters.length">
      <div class="graph-toolbar">
        <label class="character-picker">AI 角色
          <select :value="selectedCharacterId" :disabled="loadingCharacters" @change="selectCharacter(($event.target as HTMLSelectElement).value)">
            <option v-for="item in characters" :key="item.id" :value="item.id">{{ item.name }} · {{ shortId(item.id) }}</option>
          </select>
        </label>
        <span class="hint">角色目录最多读取 100 项</span>
      </div>
      <el-alert v-if="truncated" class="graph-notice" type="warning" :closable="false" title="关系数据已达到接口返回上限，图谱可能不完整；以下列表展示本次返回的全部人物。" />
      <el-skeleton v-if="loadingGraph" :rows="5" animated />
      <template v-else-if="graph && !error">
        <div v-if="!graph.items.length" class="empty-graph"><div class="empty-orbit"><span>AI</span></div><el-empty description="暂无关系人物" /></div>
        <div v-else class="graph-layout">
          <div class="graph-stage" aria-label="AI 与人物关系图谱">
            <svg class="relationship-svg" viewBox="0 0 480 320" role="img" :aria-label="`${graph.character.name} 与 ${graph.items.length} 位人物的关系图`">
              <circle cx="240" cy="158" r="108" class="orbit-guide" />
              <g v-for="(item, index) in chartItems" :key="item.personId">
                <line x1="240" y1="158" :x2="point(index, chartItems.length).x" :y2="point(index, chartItems.length).y" :stroke-width="lineWidth(item.eventCount)" :class="['graph-edge', { 'edge-selected': selectedPersonId === item.personId }]" />
              </g>
              <g class="ai-node"><circle cx="240" cy="158" r="38" /><text x="240" y="154" text-anchor="middle" class="ai-label">AI</text><text x="240" y="171" text-anchor="middle" class="ai-name">{{ graph.character.name }}</text></g>
              <g v-for="(item, index) in chartItems" :key="item.personId" class="person-node" role="button" tabindex="0" :aria-pressed="selectedPersonId === item.personId" :aria-label="`${nameOf(item)}，ID ${item.personId}，${item.eventCount} 个有效互动事件`" @click="selectItem(item)" @keydown.enter.prevent="selectItem(item)" @keydown.space.prevent="selectItem(item)">
                <circle :cx="point(index, chartItems.length).x" :cy="point(index, chartItems.length).y" r="25" :class="{ selected: selectedPersonId === item.personId }" />
                <text :x="point(index, chartItems.length).x" :y="point(index, chartItems.length).y + 4" text-anchor="middle" class="node-initial">{{ nameOf(item).slice(0, 1) }}</text>
                <text :x="point(index, chartItems.length).x" :y="point(index, chartItems.length).y + 39" text-anchor="middle" class="node-name">{{ nameOf(item).slice(0, 5) }}</text>
                <text :x="point(index, chartItems.length).x" :y="point(index, chartItems.length).y + 53" text-anchor="middle" class="node-id">#{{ shortId(item.personId) }}</text>
              </g>
              <text v-if="sortedItems.length > 10" x="240" y="308" text-anchor="middle" class="chart-caption">图中显示当前筛选和排序下的前 10 位，列表含全部 {{ sortedItems.length }} 位人物</text>
            </svg>
            <p class="legend"><span class="legend-line" />线条粗细表示有效互动事件数量，不代表亲密程度</p>
          </div>
          <aside v-if="selectedItem" class="person-detail" aria-live="polite">
            <p class="detail-kicker">人物详情</p><h2>{{ nameOf(selectedItem) }}</h2><code>{{ selectedItem.personId }}</code>
            <el-tag v-if="selectedItem.isPrimaryPartner" type="success" effect="plain">主要伴侣</el-tag>
            <dl><div><dt>有效互动事件</dt><dd>{{ selectedItem.eventCount }}</dd></div><div><dt>熟悉度</dt><dd>{{ percent(selectedItem.familiarity) }}</dd></div><div><dt>信任度</dt><dd>{{ percent(selectedItem.trust) }}</dd></div><div><dt>关系阶段</dt><dd>{{ stageName(selectedItem.stage) }}</dd></div><div><dt>最近互动</dt><dd>{{ dateLabel(selectedItem.lastInteractionAt) }}</dd></div></dl>
          </aside>
        </div>
        <div class="people-list">
          <div class="list-heading"><div><h2>人物名单</h2><span>{{ sortedItems.length }} 位人物</span></div><div class="list-filters"><el-input v-model="query" clearable placeholder="搜索名称或人物 ID" aria-label="搜索名称或人物 ID" /><el-select v-model="sort" aria-label="排序方式"><el-option label="按互动事件" value="events" /><el-option label="按名称" value="name" /><el-option label="按熟悉度" value="familiarity" /><el-option label="按信任度" value="trust" /></el-select></div></div>
          <div v-if="!sortedItems.length" class="list-empty">没有符合条件的人物</div>
          <div v-else class="people-grid"><button v-for="item in sortedItems" :key="item.personId" class="person-row" :class="{ active: selectedPersonId === item.personId }" :aria-pressed="selectedPersonId === item.personId" @click="selectItem(item)"><span class="person-avatar">{{ nameOf(item).slice(0, 1) }}</span><span class="person-main"><strong>{{ nameOf(item) }}</strong><small>{{ shortId(item.personId) }} · {{ item.eventCount }} 个有效互动事件</small></span><el-tag v-if="item.isPrimaryPartner" size="small" type="success" effect="plain">主伴侣</el-tag></button></div>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.relationship-graph-panel{max-width:1200px}.graph-toolbar{display:flex;align-items:end;gap:18px;margin:0 0 18px}.character-picker{display:grid;gap:6px;color:#68746d;font-size:12px;min-width:min(360px,100%)}.character-picker select{height:38px;border:1px solid #dcdfe6;border-radius:7px;background:#fff;color:#26332e;padding:0 12px;font:inherit;font-size:14px}.graph-notice{margin-bottom:16px}.graph-layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.8fr);gap:20px;align-items:stretch}.graph-stage{min-width:0;background:linear-gradient(145deg,#f7faf7,#f2f5f0);border:1px solid #e8eee8;border-radius:14px;padding:12px}.relationship-svg{display:block;width:100%;height:auto;max-height:410px}.orbit-guide{fill:none;stroke:#dfe8e1;stroke-width:1;stroke-dasharray:3 6}.graph-edge{stroke:#a9c0b2;stroke-linecap:round;opacity:.72;transition:stroke .16s,opacity .16s}.graph-edge.edge-selected{stroke:#4b8068;opacity:1}.ai-node circle{fill:#294c3e;stroke:#fff;stroke-width:4;filter:drop-shadow(0 4px 8px #26332e20)}.ai-label,.ai-name{fill:#fff;font-family:inherit}.ai-label{font-size:11px;font-weight:700}.ai-name{font-size:8px}.person-node{cursor:pointer;outline:none}.person-node circle{fill:#fff;stroke:#9db7a6;stroke-width:2;transition:stroke .15s,fill .15s}.person-node:hover circle,.person-node:focus circle,.person-node circle.selected{fill:#e4f1e8;stroke:#477a61;stroke-width:3}.node-initial{fill:#315b48;font-size:14px;font-weight:700;pointer-events:none}.node-name{fill:#37473e;font-size:10px;font-weight:600;pointer-events:none}.node-id{fill:#8a958d;font-size:8px;pointer-events:none}.chart-caption{fill:#7b857f;font-size:10px}.legend{display:flex;align-items:center;justify-content:center;gap:8px;color:#7b857f;font-size:11px;margin:0 0 5px}.legend-line{width:27px;border-top:3px solid #a9c0b2}.person-detail{border:1px solid #e6eae5;border-radius:14px;padding:22px;background:#fff}.detail-kicker{color:#6b8978;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px}.person-detail h2{font-size:20px;margin:0 0 5px}.person-detail code{display:block;overflow-wrap:anywhere;color:#7b857f;font-size:11px;margin-bottom:12px}.person-detail dl{margin:14px 0 0}.person-detail dl>div{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #f0f1ed}.person-detail dt{color:#7b857f;font-size:12px}.person-detail dd{margin:0;color:#34463b;font-size:13px;text-align:right}.empty-graph{min-height:260px;display:grid;place-items:center;grid-template-columns:1fr 2fr;background:#f7faf7;border-radius:14px}.empty-orbit{width:110px;height:110px;border:1px dashed #b6c9bb;border-radius:50%;display:grid;place-items:center;margin:auto;color:#315b48;font-weight:700}.people-list{margin-top:24px}.list-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.list-heading>div:first-child{display:flex;align-items:baseline;gap:10px}.list-heading h2{font-size:16px;margin:0}.list-heading span{font-size:12px;color:#7b857f}.list-filters{display:flex;gap:8px;width:min(500px,65%)}.list-filters .el-input{flex:1}.list-filters .el-select{width:150px}.people-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:8px}.person-row{display:flex;align-items:center;gap:10px;min-width:0;padding:10px;border:1px solid #e9ebe6;background:#fff;border-radius:10px;text-align:left;color:#26332e;font:inherit;cursor:pointer}.person-row:hover,.person-row.active{border-color:#86a995;background:#f6faf6}.person-avatar{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:50%;background:#e8f0e9;color:#416c53;font-weight:700}.person-main{display:grid;gap:3px;min-width:0;flex:1}.person-main strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.person-main small{font-size:10px;color:#7b857f}.list-empty{padding:22px;text-align:center;color:#7b857f;border:1px dashed #dfe3dd;border-radius:10px}@media(max-width:850px){.graph-layout{grid-template-columns:1fr}.relationship-svg{max-height:none}.person-detail{padding:16px}}@media(max-width:560px){.graph-toolbar,.list-heading{align-items:stretch;flex-direction:column}.list-filters{width:100%}.empty-graph{grid-template-columns:1fr;padding:20px}.empty-orbit{display:none}}
</style>
