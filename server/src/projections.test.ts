import * as projectionsModule from './projections';

const collectKeys = (value: any, acc: Set<string>) => {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) { acc.add(k); collectKeys(value[k], acc); }
  }
};

describe('projections', () => {
  it('no projection contains forbidden fields', () => {
    for (const [name, proj] of Object.entries((projectionsModule as any).projections)) {
      const keys = new Set<string>(); collectKeys(proj, keys);
      expect(keys.has('notification_token')).toBe(false);
      expect(keys.has('search_vector')).toBe(false);
      if (name.startsWith('api_keys')) expect(keys.has('key')).toBe(false);
    }
  });
  it('users list projection lacks uid and notification_token', () => {
    const keys = new Set<string>(); collectKeys((projectionsModule as any).userListSelect, keys);
    expect(keys.has('uid')).toBe(false);
    expect(keys.has('notification_token')).toBe(false);
  });
  it('api_keys projection lacks key', () => {
    const keys = new Set<string>(); collectKeys((projectionsModule as any).apiKeyListSelect, keys);
    expect(keys.has('key')).toBe(false);
  });
  it('users detail projection includes uid', () => {
    const keys = new Set<string>(); collectKeys((projectionsModule as any).userDetailSelect, keys);
    expect(keys.has('uid')).toBe(true);
  });
});
