// ── Workspace names ─────────────────────────────────────────────────────────
//
// A workspace (Better Auth "organization") name is chosen by whoever creates
// it and is then shown to other people: in the dashboard, and in invitation
// emails GoPayLocal sends from its own domain to any address. So it must read
// as a name and nothing else: nothing that reads as a link (a scheme, "www.",
// a slash or path, an email address), no control or invisible characters
// (bidi overrides can make text read differently from what it is), no markup.
//
// Dots are allowed inside a name, so brand names like "Cal.com" work. A mail
// client would still turn "cal.com" into a clickable link, so the invitation
// email never prints a name shaped like a domain: workspaceNameForEmail()
// returns null for it and the email says "a workspace" instead.
//
// Enforced on create and rename by auth.ts (organizationHooks). Names stored
// before the rule existed are left alone; the invitation email falls back to
// "a workspace" for any name that fails it.

export const WORKSPACE_NAME_MIN = 2;
export const WORKSPACE_NAME_MAX = 60;

/** Control, format (zero-width, bidi), private-use, unassigned, line/paragraph separators. */
const FORBIDDEN_INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/**
 * Letters and combining marks in any script, digits, space, a little ASCII
 * punctuation, and punctuation common in company names written in other
 * scripts: the middle dots · and ・ (Japanese ジョンソン・エンド・ジョンソン),
 * full-width （ ） and ＆ (（株）), and the Hebrew geresh ׳ and gershayim ״ (בע״מ).
 * Nothing here can form a scheme, path or address: no : / \ @ and no
 * ideographic full stop (IDNA reads 。 as a dot).
 */
const ALLOWED = /^[\p{L}\p{M}\p{N} &'’\-.,()+!_·・（）＆׳״]+$/u;
/**
 * Shapes that read as a link: a scheme ("https://", "mailto:x"), "www.", a
 * slash, a backslash or an @. (A colon alone, as in "Acme: Labs", is refused
 * by ALLOWED with the general message instead.)
 */
const LINK_LIKE = /(?:^|\s)[a-z][a-z0-9+.\-]*:\S|:\/\/|[/\\@]|(?:^|[^\p{L}\p{N}])www\./iu;
/** A domain shape a mail client auto-links: "cal.com", "Pay at evil.example". */
const DOMAIN_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u;

export const WORKSPACE_NAME_RULE =
  `Workspace names are ${WORKSPACE_NAME_MIN}–${WORKSPACE_NAME_MAX} characters of letters (in any language), numbers, ` +
  "spaces and & ' - . , ( ) + ! _, and can't look like a link.";

export const WORKSPACE_NAME_LINK_ERROR =
  'Workspace names can\'t look like a link: no "www.", "://", slashes or @. A dot is fine, as in "Cal.com".';

export type WorkspaceNameCheck = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate and normalise a workspace name: NFC, runs of spaces collapsed to
 * one, trimmed. Returns the name to store, or why it was refused.
 */
export function checkWorkspaceName(input: unknown): WorkspaceNameCheck {
  if (typeof input !== "string") return { ok: false, error: "Workspace name is required." };
  if (FORBIDDEN_INVISIBLE.test(input)) {
    return { ok: false, error: "Workspace names can't contain line breaks, control or invisible characters." };
  }
  const name = input.normalize("NFC").replace(/\p{Zs}+/gu, " ").trim();
  const length = [...name].length;
  if (length < WORKSPACE_NAME_MIN || length > WORKSPACE_NAME_MAX) {
    return {
      ok: false,
      error: `Workspace names are ${WORKSPACE_NAME_MIN}–${WORKSPACE_NAME_MAX} characters long.`,
    };
  }
  if (LINK_LIKE.test(name)) return { ok: false, error: WORKSPACE_NAME_LINK_ERROR };
  if (!ALLOWED.test(name) || !/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: WORKSPACE_NAME_RULE };
  return { ok: true, name };
}

/**
 * The stored name as the invitation email may print it, or null when the
 * email must say "a workspace" instead: a name that breaks the rule (stored
 * before it existed), or one a mail client would turn into a link ("Cal.com").
 */
export function workspaceNameForEmail(stored: unknown): string | null {
  const checked = checkWorkspaceName(stored);
  if (!checked.ok || DOMAIN_LIKE.test(checked.name)) return null;
  return checked.name;
}
