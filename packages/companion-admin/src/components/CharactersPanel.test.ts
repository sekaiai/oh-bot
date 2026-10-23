import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { setBearerToken } from '../auth/session';
import CharactersPanel from './CharactersPanel.vue';

const characterId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f89';
const personId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f90';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); setBearerToken(null); });

describe('CharactersPanel', () => {
  it('creates a character and saves a primary partner using exact backend routes and bodies', async () => {
    setBearerToken('bearer-in-memory');
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/primary-partner') && init?.method === 'PUT') return response({ ok: true });
      if (path.includes('/admin/characters/') && path.endsWith('/primary-partner')) return response({ personId: null });
      if (path.endsWith('/admin/characters') && init?.method === 'POST') return response({ id: characterId, name: '南枝' });
      if (path.endsWith('/admin/characters')) return response([{ id: characterId, name: '南枝', version: 0 }]);
      if (path.endsWith('/admin/people')) return response([{ id: personId, displayName: '小林', aliases: [], status: 'active' }]);
      return response({ message: 'not_found' }, 404);
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(CharactersPanel, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    await wrapper.find('input').setValue('南枝');
    await wrapper.findAll('button').find((button) => button.text().includes('创建'))!.trigger('click');
    await flushPromises();
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/admin/characters') && init?.method === 'POST' && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ name: '南枝' }))).toBe(true);

    await wrapper.find('.el-select__wrapper').trigger('click');
    await flushPromises();
    const choice = [...document.body.querySelectorAll('.el-select-dropdown__item')].find((node) => node.textContent?.includes('小林')) as HTMLElement | undefined;
    expect(choice).toBeDefined(); choice!.click(); await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('保存绑定'))!.trigger('click');
    await flushPromises();
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith(`/admin/characters/${characterId}/primary-partner`) && init?.method === 'PUT' && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ personId }))).toBe(true);
  });

  it('keeps the selected character partner when older reads resolve later and saves only that partner', async () => {
    setBearerToken('bearer-in-memory');
    const characterA = '018f47b0-0c9d-7b20-9f43-7d0411ba7f81';
    const characterB = '018f47b0-0c9d-7b20-9f43-7d0411ba7f82';
    const partnerA = '018f47b0-0c9d-7b20-9f43-7d0411ba7f83';
    const partnerB = '018f47b0-0c9d-7b20-9f43-7d0411ba7f84';
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/primary-partner') && init?.method === 'PUT') return Promise.resolve(response({ ok: true }));
      if (path.endsWith(`/characters/${characterA}/primary-partner`)) return new Promise<Response>((resolve) => { resolveA = resolve; });
      if (path.endsWith(`/characters/${characterB}/primary-partner`)) return new Promise<Response>((resolve) => { resolveB = resolve; });
      if (path.endsWith('/admin/characters')) return Promise.resolve(response([{ id: characterA, name: 'A' }, { id: characterB, name: 'B' }]));
      if (path.endsWith('/admin/people')) return Promise.resolve(response([{ id: partnerA, displayName: '伴侣 A', status: 'active' }, { id: partnerB, displayName: '伴侣 B', status: 'active' }]));
      return Promise.resolve(response({ message: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(CharactersPanel, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(resolveA).toBeDefined();

    await wrapper.findAll('.character-choice')[1]!.trigger('click');
    expect(resolveB).toBeDefined();
    expect(wrapper.findAll('button').find((button) => button.text().includes('保存绑定'))!.attributes('disabled')).toBeDefined();
    resolveB(response({ personId: partnerB }));
    await flushPromises();
    resolveA(response({ personId: partnerA }));
    await flushPromises();

    const select = wrapper.find('.el-select__wrapper');
    expect(select.text()).toContain('伴侣 B');
    await wrapper.findAll('button').find((button) => button.text().includes('保存绑定'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => init?.method === 'PUT');
    expect(write?.[0]).toContain(`/admin/characters/${characterB}/primary-partner`);
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ personId: partnerB });
  });

  it('preserves an explicit partner choice made while that character read is pending', async () => {
    setBearerToken('bearer-in-memory');
    const character = '018f47b0-0c9d-7b20-9f43-7d0411ba7f85';
    const serverPartner = '018f47b0-0c9d-7b20-9f43-7d0411ba7f86';
    const chosenPartner = '018f47b0-0c9d-7b20-9f43-7d0411ba7f87';
    let resolvePartner!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/primary-partner') && init?.method === 'PUT') return Promise.resolve(response({ ok: true }));
      if (path.endsWith('/primary-partner')) return new Promise<Response>((resolve) => { resolvePartner = resolve; });
      if (path.endsWith('/admin/characters')) return Promise.resolve(response([{ id: character, name: '角色' }]));
      if (path.endsWith('/admin/people')) return Promise.resolve(response([{ id: serverPartner, displayName: '服务端绑定', status: 'active' }, { id: chosenPartner, displayName: '手动选择', status: 'active' }]));
      return Promise.resolve(response({ message: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(CharactersPanel, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(resolvePartner).toBeDefined();
    await wrapper.find('.el-select__wrapper').trigger('click');
    await flushPromises();
    const choice = [...document.body.querySelectorAll('.el-select-dropdown__item')].find((node) => node.textContent?.includes('手动选择')) as HTMLElement | undefined;
    expect(choice).toBeDefined(); choice!.click(); await flushPromises();
    expect(wrapper.findAll('button').find((button) => button.text().includes('保存绑定'))!.attributes('disabled')).toBeUndefined();

    resolvePartner(response({ personId: serverPartner }));
    await flushPromises();
    expect(wrapper.find('.el-select__wrapper').text()).toContain('手动选择');
    await wrapper.findAll('button').find((button) => button.text().includes('保存绑定'))!.trigger('click');
    await flushPromises();
    const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/primary-partner') && init?.method === 'PUT');
    expect(write?.[0]).toContain(`/admin/characters/${character}/primary-partner`);
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ personId: chosenPartner });
  });
});
