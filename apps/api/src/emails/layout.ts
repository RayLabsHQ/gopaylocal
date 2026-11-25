// ── Email layout ────────────────────────────────────────────────────────────
// Every GoPayLocal email is one 600px card on a light page: a black header with
// the mark and the wordmark, the website's type (Space Grotesk and Inter where
// the client loads them, Helvetica or Arial where it doesn't), square red
// buttons and a footer saying why the email came. Tables and inline styles
// only: Gmail and Outlook drop <style> blocks, flexbox and most of CSS.
//
// Each block returns its HTML and its plain-text twin, so every email is sent
// with both. Content is written with **bold** as the only markup; md() escapes
// everything else, so a workspace name or a provider's error message can never
// become HTML in an email sent from GoPayLocal's domain.

export interface Email {
  subject: string;
  html: string;
  text: string;
}

export interface Block {
  html: string;
  text: string;
}

export interface EmailLinks {
  /** The dashboard's origin, e.g. https://app.gopaylocal.com. */
  app: string;
  /** Where help questions go; null leaves it out (self-hosted). */
  support: string | null;
}

const INK = "#0D0D0D";
const MUTED = "#55554F";
const FAINT = "#8A8A84";
const RULE = "#E4E4DE";
const RED = "#E42313";
const PAGE = "#F2F2ED";
const SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const DISPLAY = "'Space Grotesk', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** The mark on its dark tile (apps/web/public/apple-touch-icon.png). */
const LOGO_URL = "https://gopaylocal.com/apple-touch-icon.png";
const DOCS_URL = "https://docs.gopaylocal.com";
const REPO_URL = "https://github.com/RayLabsHQ/gopaylocal";

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** **bold** to <strong>, everything else escaped. */
function md(value: string): string {
  return esc(value).replace(/\*\*(.+?)\*\*/g, `<strong style="color:${INK};font-weight:600;">$1</strong>`);
}

function plain(value: string): string {
  return value.replace(/\*\*(.+?)\*\*/g, "$1");
}

export function para(content: string): Block {
  return {
    html: `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.6;color:${MUTED};">${md(content)}</p>`,
    text: plain(content),
  };
}

export function button(label: string, href: string): Block {
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td bgcolor="${RED}" style="background:${RED};">
<a href="${esc(href)}" style="display:inline-block;padding:14px 24px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1;color:#FFFFFF;text-decoration:none;">${esc(label)} &rarr;</a>
</td></tr></table>`,
    text: `${label}: ${href}`,
  };
}

/** A small grey line, e.g. the link to paste when a button doesn't work. */
export function note(content: string, href?: string): Block {
  const link = href
    ? ` <a href="${esc(href)}" style="color:${INK};text-decoration:underline;word-break:break-all;">${esc(href)}</a>`
    : "";
  return {
    html: `<p style="margin:0 0 16px;font-family:${SANS};font-size:13px;line-height:1.55;color:${FAINT};">${md(content)}${link}</p>`,
    text: plain(content) + (href ? ` ${href}` : ""),
  };
}

/** Big "used / limit" figures over a bar, for usage emails. */
export function meter(used: number, limit: number, caption: string): Block {
  const share = Math.max(0, Math.min(1, limit > 0 ? used / limit : 1));
  const pct = Math.round(share * 100);
  const fill =
    pct >= 100
      ? `<td bgcolor="${RED}" style="background:${RED};height:14px;font-size:0;line-height:0;">&nbsp;</td>`
      : `<td width="${pct}%" bgcolor="${RED}" style="background:${RED};height:14px;font-size:0;line-height:0;">&nbsp;</td><td style="height:14px;font-size:0;line-height:0;">&nbsp;</td>`;
  const n = (v: number) => v.toLocaleString("en-US");
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;">
<tr><td style="font-family:${DISPLAY};font-size:44px;font-weight:700;line-height:1;letter-spacing:-1.5px;color:${INK};">${n(used)}<span style="font-size:18px;font-weight:500;letter-spacing:0;color:${FAINT};">&nbsp;/ ${n(limit)}</span></td></tr>
<tr><td style="padding-top:14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${INK};"><tr>${fill}</tr></table></td></tr>
<tr><td style="padding-top:8px;font-family:${SANS};font-size:12px;letter-spacing:0.4px;text-transform:uppercase;color:${MUTED};">${pct}% used &middot; ${esc(caption)}</td></tr>
</table>`,
    text: `${n(used)} / ${n(limit)} (${pct}% used, ${caption})`,
  };
}

/** Numbered steps; a step can end with a code snippet. */
export function steps(items: ReadonlyArray<{ title: string; body: string; code?: string }>): Block {
  const rows = items
    .map(
      (s, i) => `<tr>
<td width="28" valign="top" style="padding:0 14px 20px 0;"><div style="width:26px;height:26px;background:${INK};color:#FFFFFF;font-family:${DISPLAY};font-size:13px;font-weight:700;line-height:26px;text-align:center;">${i + 1}</div></td>
<td valign="top" style="padding:0 0 20px;">
<p style="margin:2px 0 4px;font-family:${DISPLAY};font-size:16px;font-weight:600;line-height:1.3;color:${INK};">${esc(s.title)}</p>
<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.55;color:${MUTED};">${md(s.body)}</p>
${s.code ? `<div style="margin-top:10px;padding:12px 14px;background:${INK};color:#F2F2ED;font-family:${MONO};font-size:12px;line-height:1.6;word-break:break-all;">${esc(s.code)}</div>` : ""}
</td></tr>`,
    )
    .join("");
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;">${rows}</table>`,
    text: items.map((s, i) => `${i + 1}. ${s.title}\n   ${plain(s.body)}${s.code ? `\n   ${s.code}` : ""}`).join("\n\n"),
  };
}

/** A titled two-column table: label on the left, value on the right. */
export function facts(title: string, rows: ReadonlyArray<readonly [string, string]>): Block {
  const body = rows
    .map(
      ([label, value]) => `<tr>
<td style="padding:10px 12px 10px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;color:${MUTED};white-space:nowrap;">${esc(label)}</td>
<td align="right" style="padding:10px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;font-weight:600;color:${INK};">${esc(value)}</td>
</tr>`,
    )
    .join("");
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;border-top:2px solid ${INK};">
<tr><td colspan="2" style="padding:12px 0 4px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:${INK};">${esc(title)}</td></tr>
${body}</table>`,
    text: `${title}\n${rows.map(([l, v]) => `- ${l}: ${v}`).join("\n")}`,
  };
}

/** A boxed line with a red rule on the left, for the one thing not to miss. */
export function callout(content: string): Block {
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;"><tr>
<td width="4" bgcolor="${RED}" style="background:${RED};font-size:0;line-height:0;">&nbsp;</td>
<td style="padding:14px 16px;background:${PAGE};font-family:${SANS};font-size:14px;line-height:1.55;color:${MUTED};">${md(content)}</td>
</tr></table>`,
    text: plain(content),
  };
}

export function layout(input: {
  subject: string;
  /** The grey line inbox lists show after the subject. */
  preheader: string;
  eyebrow: string;
  heading: string;
  blocks: Block[];
  /** Why this person got the email. */
  reason: string;
  links: EmailLinks;
}): Email {
  const { links } = input;
  const footerLinks = [
    `<a href="${esc(links.app)}" style="color:${MUTED};text-decoration:underline;">Dashboard</a>`,
    `<a href="${DOCS_URL}" style="color:${MUTED};text-decoration:underline;">Docs</a>`,
    ...(links.support
      ? [`<a href="mailto:${esc(links.support)}" style="color:${MUTED};text-decoration:underline;">${esc(links.support)}</a>`]
      : []),
  ].join(" &nbsp;&middot;&nbsp; ");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(input.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Space+Grotesk:wght@500;600;700&amp;display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};font-size:1px;line-height:1px;">${esc(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${INK};">
<tr><td bgcolor="${INK}" style="background:${INK};padding:18px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:10px;"><img src="${LOGO_URL}" width="28" height="28" alt="" style="display:block;border:0;"></td>
<td style="font-family:${DISPLAY};font-size:17px;font-weight:700;letter-spacing:-0.3px;color:#FFFFFF;">GoPayLocal</td>
</tr></table>
</td></tr>
<tr><td style="padding:40px 32px 8px;">
<p style="margin:0 0 12px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${RED};">${esc(input.eyebrow)}</p>
<h1 style="margin:0 0 20px;font-family:${DISPLAY};font-size:28px;font-weight:700;line-height:1.15;letter-spacing:-0.6px;color:${INK};">${esc(input.heading)}</h1>
${input.blocks.map((b) => b.html).join("\n")}
</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid ${RULE};">
<p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.55;color:${FAINT};">${md(input.reason)}</p>
<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.55;color:${FAINT};">${footerLinks}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${SANS};font-size:11px;line-height:1.5;color:${FAINT};">GoPayLocal &middot; open-source PPP pricing &middot; <a href="${REPO_URL}" style="color:${FAINT};text-decoration:underline;">source on GitHub</a></p>
</td></tr></table>
</body></html>`;

  const text = [
    input.heading,
    "=".repeat(Math.min(input.heading.length, 60)),
    "",
    input.blocks.map((b) => b.text).join("\n\n"),
    "",
    "--",
    plain(input.reason),
    `Dashboard: ${links.app}`,
    `Docs: ${DOCS_URL}`,
    ...(links.support ? [`Help: ${links.support}`] : []),
  ].join("\n");

  return { subject: input.subject, html, text };
}
