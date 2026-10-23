<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { z } from 'zod';
import { api } from '../api/client';
import { successSchema } from '../api/schemas';

type Character = { id: string; name: string; version?: number };
type Person = { id: string; displayName: string | null; aliases?: string[]; status?: string };
const characterSchema = z.array(z.object({ id: z.string().uuid(), name: z.string(), version: z.number().optional() }).passthrough());
const personSchema = z.array(z.object({ id: z.string().uuid(), displayName: z.string().nullable(), aliases: z.array(z.string()).optional(), status: z.string().optional() }).passthrough());
const partnerSchema = z.object({ personId: z.string().uuid().nullable() });
const characters = ref<Character[]>([]); const people = ref<Person[]>([]); const selectedId = ref(''); const partnerId = ref(''); const newName = ref('');
const loading = ref(false); const saving = ref(false); const error = ref(''); const partnerLoading = ref(false); const partnerLoaded = ref(false); const partnerChanged = ref(false);
let partnerRequestGeneration = 0;
const canSavePartner = computed(() => Boolean(selectedId.value && partnerId.value && (partnerLoaded.value || partnerChanged.value)));
async function load() {
  loading.value = true; error.value = '';
  try {
    const [chars, persons] = await Promise.all([api.get('/admin/characters', { limit: 100, offset: 0 }, characterSchema), api.get('/admin/people', { limit: 100, offset: 0 }, personSchema)]);
    characters.value = chars; people.value = persons;
    if (!selectedId.value && chars[0]) await selectCharacter(chars[0].id);
  } catch (e) { error.value = e instanceof Error ? e.message : '读取角色目录失败'; }
  finally { loading.value = false; }
}
async function selectCharacter(id: string) {
  const generation = ++partnerRequestGeneration;
  selectedId.value = id; partnerId.value = ''; partnerLoaded.value = false; partnerChanged.value = false; partnerLoading.value = true; error.value = '';
  try {
    const partner = await api.get(`/admin/characters/${encodeURIComponent(id)}/primary-partner`, undefined, partnerSchema);
    if (generation !== partnerRequestGeneration || selectedId.value !== id) return;
    if (!partnerChanged.value) partnerId.value = partner.personId ?? '';
    partnerLoaded.value = true;
  }
  catch (e) { if (generation === partnerRequestGeneration && selectedId.value === id) error.value = e instanceof Error ? e.message : '读取伴侣绑定失败'; }
  finally { if (generation === partnerRequestGeneration && selectedId.value === id) partnerLoading.value = false; }
}
async function createCharacter() {
  const name = newName.value.trim(); if (!name) { ElMessage.warning('请填写角色名称'); return; }
  saving.value = true;
  try { await api.post('/admin/characters', { name }); newName.value = ''; ElMessage.success('角色已创建'); await load(); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '创建失败'); }
  finally { saving.value = false; }
}
async function savePartner() {
  if (!canSavePartner.value) { ElMessage.warning('请等待当前角色绑定加载完成，或明确选择主要伴侣'); return; }
  const characterId = selectedId.value; const personId = partnerId.value;
  saving.value = true;
  try { await api.put(`/admin/characters/${encodeURIComponent(characterId)}/primary-partner`, { personId }, successSchema); ElMessage.success('主要伴侣已更新'); }
  catch (e) { ElMessage.error(e instanceof Error ? e.message : '更新失败'); }
  finally { saving.value = false; }
}
function personLabel(person: Person): string { return `${person.displayName || person.aliases?.[0] || '未命名身份'} · ${person.id.slice(0, 8)}`; }
onMounted(load);
</script>

<template>
  <div class="character-admin">
    <el-alert v-if="error" type="error" :closable="false" :title="error" />
    <el-skeleton v-if="loading && !characters.length" :rows="3" animated />
    <el-empty v-else-if="!characters.length" description="暂无角色，请按需创建角色" />
    <div v-else class="records"><button v-for="character in characters" :key="character.id" class="record character-choice" :aria-pressed="selectedId === character.id" @click="selectCharacter(character.id)"><strong>{{ character.name }}</strong><small>{{ character.id }}</small></button></div>
    <el-divider content-position="left">创建角色</el-divider>
    <el-form inline @submit.prevent="createCharacter"><el-form-item label="角色名称"><el-input v-model="newName" maxlength="160" /></el-form-item><el-button type="primary" :loading="saving" @click="createCharacter">创建</el-button></el-form>
    <el-divider content-position="left">主要伴侣绑定</el-divider>
    <el-form v-if="selectedId" inline @submit.prevent="savePartner"><el-form-item label="绑定到人物"><el-select v-model="partnerId" filterable :loading="partnerLoading" placeholder="选择已有可信人物" @update:model-value="partnerChanged = true"><el-option v-for="person in people.filter((item) => item.status === 'active' || !item.status)" :key="person.id" :label="personLabel(person)" :value="person.id" /></el-select></el-form-item><el-button type="primary" :disabled="!canSavePartner" :loading="saving" @click="savePartner">保存绑定</el-button></el-form>
    <p class="hint">角色绑定只使用服务端人物 ID；显示名不用于自动合并身份。</p>
  </div>
</template>
