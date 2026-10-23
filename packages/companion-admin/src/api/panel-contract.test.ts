import { describe, expect, it } from 'vitest';
import { parseOperationBody, responseFor, safeForDisplay } from './panel-contract';

describe('admin panel contracts', () => {
  it('redacts opaque secret values by their key at every nesting level', () => {
    expect(safeForDisplay({ token: 'bearer-123', accessToken: 'opaque', password: 'pw', apiKey: 'secret', nested: { credential: 'opaque-credential' } })).toEqual({
      token: '[已隐藏]', accessToken: '[已隐藏]', password: '[已隐藏]', apiKey: '[已隐藏]', nested: { credential: '[已隐藏]' }
    });
  });
  it('selects object, envelope, and raw-array response schemas by operation', () => {
    expect(responseFor('overview', { health: 'ready', configured: {}, counts: {} }).health).toBe('ready');
    expect(responseFor('characters', [{ id: 'c1', name: '南枝' }]).items).toHaveLength(1);
    expect(responseFor('model-profiles', [{ id: 'm1', version: 2 }]).items).toHaveLength(1);
    expect(responseFor('tool-runs', { items: [] }).items).toHaveLength(0);
    expect(() => responseFor('overview', { items: [] })).toThrow();
  });
  it('emits exact memory approval fields and rejects invalid CAS versions', () => {
    expect(parseOperationBody('memory-approve', { expectedVersion: '2', claimKind: 'direct', evidenceQuote: '用户明确确认的原句' }))
      .toEqual({ expectedVersion: 2, claimKind: 'direct', evidenceQuote: '用户明确确认的原句' });
    expect(() => parseOperationBody('memory-approve', { expectedVersion: '2', claimKind: 'direct', evidenceQuote: '用户明确确认的原句', ignored: 'drop' })).toThrow();
    expect(() => parseOperationBody('memory-approve', { expectedVersion: '2.5', claimKind: 'direct', evidenceQuote: '原句' })).toThrow();
  });
  it('emits only the documented model profile update shape', () => {
    expect(parseOperationBody('model-update', { version: '3', name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY', dimensions: '', maxTokens: '1200', timeoutMs: '30000', monthlyBudgetUsd: '' }))
      .toEqual({ version: 3, name: '聊天', provider: 'openai', baseUrl: 'https://api.example/v1', model: 'model-a', credentialRef: 'CHAT_KEY', dimensions: null, maxTokens: 1200, timeoutMs: 30000, monthlyBudgetUsd: null });
  });
  it('requires exact confirmation and selected-record SHA-256 CAS for operations writes', () => {
    const hash = 'a'.repeat(64);
    expect(parseOperationBody('backup-action', { action: 'verify', backupId: 'backup-2026-10-23-test', expectedVersion: hash, auditReason: '经值班负责人授权', confirm: true }))
      .toEqual({ action: 'verify', backupId: 'backup-2026-10-23-test', expectedVersion: hash, auditReason: '经值班负责人授权', confirm: true });
    expect(parseOperationBody('backup-action', { action: 'create', auditReason: '按计划创建备份记录', confirm: true }))
      .toEqual({ action: 'create', auditReason: '按计划创建备份记录', confirm: true });
    expect(() => parseOperationBody('backup-action', { action: 'verify', backupId: 'backup-1', expectedVersion: hash, auditReason: '经值班负责人授权' })).toThrow();
    expect(() => parseOperationBody('backup-action', { action: 'restore', backupId: 'backup-1', expectedVersion: '2', auditReason: '经值班负责人授权', confirm: true })).toThrow();
    expect(parseOperationBody('migration-action', { action: 'apply', sourceId: 'personas.json', expectedVersion: hash, auditReason: '按审查结果应用迁移', confirm: true }))
      .toEqual({ action: 'apply', sourceId: 'personas.json', expectedVersion: hash, auditReason: '按审查结果应用迁移', confirm: true });
    expect(() => parseOperationBody('migration-action', { action: 'apply', sourceId: 'personas.json', auditReason: '按审查结果应用迁移', confirm: true })).toThrow();
  });
  it('validates distinct tool and agent operation contracts with strict output', () => {
    expect(parseOperationBody('agent-update', { expectedVersion: '2', enabled: true, settings: {}, auditReason: '管理员按审查结论暂停' })).toEqual({ expectedVersion: 2, enabled: true, settings: {}, auditReason: '管理员按审查结论暂停' });
    const toolSettings = { apiUrl: 'https://search.example/v1', credentialRef: 'SEARCH_API_KEY' };
    expect(parseOperationBody('tool-update', { expectedVersion: '1', enabled: false, settings: toolSettings, auditReason: '管理员按审查结论暂停' })).toEqual({ expectedVersion: 1, enabled: false, settings: toolSettings, auditReason: '管理员按审查结论暂停' });
    expect(() => parseOperationBody('tool-update', { expectedVersion: '1', enabled: false, settings: { ...toolSettings, apiKey: 'raw-secret' }, auditReason: '管理员按审查结论暂停' })).toThrow();
    expect(() => parseOperationBody('tool-update', { expectedVersion: '1', enabled: false, settings: { ...toolSettings, apiUrl: 'https://search.example/v1?token=secret' }, auditReason: '管理员按审查结论暂停' })).toThrow();
    expect(() => parseOperationBody('agent-update', { expectedVersion: '1.5', enabled: true, auditReason: '管理员按审查结论暂停' })).toThrow();
    expect(() => parseOperationBody('agent-update', { expectedVersion: 1, enabled: true, settings: { prompt: 'not-supported' }, auditReason: '管理员按审查结论暂停' })).toThrow();
  });
  it('validates proactive policy target exclusivity before constructing a request', () => {
    const base = { characterId: '018f47b0-0c9d-7b20-9f43-7d0411ba7f89', scope: 'person', personId: '018f47b0-0c9d-7b20-9f43-7d0411ba7f89', enabled: true, expectedVersion: '1', auditReason: '管理员确认用户明确开启' };
    expect(parseOperationBody('permission-update', base)).toMatchObject({ personId: base.personId, scope: 'person', expectedVersion: 1 });
    expect(() => parseOperationBody('permission-update', { ...base, conversationId: '018f47b0-0c9d-7b20-9f43-7d0411ba7f89' })).toThrow();
    expect(() => parseOperationBody('permission-update', { ...base, quietStart: '25:70' })).toThrow();
  });
  it('requires source-grounded relationship evidence and a source message for commitments', () => {
    const personId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f89';
    const characterId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f90';
    const sourceId = '018f47b0-0c9d-7b20-9f43-7d0411ba7f91';
    const auditReason = '依据管理员审核来源证据';
    const relationship = { personId, characterId, event: 'appreciation', sourceIds: [sourceId], auditReason };
    expect(parseOperationBody('relationship-create', relationship)).toEqual(relationship);
    expect(() => parseOperationBody('relationship-create', { ...relationship, event: 'unsupported' })).toThrow();
    const commitment = { personId, characterId, sourceMessageId: sourceId, text: '稍后提醒复查', dueAt: '2027-01-01T12:00:00.000Z', scope: 'person', auditReason };
    expect(parseOperationBody('commitment-create', commitment)).toEqual(commitment);
    expect(() => parseOperationBody('commitment-create', { personId, characterId, text: commitment.text, dueAt: commitment.dueAt, scope: commitment.scope, auditReason })).toThrow();
  });
  it('requires evidence, compare-and-set version, audit reason, and confirmation for correction', () => {
    const correction = { expectedVersion: '4', evidenceQuote: '原始来源中的明确句子', factText: '修正后的事实', auditReason: '依据原始消息校正候选', confirm: true };
    expect(parseOperationBody('memory-correct', correction)).toEqual({ ...correction, expectedVersion: 4 });
    expect(() => parseOperationBody('memory-correct', { ...correction, confirm: false })).toThrow();
  });
});
