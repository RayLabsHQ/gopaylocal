/**
 * Draws the banner. Used by the script tag (./index.ts, into document.body)
 * and by the dashboard's banner editor preview (into a preview frame), so the
 * preview is the real banner, not an imitation.
 *
 * Hand-minified like ./index.ts: every byte here ships in the script-tag
 * bundle. Dynamic values are HTML-escaped via h() before innerHTML; colors
 * pass through cssColor() and reach the shadow root as a constructed
 * stylesheet (adoptStyles), so a strict CSP style-src does not block them.
 *
 * The host is position:fixed. Inside an ancestor with a transform (the
 * editor's preview frame) fixed positioning is relative to that ancestor,
 * which is how the preview shows each position without covering the page.
 */
import { adoptStyles, cssColor, fillTemplate, flagOf, templateValues, type TrackableEvent } from "../../js-sdk/src/core";

/** A campaign's banner design, as the API sends it. */
export interface BannerDesign{position:"top"|"bottom"|"bottom-left"|"bottom-right";messageTemplate:string;ctaText:string;backgroundColor:string;textColor:string;ctaColor:string;ctaTextColor:string;showFlag:boolean;showCloseBtn:boolean}
/**
 * A config response from GET /v1/banner/config/:key. The price fields are the
 * product's own price, computed by the API; the banner only formats them.
 */
export interface BannerData{show:boolean;country:string;countryName:string;discount:number;code:string|null;banner:BannerDesign;currencyCode?:string;currencySymbol?:string;localPrice?:number;localOriginalPrice?:number;campaignId?:string;experimentId?:string;variant?:"a"|"b";showBranding?:boolean}

/**
 * Placeholders the message template supports. Not referenced by the script
 * tag, so the bundler leaves it out of that bundle.
 */
export { PLACEHOLDERS } from "../../js-sdk/src/core";

/**
 * Render `z` into `parent` and return the host element. `on` hears
 * "impression" once (nothing is sent for it: the API counted the impression
 * when it served the offer), "copy" (with the code) and "dismiss"; after a dismiss the
 * host removes itself (`on` must not throw). `still` skips the slide-in
 * animation.
 */
export function render(z:BannerData,parent:HTMLElement,on:(t:TrackableEvent,code?:string)=>void,still?:boolean):HTMLElement{
var d=document,
h=function(s:string){var v=d.createElement("div");v.textContent=s;return v.innerHTML},
n=function(t:string,c?:string){var v=d.createElement(t);if(c)v.className=c;return v},
b=z.banner,bar=b.position==="top"||b.position==="bottom",tp=b.position==="top",lf=b.position==="bottom-left",
tc=cssColor(b.textColor),sd=lf?"left":"right",fg=flagOf(z.country),
sf=tp?"Y(-100%)":b.position==="bottom"?"Y(100%)":lf?"X(-100%)":"X(100%)";
// The discount and the code are bold, as they always were in this banner.
var mg=fillTemplate(h(b.messageTemplate),templateValues(z),function(v:string,k:string){v=h(v);return k=="discount"||k=="code"?"<strong>"+v+"</strong>":v}),
ho=n("div") as HTMLElement;ho.style.cssText="all:initial;position:fixed;z-index:2147483647;pointer-events:none";
// Font settings go on .B, not :host: the host's inline all:initial beats :host rules.
var sh=ho.attachShadow({mode:"closed"}),
fx="display:flex;align-items:center;",
cs="@keyframes I{from{transform:translate"+sf+";opacity:0}to{transform:translate(0,0);opacity:1}}:host{all:initial;display:block}.B{font-family:system-ui,sans-serif;font-size:14px;line-height:1.4;background:"+cssColor(b.backgroundColor)+";color:"+tc+(still?"":";animation:I .3s ease-out forwards")+"}.M strong{font-weight:700}.A{background:"+cssColor(b.ctaColor)+";color:"+cssColor(b.ctaTextColor)+";border:0;font-weight:600;cursor:pointer;border-radius:6px}.A:hover{opacity:.85}.D{background:0 0;border:0;color:"+tc+";cursor:pointer;opacity:.7;line-height:1}.D:hover{opacity:1}.F{line-height:1}.P{color:inherit;text-decoration:none;opacity:.55;font-weight:500}.P:hover{opacity:.85;text-decoration:underline}";
if(bar)cs+=".B{position:fixed;"+(tp?"top":"bottom")+":0;left:0;right:0;padding:10px 16px;"+fx+"justify-content:center;gap:10px;flex-wrap:wrap;box-shadow:0 "+(tp?"2":"-2")+"px 6px rgba(0,0,0,.12)}.C{"+fx+"gap:10px;flex-wrap:wrap;justify-content:center}.F{font-size:22px}.A{padding:6px 16px;font-size:13px;white-space:nowrap}.D{font-size:20px;padding:4px 6px}.P{font-size:11px;white-space:nowrap}";
else cs+=".B{position:fixed;bottom:16px;"+sd+":16px;width:300px;max-width:calc(100vw - 32px);border-radius:10px;padding:14px;box-shadow:0 6px 20px rgba(0,0,0,.15)}.H{"+fx+"gap:8px;margin-bottom:6px}.F{font-size:24px}.N{font-size:13px;font-weight:600;opacity:.8}.D{font-size:18px;padding:2px 6px;position:absolute;top:8px;right:8px}.M{margin-bottom:10px}.A{padding:8px 0;font-size:14px;width:100%;display:block;text-align:center}.P{display:block;font-size:11px;margin-top:8px;text-align:center}";
adoptStyles(sh,cs);
var bn=n("div","B") as HTMLElement;bn.style.pointerEvents="auto";
function xb(){var x=n("button","D") as HTMLButtonElement;x.type="button";x.title="Close";x.textContent="\xD7";bn.appendChild(x)}
function bl(pp:HTMLElement){if(z.showBranding){var pa=n("a","P") as HTMLAnchorElement;pa.href="https://gopaylocal.com/?utm_source=banner&utm_medium=referral";pa.target="_blank";pa.rel="noopener";pa.textContent="Powered by GoPayLocal";pp.appendChild(pa)}}
if(bar){var wr=n("div","C");
if(b.showFlag&&fg){var fl=n("span","F");fl.textContent=fg;wr.appendChild(fl)}
var ms=n("span","M") as HTMLElement;ms.innerHTML=mg;wr.appendChild(ms);
if(z.code){var ca=n("button","A") as HTMLButtonElement;ca.type="button";ca.textContent=b.ctaText;wr.appendChild(ca)}
bl(wr);bn.appendChild(wr);if(b.showCloseBtn)xb()
}else{
if(b.showCloseBtn)xb();
var hd=n("div","H");
if(b.showFlag&&fg){var fl=n("span","F");fl.textContent=fg;hd.appendChild(fl)}
var cn=n("span","N");cn.textContent=z.countryName;hd.appendChild(cn);bn.appendChild(hd);
var ms=n("div","M") as HTMLElement;ms.innerHTML=mg;bn.appendChild(ms);
if(z.code){var ca=n("button","A") as HTMLButtonElement;ca.type="button";ca.textContent=b.ctaText;bn.appendChild(ca)}bl(bn)}
sh.appendChild(bn);
var cta=bn.querySelector(".A") as HTMLButtonElement|null;
if(cta&&z.code){cta.addEventListener("click",function(){try{var code=z.code!;
(async function(){var ok=!1;
try{await navigator.clipboard.writeText(code);ok=!0}catch{
try{var ta=d.createElement("textarea");ta.value=code;ta.style.cssText="position:fixed;left:-9999px;opacity:0";d.body.appendChild(ta);ta.focus();ta.select();ok=d.execCommand("copy");d.body.removeChild(ta)}catch{}}
if(ok){cta!.textContent="Copied!";setTimeout(function(){cta!.textContent=b.ctaText},2e3)}})();
on("copy",code)}catch{}})}
var cls=bn.querySelector(".D") as HTMLButtonElement|null;
if(cls){cls.addEventListener("click",function(){on("dismiss");ho.remove()})}
parent.appendChild(ho);on("impression");return ho
}
