/**
 * GoPayLocal PPP Banner — IIFE, Shadow DOM, ~8.5 KB (about 3.8 KB gzipped).
 *
 * Script tag settings (key, data-product, data-visitor-id, data-no-storage)
 * are read in ./setup.ts (a secret key among them is refused below and
 * logged, and nothing is sent); the banner itself is drawn by ./render.ts, which
 * the dashboard's banner editor also uses for its preview. The request, the
 * visitor id and analytics events use the helpers the SDKs use
 * (packages/js-sdk/src/core.ts).
 *
 * Storage: the config response (5 min) and a dismissal are kept in
 * sessionStorage, the visitor id in localStorage ("gpl_vid"). Every access is
 * wrapped, so blocked storage only loses those, never the banner, and
 * data-no-storage turns all of it off.
 *
 * After each config response the banner dispatches a "gopaylocal:config"
 * CustomEvent on document with {show, country, discount, code, campaignId,
 * experimentId, variant}, so the page can read the experiment arm.
 */
import { SECRET_KEY_MESSAGE, buildConfigUrl, isSecretKey, readExperiment, resolveVisitorId, sendEvent, type TrackableEvent } from "../../js-sdk/src/core";
import { render, type BannerData as BR } from "./render";
import { readSetup } from "./setup";
(function(){try{
var d=document,P="gpl_",
st=readSetup(d.currentScript,d.querySelectorAll("script[src]"),location.href);
if(!st)return;
// A secret key never leaves the page: no config request, no event.
if(isSecretKey(st.key)){console.error(SECRET_KEY_MESSAGE);return}
var K=st.key,B=st.apiBase,NS=st.noStorage,SK=K+"_"+(st.productId||""),CI:string|null=null,CO:string|null=null,
// sessionStorage is read inside the try: the property itself throws when storage is blocked.
sg=function(k:string){try{return NS?null:sessionStorage.getItem(k)}catch{return null}},
ss=function(k:string,v:string){try{if(!NS)sessionStorage.setItem(k,v)}catch{}};
if(sg(P+"d_"+SK)==="1")return;
var cc=sg(P+"c_"+SK);
if(cc)try{var cp=JSON.parse(cc);if(Date.now()-cp.t<3e5){R(cp.d);return}}catch{}
var ac=new AbortController;setTimeout(function(){ac.abort()},5e3);
fetch(buildConfigUrl({apiBase:B,apiKey:K,productId:st.productId,visitorId:resolveVisitorId({visitorId:st.visitorId,persist:!NS})}),{signal:ac.signal,headers:{Accept:"application/json"}})
.then(function(r){return r.ok?r.json():null})
.then(function(v:BR|null){if(v){ss(P+"c_"+SK,JSON.stringify({d:v,t:Date.now()}));R(v)}}).catch(function(){});
// Analytics for the rendered banner: sendEvent sends clicks and copies only (the API
// counts the impression when it serves the offer). A dismissal is remembered for the session.
function ev(t:TrackableEvent,code?:string){sendEvent({apiBase:B,apiKey:K,event:t,campaignId:CI,country:CO,code:code});if(t=="dismiss")ss(P+"d_"+SK,"1")}
function R(z:BR){try{
var ex=readExperiment(z);
try{d.dispatchEvent(new CustomEvent("gopaylocal:config",{detail:{show:z.show===!0,country:z.country||null,discount:z.discount||0,code:z.code||null,campaignId:z.campaignId||null,experimentId:ex.experimentId,variant:ex.variant}}))}catch{}
if(!z.show)return;CI=z.campaignId||null;CO=z.country||null;
render(z,d.body,ev)
}catch{}}
}catch{}})();
