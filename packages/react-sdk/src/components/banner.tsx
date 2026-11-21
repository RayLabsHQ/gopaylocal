import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePPP } from '../hooks/use-ppp';
// Bundled into this package at build time.
import { cssColor, fillTemplate, templateValues } from '../../../js-sdk/src/core';

const BRANDING_URL = 'https://gopaylocal.com/?utm_source=banner&utm_medium=referral';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPBannerProps {
  /** Banner background color. Falls back to API-configured value. */
  backgroundColor?: string;
  /** Banner text color. Falls back to API-configured value. */
  fontColor?: string;
  /** Border radius in CSS units, for the bottom-left/bottom-right card. Defaults to '10px'. */
  borderRadius?: string;
  /** Font size in CSS units. Defaults to '14px'. */
  fontSize?: string;
  /** Additional CSS class name. */
  className?: string;
  /** Callback when the user dismisses the banner. */
  onClose?: () => void;
  /** Banner position. Falls back to API-configured value, then 'bottom-right'. */
  position?: 'top' | 'bottom' | 'bottom-left' | 'bottom-right';
  /** Whether to show the close icon. Falls back to the campaign's design, then true. */
  showCloseIcon?: boolean;
  /** If true, no default styles are applied. Defaults to false. */
  noStyles?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Auto-rendered PPP discount banner.
 *
 * Renders a customizable notification showing the visitor's available PPP
 * discount with a copy-to-clipboard CTA for the coupon code.
 *
 * Renders nothing if no discount is available (discount === 0).
 * Uses the campaign's banner design from the API; props override it. Reports
 * `impression`, `copy` and `dismiss` events to GoPayLocal analytics, and shows
 * a "Powered by GoPayLocal" link when the API asks for it (Free plan).
 *
 * @example
 * ```tsx
 * <GoPayLocalProvider apiKey="gpl_pk_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef">
 *   <PPPBanner position="bottom-right" />
 *   <App />
 * </GoPayLocalProvider>
 * ```
 */
export const PPPBanner = memo(function PPPBanner({
  backgroundColor,
  fontColor,
  borderRadius,
  fontSize = '14px',
  className,
  onClose,
  position: positionProp,
  showCloseIcon: showCloseIconProp,
  noStyles = false,
}: PPPBannerProps) {
  const ppp = usePPP();
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const visible = ppp.discount > 0 && !dismissed && ppp.data !== null;
  const { track } = ppp;

  // One impression per campaign shown (the assigned arm during an experiment).
  const reportedCampaign = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !ppp.campaignId || reportedCampaign.current === ppp.campaignId) return;
    reportedCampaign.current = ppp.campaignId;
    track('impression');
  }, [visible, ppp.campaignId, track]);

  const handleClose = useCallback(() => {
    setDismissed(true);
    track('dismiss');
    onClose?.();
  }, [onClose, track]);

  const handleCopy = useCallback(async () => {
    if (!ppp.code) return;
    track('copy');
    try {
      await navigator.clipboard.writeText(ppp.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      try {
        const textarea = document.createElement('textarea');
        textarea.value = ppp.code;
        textarea.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Copy failed silently
      }
    }
  }, [ppp.code, track]);

  // Don't render if no discount or dismissed
  if (!visible || !ppp.data) return null;

  const banner = ppp.data.banner;
  const position = positionProp ?? (banner.position as PPPBannerProps['position']) ?? 'bottom-right';
  const isBar = position === 'top' || position === 'bottom';
  const bgColor = cssColor(backgroundColor ?? banner.backgroundColor ?? '#1a1a2e');
  const textColor = cssColor(fontColor ?? banner.textColor ?? '#ffffff');
  const ctaColor = cssColor(banner.ctaColor ?? '#e94560');
  const ctaTextColor = cssColor(banner.ctaTextColor ?? '#ffffff');
  const ctaText = banner.ctaText ?? 'Copy Code';
  const showBranding = ppp.data.showBranding === true;
  const showCloseIcon = showCloseIconProp ?? banner.showCloseBtn ?? true;

  // The same placeholders and values as the script-tag banner and
  // showBanner(): the product's own price from the API, in the visitor's
  // currency when converted (whatever baseCurrencyCode is set to).
  const message = fillTemplate(banner.messageTemplate, templateValues(ppp.data));

  // ── Styled rendering ────────────────────────────────────────────────────

  if (noStyles) {
    return (
      <div
        className={className}
        role="complementary"
        aria-label="Purchasing power parity discount"
        data-gopaylocal-banner
      >
        {banner.showFlag && ppp.flag && (
          <span data-gopaylocal-flag>{ppp.flag}</span>
        )}
        <span data-gopaylocal-message>{message}</span>
        {ppp.code && (
          <button type="button" onClick={handleCopy} data-gopaylocal-cta>
            {copied ? 'Copied!' : ctaText}
          </button>
        )}
        {showBranding && (
          <a href={BRANDING_URL} target="_blank" rel="noopener" data-gopaylocal-branding>
            Powered by GoPayLocal
          </a>
        )}
        {showCloseIcon && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Dismiss"
            data-gopaylocal-close
          >
            &times;
          </button>
        )}
      </div>
    );
  }

  // ── Default styled rendering ────────────────────────────────────────────

  const baseStyles: CSSProperties = {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize,
    lineHeight: '1.4',
    color: textColor,
    background: bgColor,
    boxSizing: 'border-box',
    zIndex: 2147483647,
    position: 'fixed',
  };

  const containerStyles: CSSProperties = isBar
    ? {
        ...baseStyles,
        [position === 'top' ? 'top' : 'bottom']: 0,
        left: 0,
        right: 0,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        boxShadow:
          position === 'top'
            ? '0 2px 6px rgba(0,0,0,0.12)'
            : '0 -2px 6px rgba(0,0,0,0.12)',
      }
    : {
        ...baseStyles,
        bottom: '16px',
        [position === 'bottom-left' ? 'left' : 'right']: '16px',
        width: '320px',
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: borderRadius ?? '10px',
        padding: '14px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
      };

  const flagStyles: CSSProperties = {
    fontSize: isBar ? '22px' : '24px',
    lineHeight: '1',
  };

  const ctaButtonStyles: CSSProperties = isBar
    ? {
        background: ctaColor,
        color: ctaTextColor,
        border: 'none',
        fontWeight: 600,
        cursor: 'pointer',
        borderRadius: '6px',
        padding: '6px 16px',
        fontSize: '13px',
        whiteSpace: 'nowrap',
      }
    : {
        background: ctaColor,
        color: ctaTextColor,
        border: 'none',
        fontWeight: 600,
        cursor: 'pointer',
        borderRadius: '6px',
        padding: '8px 0',
        fontSize: '14px',
        width: '100%',
        display: 'block',
        textAlign: 'center',
        marginTop: '10px',
      };

  const brandingStyles: CSSProperties = {
    color: 'inherit',
    textDecoration: 'none',
    opacity: 0.55,
    fontWeight: 500,
    fontSize: '11px',
    ...(isBar
      ? { whiteSpace: 'nowrap' }
      : { display: 'block', marginTop: '8px', textAlign: 'center' }),
  };

  const brandingLink = showBranding ? (
    <a href={BRANDING_URL} target="_blank" rel="noopener" style={brandingStyles} data-gopaylocal-branding>
      Powered by GoPayLocal
    </a>
  ) : null;

  const closeButtonStyles: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: textColor,
    cursor: 'pointer',
    opacity: 0.7,
    lineHeight: '1',
    fontSize: isBar ? '20px' : '18px',
    padding: isBar ? '4px 6px' : '2px 6px',
    ...(isBar
      ? {}
      : { position: 'absolute' as const, top: '8px', right: '8px' }),
  };

  if (isBar) {
    return (
      <div
        style={containerStyles}
        className={className}
        role="complementary"
        aria-label="Purchasing power parity discount"
        data-gopaylocal-banner
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {banner.showFlag && ppp.flag && (
            <span style={flagStyles}>{ppp.flag}</span>
          )}
          <span>{message}</span>
          {ppp.code && (
            <button
              type="button"
              style={ctaButtonStyles}
              onClick={handleCopy}
            >
              {copied ? 'Copied!' : ctaText}
            </button>
          )}
          {brandingLink}
        </div>
        {showCloseIcon && (
          <button
            type="button"
            style={closeButtonStyles}
            onClick={handleClose}
            aria-label="Dismiss"
          >
            &times;
          </button>
        )}
      </div>
    );
  }

  // Floating card (bottom-left or bottom-right)
  return (
    <div
      style={containerStyles}
      className={className}
      role="complementary"
      aria-label="Purchasing power parity discount"
      data-gopaylocal-banner
    >
      {showCloseIcon && (
        <button
          type="button"
          style={closeButtonStyles}
          onClick={handleClose}
          aria-label="Dismiss"
        >
          &times;
        </button>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '6px',
        }}
      >
        {banner.showFlag && ppp.flag && (
          <span style={flagStyles}>{ppp.flag}</span>
        )}
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            opacity: 0.8,
          }}
        >
          {ppp.data.countryName}
        </span>
      </div>
      <div style={{ marginBottom: '10px' }}>{message}</div>
      {ppp.code && (
        <button
          type="button"
          style={ctaButtonStyles}
          onClick={handleCopy}
        >
          {copied ? 'Copied!' : ctaText}
        </button>
      )}
      {brandingLink}
    </div>
  );
});
