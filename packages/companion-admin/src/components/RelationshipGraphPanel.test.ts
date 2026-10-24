import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import RelationshipGraphPanel from './RelationshipGraphPanel.vue';

const section = { key: 'relationship-graph', label: '关系图谱', path: '/admin/characters', description: 'AI 角色与人物的互动概览' };
const charA = '11111111-1111-4111-8111-111111111111';
const charB = '22222222-2222-4222-8222-222222222222';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const duplicateNamePerson = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const graphA = { character: { id: charA, name: '南枝' }, items: [{ personId: person, displayName: '林', familiarity: 0.7, trust: 0.45, stage: 'close', eventCount: 4, lastInteractionAt: '2026-01-02T03:04:05Z', isPrimaryPartner: true }, { personId: duplicateNamePerson, displayName: '林', familiarity: null, trust: null, stage: null, eventCount: 2, lastInteractionAt: null, isPrimaryPartner: false }], truncated: false };
const graphB = { character: { id: charB, name: '晚舟' }, items: [], truncated: false };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const mountPanel = () => mount(RelationshipGraphPanel, { props: { section }, global: { plugins: [ElementPlus] } });

afterEach(() => vi.unstubAllGlobals());

describe('RelationshipGraphPanel', () => {
  it('loads characters and graph, then shows selectable detail and percent values', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([{ id: charA, name: '南枝' }])).mockResolvedValueOnce(response(graphA));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mountPanel(); await flushPromises();
    expect(fetcher.mock.calls[0]![0]).toContain('/admin/characters?limit=100&offset=0');
    expect(fetcher.mock.calls[1]![0]).toContain(`/admin/characters/${charA}/relationship-graph`);
    expect(wrapper.text()).toContain('林'); expect(wrapper.text()).toContain('有效互动事件');
    expect(wrapper.text()).toContain('70%'); expect(wrapper.text()).toContain('45%');
    expect(wrapper.text()).toContain('主要伴侣');
    expect(wrapper.findAll('.person-row')).toHaveLength(2);
    await wrapper.findAll('.person-row')[1]!.trigger('click');
    expect(wrapper.find('.person-detail code').text()).toBe(duplicateNamePerson);
    expect(wrapper.text()).toContain('未知');
  });

  it('switches characters and ignores an older graph response that resolves last', async () => {
    let finishA!: (value: Response) => void;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([{ id: charA, name: '南枝' }, { id: charB, name: '晚舟' }]))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishA = resolve; }))
      .mockResolvedValueOnce(response(graphB));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mountPanel();
    await flushPromises();
    expect((wrapper.get('select').element as HTMLSelectElement).disabled).toBe(false);
    await wrapper.get('select').setValue(charB);
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(3);
    finishA(response(graphA)); await flushPromises();
    expect(wrapper.text()).toContain('晚舟'); expect(wrapper.text()).not.toContain('林');
  });

  it('shows an empty state when the chosen character has no relationships', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([{ id: charB, name: '晚舟' }])).mockResolvedValueOnce(response(graphB)));
    const wrapper = mountPanel(); await flushPromises();
    expect(wrapper.text()).toContain('暂无关系人物');
  });

  it('rejects graph data that identifies a different character', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([{ id: charA, name: '南枝' }])).mockResolvedValueOnce(response({ ...graphA, character: { id: charB, name: '晚舟' } })));
    const wrapper = mountPanel(); await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('其他角色的数据');
    expect(wrapper.text()).not.toContain('林');
  });

  it('reports graph request errors accessibly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([{ id: charA, name: '南枝' }])).mockResolvedValueOnce(response({ message: '关系图谱不可用' }, 503)));
    const wrapper = mountPanel(); await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('关系图谱不可用');
  });
});
