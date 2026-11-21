// ── Workspace slugs ─────────────────────────────────────────────────────────
//
// Better Auth requires a non-empty slug for every organization. The dashboard
// derives it from the workspace name (apps/dashboard/src/routes/onboarding.tsx).

/** 12 random lowercase hex characters (crypto-random). */
export function randomSlugSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A slug for a new workspace: the name's ASCII letters and digits, lowercased,
 * with accents dropped ("Café Müller" -> "cafe-muller") and every other run of
 * characters turned into one hyphen. A name with no ASCII letters or digits,
 * such as one written only in a non-Latin script ("株式会社テスト"), would give an
 * empty slug, which Better Auth refuses; it gets "workspace-<random>" instead.
 */
export function workspaceSlug(name: string, random: () => string = randomSlugSuffix): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `workspace-${random()}`;
}
