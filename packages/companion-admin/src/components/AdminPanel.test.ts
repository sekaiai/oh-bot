import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus';
import { setBearerToken } from '../auth/session';
import AdminPanel from './AdminPanel.vue';

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn().mockResolvedValue({ value: '管理员复核来源后提交' }) } };
});

const section = (key: string, label = key) => ({ key, label, path: `/admin/${key}`, description: `${label}数据` });
afterEach(() => { vi.unstubAllGlobals(); setBearerToken(null); vi.clearAllMocks(); });

describe('AdminPanel', () => {
  it('renders the overview object shape rather than parsing it as a list', async () => {
    setBearerToken('memory-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ health: 'ready', configured: { model: false, qq: true }, counts: { characters: 1 }, queueReady: true }), { status: 200 })));
    const wrapper = mount(AdminPanel, { props: { section: section('overview', '系统概览') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.text()).toContain('ready'); expect(wrapper.text()).toContain('characters'); expect(wrapper.text()).toContain('1'); expect(wrapper.text()).toContain('已配置');
  });

  it('redacts opaque top-level and nested secret keys in a rendered record', async () => {
    setBearerToken('memory-token');
    const row = { id: 'person-1', token: 'opaque-bearer', accessToken: 'opaque-access', password: 'opaque-password', apiKey: 'opaque-key', nested: { credential: 'opaque-credential' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([row]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('identities', '身份与角色') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('身份绑定'))!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('person-1');
    for (const secret of ['opaque-bearer', 'opaque-access', 'opaque-password', 'opaque-key', 'opaque-credential']) expect(wrapper.text()).not.toContain(secret);
    expect(wrapper.text().match(/\[已隐藏\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('posts exactly the validated source-grounded approval body and preserves a version conflict', async () => {
    setBearerToken('memory-token');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'revision-1', version: 4, status: 'candidate', sourceQuote: '我目前在读护理专业。' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'version_conflict' }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('memory-revisions', '记忆修订') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('审阅并批准'))!.trigger('click');
    await wrapper.findAll('button').find((button) => button.text().includes('批准候选'))!.trigger('click');
    await flushPromises();
    const post = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(fetcher.mock.calls[1]?.[0]).toContain('/admin/memory-revisions/revision-1/approve');
    expect(post.method).toBe('POST');
    expect(JSON.parse(String(post.body))).toEqual({ expectedVersion: 4, claimKind: 'direct', evidenceQuote: '我目前在读护理专业。' });
    expect(JSON.stringify(post.body)).not.toContain('auditReason');
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('409'));
  });

  it('updates a model profile with the controller fieldnames and strict integer version', async () => {
    setBearerToken('memory-token');
    const profile = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f91', version: 3, name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY', dimensions: null, maxTokens: 1200, timeoutMs: 30000, monthlyBudgetUsd: null };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(profile), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((card) => card.text().includes('聊天'))!.trigger('click');
    await wrapper.findAll('button').find((button) => button.text().includes('保存模型配置'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).includes(`/admin/model-profiles/${profile.id}`) && init?.method === 'PUT');
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ version: 3, name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY', dimensions: null, maxTokens: 1200, timeoutMs: 30000, monthlyBudgetUsd: null });
  });

  it('tests a selected profile only after an explicit click with its current version', async () => {
    setBearerToken('memory-token');
    const profile = { id: 'chat-profile', version: 4, purpose: 'chat', name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY', enabled: false };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: profile.id, version: 4, lastTestStatus: 'passed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ...profile, lastTestStatus: 'passed' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/test'))).toBe(false);
    const card = wrapper.findAll('article').find((item) => item.text().includes('聊天'))!;
    await card.findAll('button').find((button) => button.text().includes('测试模型'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith(`/admin/model-profiles/${profile.id}/test`) && init?.method === 'POST');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ version: 4 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/admin/model-profiles')).length).toBe(2);
  });

  it('enables a profile with the selected version and reports a 409 for refresh', async () => {
    setBearerToken('memory-token');
    const profile = { id: 'memory-profile', version: 6, purpose: 'memory', name: '记忆', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-b', credentialRef: 'MEMORY_KEY', enabled: false };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'version_conflict' }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((item) => item.text().includes('记忆'))!.findAll('button').find((button) => button.text().includes('启用模型'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith(`/admin/model-profiles/${profile.id}/enabled`) && init?.method === 'PUT');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ version: 6, enabled: true, auditReason: '管理员复核来源后提交' });
    const promptOptions = vi.mocked(ElMessageBox.prompt).mock.calls[0]?.[2] as { inputValidator: (value: string) => boolean | string };
    expect(promptOptions.inputValidator('原因')).toBe('操作原因至少需要 8 个字符');
    expect(promptOptions.inputValidator('管理员复核来源后提交')).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('409'));
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('请刷新'));
  });

  it('shows a profile test failure without hiding the server reason', async () => {
    setBearerToken('memory-token');
    const profile = { id: 'search-profile', version: 2, purpose: 'search', name: '检索', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'embed-a', credentialRef: 'SEARCH_KEY' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'provider_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((item) => item.text().includes('检索'))!.findAll('button').find((button) => button.text().includes('测试模型'))!.trigger('click');
    await flushPromises();
    expect(ElMessage.error).toHaveBeenCalledWith('provider_unavailable');
  });

  it('reports an HTTP 200 failed test status and reloads the updated profile', async () => {
    setBearerToken('memory-token');
    const profile = { id: 'chat-profile', version: 4, purpose: 'chat', name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: profile.id, version: 4, lastTestStatus: 'failed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ...profile, version: 5, lastTestStatus: 'failed' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((item) => item.text().includes('聊天'))!.findAll('button').find((button) => button.text().includes('测试模型'))!.trigger('click');
    await flushPromises();
    expect(ElMessage.error).toHaveBeenCalledWith('模型测试未通过，请检查凭据、价格与服务配置');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/admin/model-profiles')).length).toBe(2);
    expect(wrapper.text()).toContain('5');
  });

  it('rejects unknown HTTP 200 test statuses instead of reporting success', async () => {
    setBearerToken('memory-token');
    const profile = { id: 'chat-profile', version: 4, purpose: 'chat', name: '聊天', provider: 'openai' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: profile.id }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([profile]), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((item) => item.text().includes('聊天'))!.findAll('button').find((button) => button.text().includes('测试模型'))!.trigger('click');
    await flushPromises();
    expect(ElMessage.error).toHaveBeenCalledWith('模型测试结果无效，请刷新后重试');
    expect(ElMessage.success).not.toHaveBeenCalledWith('模型测试已完成');
  });

  it('blocks enabling unsupported profiles while allowing an enabled profile to be disabled', async () => {
    setBearerToken('memory-token');
    const profiles = [
      { id: 'embedding-profile', version: 1, purpose: 'embedding', name: '向量', provider: 'openai', enabled: false },
      { id: 'enabled-legacy-profile', version: 2, purpose: 'embedding', name: '已启用旧服务', provider: 'custom', enabled: true },
      { id: 'custom-chat-profile', version: 3, purpose: 'chat', name: '自定义聊天', provider: 'custom', enabled: false }
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(profiles), { status: 200 })));
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    const embedding = wrapper.findAll('article').find((item) => item.text().includes('向量'))!;
    expect(embedding.findAll('button').find((button) => button.text().includes('测试模型'))!.attributes('disabled')).toBeDefined();
    expect(embedding.findAll('button').find((button) => button.text().includes('启用模型'))!.attributes('disabled')).toBeDefined();
    const custom = wrapper.findAll('article').find((item) => item.text().includes('自定义聊天'))!;
    expect(custom.findAll('button').find((button) => button.text().includes('测试模型'))!.attributes('disabled')).toBeDefined();
    const enabled = wrapper.findAll('article').find((item) => item.text().includes('已启用旧服务'))!;
    expect(enabled.findAll('button').find((button) => button.text().includes('禁用模型'))!.attributes('disabled')).toBeUndefined();
  });

  it('submits enabled-only agent settings using its separate expectedVersion schema', async () => {
    setBearerToken('memory-token');
    const agent = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f92', version: 2, name: '陪伴 agent', enabled: false };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...agent }], configured: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...agent }], configured: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Agent')!.trigger('click');
    await flushPromises();
    await wrapper.findAll('article').find((card) => card.text().includes('陪伴 agent'))!.trigger('click');
    const reasonInput = wrapper.findAll('.el-form-item').find((item) => item.text().includes('审计原因'))!.find('input');
    await reasonInput.setValue('管理员按审查结论暂停');
    await wrapper.findAll('button').find((button) => button.text().includes('保存Agent'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).includes(`/admin/agents/${agent.id}`) && init?.method === 'PUT');
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ expectedVersion: 2, enabled: false, settings: {}, auditReason: '管理员按审查结论暂停' });
  });

  it('preserves an enabled group proactive policy when saving another field', async () => {
    setBearerToken('memory-token');
    const conversationId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f85';
    const characterId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f86';
    const policy = { id: 'group-policy', version: 7, scope: 'group', conversationId, characterId, proactiveEnabled: true, quietStart: '22:00', quietEnd: '08:00', timeZone: 'UTC', maxPerDay: 2 };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [policy] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 8 }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('permissions', '主动提醒授权') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('article').find((card) => card.text().includes('group-policy'))!.trigger('click');
    await wrapper.findAll('.el-form-item').find((item) => item.text().includes('安静开始'))!.find('input').setValue('21:30');
    await wrapper.findAll('.el-form-item').find((item) => item.text().includes('审计原因'))!.find('input').setValue('管理员调整安静时段');
    await wrapper.findAll('button').find((button) => button.text().includes('保存授权'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/proactive-permissions') && init?.method === 'PUT');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ characterId, conversationId, scope: 'group', enabled: true, quietStart: '21:30', quietEnd: '08:00', timeZone: 'UTC', maxPerDay: 2, expectedVersion: 7, auditReason: '管理员调整安静时段' });
  });

  it('clears an Agent editor on tab change and ignores its late list response', async () => {
    setBearerToken('memory-token');
    const agent = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f87', version: 2, name: '旧 Agent', enabled: true };
    const toolSettings = { apiUrl: 'https://weather.example/v1', credentialRef: 'WEATHER_API_KEY' };
    const tool = { id: 'weather', version: 5, name: '天气工具', enabled: true, settings: toolSettings };
    let resolveAgents!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/admin/model-profiles')) return Promise.resolve(new Response('[]', { status: 200 }));
      if (path.endsWith('/admin/agents')) return new Promise<Response>((resolve) => { resolveAgents = resolve; });
      if (path.endsWith('/admin/tools')) return Promise.resolve(new Response(JSON.stringify({ items: [tool], configured: true }), { status: 200 }));
      if (path.endsWith('/admin/tools/weather')) return Promise.resolve(new Response(JSON.stringify({ id: 'weather', version: 6 }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ message: 'not_found' }), { status: 404 }));
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Agent')!.trigger('click');
    expect(resolveAgents).toBeDefined();
    await wrapper.findAll('button').find((button) => button.text() === '工具')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('天气工具');
    expect(wrapper.text()).not.toContain('旧 Agent');
    expect(wrapper.findAll('button').some((button) => button.text().includes('保存工具'))).toBe(false);

    resolveAgents(new Response(JSON.stringify({ items: [agent], configured: true }), { status: 200 }));
    await flushPromises();
    expect(wrapper.text()).toContain('天气工具');
    expect(wrapper.text()).not.toContain('旧 Agent');
    expect(wrapper.findAll('button').some((button) => button.text().includes('保存工具'))).toBe(false);

    await wrapper.findAll('article').find((card) => card.text().includes('天气工具'))!.trigger('click');
    await wrapper.findAll('.el-form-item').find((item) => item.text().includes('审计原因'))!.find('input').setValue('管理员复核工具配置');
    await wrapper.findAll('button').find((button) => button.text().includes('保存工具'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/tools/weather') && init?.method === 'PUT');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ expectedVersion: 5, enabled: true, settings: toolSettings, auditReason: '管理员复核工具配置' });
    expect(fetcher.mock.calls.some(([url, init]) => String(url).includes('/admin/agents/') && init?.method === 'PUT')).toBe(false);
  });

  it('confirms backup verification and sends the server-listed manifest hash as CAS', async () => {
    setBearerToken('memory-token');
    const backup = { id: 'backup-record-1', backupId: 'backup-2026-10-23-test', version: 'c'.repeat(64), status: 'ready', configured: true };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ capability: 'backup', configured: true, ready: true }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [backup], configured: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ backupId: backup.backupId, version: backup.version }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [backup], configured: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('operations', '备份与迁移') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === '备份')!.trigger('click');
    await flushPromises();
    await wrapper.findAll('article').find((card) => card.text().includes(backup.backupId))!.trigger('click');
    expect(wrapper.findAll('button').find((button) => button.text() === '提交')!.attributes('disabled')).toBeUndefined();
    await wrapper.findAll('.el-form-item').find((item) => item.text().includes('审计原因'))!.find('input').setValue('经值班负责人核准校验');
    await wrapper.findAll('button').find((button) => button.text() === '提交')!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/backups') && init?.method === 'POST');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ action: 'verify', backupId: backup.backupId, expectedVersion: backup.version, auditReason: '经值班负责人核准校验', confirm: true });
    expect(ElMessageBox.confirm).toHaveBeenCalled();
  });

  it('submits a relationship event with its allowed kind and source IDs as evidence', async () => {
    setBearerToken('memory-token');
    const personId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f88';
    const characterId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f89';
    const sourceId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f90';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'event-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('relationships', '关系事件') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    const input = (label: string) => wrapper.findAll('.el-form-item').find((item) => item.text().includes(label))!.find('input');
    await input('人物 ID').setValue(personId);
    await input('角色 ID').setValue(characterId);
    await input('来源消息 ID').setValue(sourceId);
    await input('审计原因').setValue('依据管理员审核来源证据');
    await wrapper.findAll('button').find((button) => button.text().includes('提交关系事件'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/relationships') && init?.method === 'POST');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ personId, characterId, event: 'conversation', sourceIds: [sourceId], auditReason: '依据管理员审核来源证据' });
  });

  it('includes the selected source message ID in a commitment request', async () => {
    setBearerToken('memory-token');
    const personId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f91';
    const characterId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f92';
    const sourceMessageId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f93';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'commitment-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('commitments', '提醒事项') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    const input = (label: string) => wrapper.findAll('.el-form-item').find((item) => item.text().includes(label))!.find('input');
    await input('人物 ID').setValue(personId);
    await input('角色 ID').setValue(characterId);
    await input('来源消息 ID').setValue(sourceMessageId);
    await input('提醒内容').setValue('稍后提醒复查');
    await input('提醒时间').setValue('2027-01-01T12:00:00');
    await input('提醒范围').setValue('person');
    await input('审计原因').setValue('依据管理员审核来源证据');
    await wrapper.findAll('button').find((button) => button.text().includes('提交提醒请求'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/admin/commitments') && init?.method === 'POST');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ personId, characterId, sourceMessageId, text: '稍后提醒复查', dueAt: '2027-01-01T12:00:00.000Z', scope: 'person', auditReason: '依据管理员审核来源证据' });
  });

  it('submits tool settings using its separate exact payload and displays unavailable response', async () => {
    setBearerToken('memory-token');
    const toolSettings = { apiUrl: 'https://weather.example/v1', credentialRef: 'WEATHER_API_KEY' };
    const tool = { id: 'weather', version: 1, name: '天气', enabled: true, settings: toolSettings };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [tool], configured: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'capability_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('models', '模型与工具') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === '工具')!.trigger('click');
    await flushPromises();
    await wrapper.findAll('article').find((card) => card.text().includes('天气'))!.trigger('click');
    await wrapper.findAll('.el-form-item').find((item) => item.text().includes('审计原因'))!.find('input').setValue('管理员按审查结论暂停');
    await wrapper.findAll('button').find((button) => button.text().includes('保存工具'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls[2];
    expect(call?.[0]).toContain('/admin/tools/weather');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ expectedVersion: 1, enabled: true, settings: toolSettings, auditReason: '管理员按审查结论暂停' });
    expect(ElMessage.error).toHaveBeenCalledWith('capability_unavailable');
    expect(ElMessage.success).not.toHaveBeenCalled();
  });

  it('uses the revision forget endpoint with its strict body and confirms before submission', async () => {
    setBearerToken('memory-token');
    const revision = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f94', version: 2, status: 'approved' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [revision] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'capability_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('memory-revisions', '记忆修订') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('忘记此修订'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls[1];
    expect(call?.[0]).toContain(`/admin/memory-revisions/${revision.id}/forget`);
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ expectedVersion: 2, auditReason: '管理员复核来源后提交', confirm: true });
    expect(ElMessageBox.confirm).toHaveBeenCalled();
    expect(ElMessage.error).toHaveBeenCalledWith('capability_unavailable');
  });

  it('posts a source-evidence correction only after the correction confirmation', async () => {
    setBearerToken('memory-token');
    const revision = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f95', version: 3, status: 'candidate', sourceQuote: '我之前在上海工作。' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [revision] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'capability_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('memory-revisions', '记忆修订') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('更正事实'))!.trigger('click');
    await flushPromises();
    const textareas = wrapper.findAll('textarea');
    await textareas[textareas.length - 1]!.setValue('更正为：我现在在杭州工作。');
    await wrapper.findAll('button').find((button) => button.text().includes('提交更正'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls[1];
    expect(call?.[0]).toContain(`/admin/memory-revisions/${revision.id}/correct`);
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ expectedVersion: 3, evidenceQuote: '我之前在上海工作。', factText: '更正为：我现在在杭州工作。', auditReason: '管理员复核来源后提交', confirm: true });
    expect(ElMessage.error).toHaveBeenCalledWith('capability_unavailable');
    expect(ElMessage.success).not.toHaveBeenCalled();
  });

  it('posts a source deletion with confirm:true only after reason and explicit confirmation', async () => {
    setBearerToken('memory-token');
    const source = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f93', scope: 'person:018f47b0-0c9d-7b20-9f43-7d0411ba7f90', status: 'active' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [source] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'capability_unavailable' }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('memory-sources', '记忆来源') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('删除此来源'))!.trigger('click');
    await flushPromises();
    const call = fetcher.mock.calls[1];
    expect(call?.[0]).toContain('/admin/deletions');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ sourceIds: [source.id], scope: source.scope, auditReason: '管理员复核来源后提交', confirm: true });
    expect(ElMessage.error).toHaveBeenCalledWith('capability_unavailable');
    expect(ElMessage.success).not.toHaveBeenCalled();
  });

  it('sends no delete request when destructive confirmation is cancelled', async () => {
    setBearerToken('memory-token');
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce(new Error('cancelled'));
    const source = { id: '018f47b0-0c9d-7b20-9f43-7d0411ba7f93', scope: 'person:018f47b0-0c9d-7b20-9f43-7d0411ba7f90', status: 'active' };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [source] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(AdminPanel, { props: { section: section('memory-sources', '记忆来源') }, global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('删除此来源'))!.trigger('click');
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
