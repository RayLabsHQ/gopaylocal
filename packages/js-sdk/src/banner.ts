import type { PPPData, BannerOptions } from './types';
import { adoptStyles, cssColor, fillTemplate, templateValues } from './core';

const DEFAULT_BANNER_OPTIONS: Required<Omit<BannerOptions, 'onClose'>> & { onClose?: () => void } = {
  position: 'bottom',
  backgroundColor: '#1a1a2e',
  textColor: '#ffffff',
  ctaColor: '#e94560',
  ctaTextColor: '#ffffff',
  ctaText: 'Copy Code',
  messageTemplate:
    "Hey! It looks like you're visiting from {{countryName}}. We support Purchasing Power Parity! Use code {{code}} for {{discount}}% off.",
  showFlag: true,
  showCloseBtn: true,
};

/** Hooks the client uses to report banner interactions. */
export interface BannerEvents {
  copy?: () => void;
  dismiss?: () => void;
}

const BRANDING_URL = 'https://gopaylocal.com/?utm_source=banner&utm_medium=referral';

/**
 * Process the message template safely using DOM APIs.
 * Each placeholder is replaced with its escaped text value, then the result
 * is set via textContent on the message element (no raw HTML injection).
 * Bold sections are handled by splitting on ** markers and creating
 * <strong> elements programmatically.
 */
function createMessageElement(
  template: string,
  data: PPPData,
  className: string,
  tagName: string = 'span',
): HTMLElement {
  // Replace placeholders with their values (all plain text at this point).
  // The same values as the script-tag banner and <PPPBanner>: the product's
  // own price from the API, in the visitor's currency when converted.
  const rendered = fillTemplate(template, templateValues(data));

  // Parse **bold** markers and build the DOM safely
  const el = document.createElement(tagName);
  el.className = className;

  const parts = rendered.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(part));
    }
  }

  return el;
}

/** Copy text to clipboard with fallback for older browsers. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Create a PPP discount banner element using Shadow DOM.
 * Returns the host element — caller appends to DOM and manages lifecycle.
 *
 * All dynamic content is inserted via textContent or programmatic DOM APIs
 * to prevent XSS. No raw HTML is injected.
 */
export function createBanner(
  data: PPPData,
  options: BannerOptions = {},
  events: BannerEvents = {},
): HTMLElement {
  // SDK defaults < the campaign's design from the API < options passed in code.
  const opts = { ...DEFAULT_BANNER_OPTIONS, ...(data.banner ?? {}), ...definedOnly(options) };
  const isBar = opts.position === 'top' || opts.position === 'bottom';
  const isTop = opts.position === 'top';
  const isLeft = opts.position === 'bottom-left';
  const side = isLeft ? 'left' : 'right';
  const tc = cssColor(opts.textColor);
  const bg = cssColor(opts.backgroundColor);
  const ctaC = cssColor(opts.ctaColor);
  const ctaTC = cssColor(opts.ctaTextColor);

  const slideTransform = isTop
    ? 'Y(-100%)'
    : opts.position === 'bottom'
      ? 'Y(100%)'
      : isLeft
        ? 'X(-100%)'
        : 'X(100%)';

  // Host element
  const host = document.createElement('div');
  host.style.cssText =
    'all:initial;position:fixed;z-index:2147483647;pointer-events:none';

  const shadow = host.attachShadow({ mode: 'closed' });

  // Styles: only static values and colors passed through cssColor() are interpolated
  let css = `
@keyframes gpl-slide-in {
  from { transform: translate${slideTransform}; opacity: 0 }
  to { transform: translate(0,0); opacity: 1 }
}
:host {
  all: initial;
  display: block;
}
/* Fonts go here, not on :host: the host's inline all:initial beats :host rules. */
.gpl-banner {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  background: ${bg};
  color: ${tc};
  animation: gpl-slide-in 0.3s ease-out forwards;
}
.gpl-message strong { font-weight: 700 }
.gpl-cta {
  background: ${ctaC};
  color: ${ctaTC};
  border: 0;
  font-weight: 600;
  cursor: pointer;
  border-radius: 6px;
  font-family: inherit;
  font-size: inherit;
}
.gpl-cta:hover { opacity: 0.85 }
.gpl-close {
  background: transparent;
  border: 0;
  color: ${tc};
  cursor: pointer;
  opacity: 0.7;
  line-height: 1;
}
.gpl-close:hover { opacity: 1 }
.gpl-flag { line-height: 1 }
.gpl-branding { color: inherit; text-decoration: none; opacity: 0.55; font-weight: 500 }
.gpl-branding:hover { opacity: 0.85; text-decoration: underline }
`;

  if (isBar) {
    css += `
.gpl-banner {
  position: fixed;
  ${isTop ? 'top' : 'bottom'}: 0;
  left: 0; right: 0;
  padding: 10px 16px;
  display: flex; align-items: center; justify-content: center;
  gap: 10px; flex-wrap: wrap;
  box-shadow: 0 ${isTop ? '2' : '-2'}px 6px rgba(0,0,0,0.12);
}
.gpl-content {
  display: flex; align-items: center;
  gap: 10px; flex-wrap: wrap; justify-content: center;
}
.gpl-flag { font-size: 22px }
.gpl-cta { padding: 6px 16px; font-size: 13px; white-space: nowrap }
.gpl-close { font-size: 20px; padding: 4px 6px }
.gpl-branding { font-size: 11px; white-space: nowrap }
`;
  } else {
    css += `
.gpl-banner {
  position: fixed;
  bottom: 16px;
  ${side}: 16px;
  width: 300px;
  max-width: calc(100vw - 32px);
  border-radius: 10px;
  padding: 14px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.15);
}
.gpl-header {
  display: flex; align-items: center;
  gap: 8px; margin-bottom: 6px;
}
.gpl-flag { font-size: 24px }
.gpl-country-name { font-size: 13px; font-weight: 600; opacity: 0.8 }
.gpl-close {
  font-size: 18px; padding: 2px 6px;
  position: absolute; top: 8px; right: 8px;
}
.gpl-message { margin-bottom: 10px }
.gpl-cta {
  padding: 8px 0; font-size: 14px;
  width: 100%; display: block; text-align: center;
}
.gpl-branding { display: block; font-size: 11px; margin-top: 8px; text-align: center }
`;
  }

  adoptStyles(shadow, css);

  const banner = document.createElement('div');
  banner.className = 'gpl-banner';
  banner.style.pointerEvents = 'auto';

  const createClose = (): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.className = 'gpl-close';
    btn.type = 'button';
    btn.title = 'Close';
    btn.textContent = '\u00D7';
    return btn;
  };

  // Free plans show a "Powered by GoPayLocal" link; the API decides.
  const appendBranding = (parent: HTMLElement): void => {
    if (!data.showBranding) return;
    const link = document.createElement('a');
    link.className = 'gpl-branding';
    link.href = BRANDING_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Powered by GoPayLocal';
    parent.appendChild(link);
  };

  if (isBar) {
    const content = document.createElement('div');
    content.className = 'gpl-content';

    if (opts.showFlag && data.flag) {
      const flag = document.createElement('span');
      flag.className = 'gpl-flag';
      flag.textContent = data.flag;
      content.appendChild(flag);
    }

    const msg = createMessageElement(opts.messageTemplate, data, 'gpl-message');
    content.appendChild(msg);

    if (data.code) {
      const cta = document.createElement('button');
      cta.className = 'gpl-cta';
      cta.type = 'button';
      cta.textContent = opts.ctaText;
      content.appendChild(cta);
    }

    appendBranding(content);
    banner.appendChild(content);

    if (opts.showCloseBtn) {
      banner.appendChild(createClose());
    }
  } else {
    // Card layout
    if (opts.showCloseBtn) {
      banner.appendChild(createClose());
    }

    const header = document.createElement('div');
    header.className = 'gpl-header';

    if (opts.showFlag && data.flag) {
      const flag = document.createElement('span');
      flag.className = 'gpl-flag';
      flag.textContent = data.flag;
      header.appendChild(flag);
    }

    const countryName = document.createElement('span');
    countryName.className = 'gpl-country-name';
    countryName.textContent = data.countryName;
    header.appendChild(countryName);
    banner.appendChild(header);

    const msg = createMessageElement(opts.messageTemplate, data, 'gpl-message', 'div');
    banner.appendChild(msg);

    if (data.code) {
      const cta = document.createElement('button');
      cta.className = 'gpl-cta';
      cta.type = 'button';
      cta.textContent = opts.ctaText;
      banner.appendChild(cta);
    }
    appendBranding(banner);
  }

  shadow.appendChild(banner);

  // Wire up CTA (copy coupon code)
  const ctaBtn = banner.querySelector('.gpl-cta') as HTMLButtonElement | null;
  if (ctaBtn && data.code) {
    const code = data.code;
    ctaBtn.addEventListener('click', () => {
      events.copy?.();
      copyToClipboard(code).then((ok) => {
        if (ok) {
          ctaBtn.textContent = 'Copied!';
          setTimeout(() => {
            ctaBtn.textContent = opts.ctaText;
          }, 2000);
        }
      });
    });
  }

  // Wire up close button
  const closeBtn = banner.querySelector('.gpl-close') as HTMLButtonElement | null;
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      host.remove();
      events.dismiss?.();
      opts.onClose?.();
    });
  }

  return host;
}

/** Drop keys whose value is undefined, so they don't override earlier layers. */
function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
