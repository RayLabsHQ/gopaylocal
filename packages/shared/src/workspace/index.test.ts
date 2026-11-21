import { describe, it, expect } from 'vitest';
import { randomSlugSuffix, workspaceSlug } from './index';

describe('workspaceSlug', () => {
  it.each([
    ['Acme', 'acme'],
    ['Acme Labs', 'acme-labs'],
    ['  Cal.com  ', 'cal-com'],
    ["O'Brien's Courses (EU)", 'o-brien-s-courses-eu'],
    ['Café Müller', 'cafe-muller'],
    ['Web 2.0 Labs', 'web-2-0-labs'],
    ['（株）Acme', 'acme'],
  ])('%j -> %j', (name, slug) => {
    expect(workspaceSlug(name, () => 'unused')).toBe(slug);
  });

  it.each(['株式会社テスト', 'Компания', 'شركة', '회사 테스트', '&&'])(
    'a name with no ASCII letters or digits (%j) gets a random slug, never an empty one',
    (name) => {
      expect(workspaceSlug(name, () => 'a1b2c3d4e5f6')).toBe('workspace-a1b2c3d4e5f6');
    },
  );

  it('the default random suffix is 12 hex characters and differs between calls', () => {
    const a = randomSlugSuffix();
    const b = randomSlugSuffix();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(workspaceSlug('株式会社テスト')).toMatch(/^workspace-[0-9a-f]{12}$/);
  });
});
