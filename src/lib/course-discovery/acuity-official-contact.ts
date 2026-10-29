import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu," ").trim();
const name = (value: string) => clean(value).toLocaleLowerCase("en-US");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const url = z.string().url().max(2048).refine(value => { const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&!u.hash&&!u.search; });
export const acuityOfficialContactProofSchema = z.object({ kind:z.literal("OFFICIAL_BASE_ADDRESS_PHONE_V1"),
  requiredCapability:z.literal("LOCAL_CHROME"),warmTransport:z.literal("NATIVE_CHROME"),
  officialUrl:url, documentUrl:url, bookingUrl:url, entryUrl:url, venueName:z.string().min(3).max(200),
  venueAddress:z.string().min(10).max(300), timeZone:z.string().min(3).max(80), providerName:z.string().min(3).max(150),
  addressRepresentation:z.literal("CANONICAL_UNIT_OMITTED"), canonicalPhoneSha256:digest, witnessSha256:digest,
}).strict().refine(value=>value.witnessSha256===sha({ ...value,witnessSha256:undefined }));
export type AcuityOfficialContactProof=z.infer<typeof acuityOfficialContactProofSchema>;
type Node=DefaultTreeAdapterMap["node"];type Element=DefaultTreeAdapterMap["element"];
const element=(n:Node):n is Element=>"tagName" in n;
const attr=(n:Element,key:string)=>n.attrs.find(a=>a.name===key)?.value;
function hidden(n:Element){ for(let p:Node|undefined=n;p;p="parentNode"in p?p.parentNode??undefined:undefined)if(element(p)&&(
  ["script","style","noscript","template","form"].includes(p.tagName)||p.attrs.some(a=>["hidden","inert"].includes(a.name))||attr(p,"aria-hidden")==="true"||
  /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr(p,"style")??"")||/(?:^|\s)(?:hidden|d-none|invisible|sr-only)(?:\s|$)/u.test(attr(p,"class")??"")))return true;return false; }
function text(n:Node):string {if(element(n)&&hidden(n))return "";if(n.nodeName==="#text")return (n as DefaultTreeAdapterMap["textNode"]).value;
  if(element(n)&&n.tagName==="br")return ", ";return "childNodes"in n?n.childNodes.map(text).join(" "):"";}
function nodes(n:Node):Element[]{const out:Element[]=[];function visit(p:Node){if(element(p)){if(hidden(p))return;out.push(p);if(out.length>20000)throw Error("ACUITY_OFFICIAL_CONTACT_UNVERIFIED");}if("childNodes"in p)p.childNodes.forEach(visit);}visit(n);return out;}
function printedAddress(value:string){
  const parts=clean(value).split(/\s*,\s*/u).filter(Boolean);
  if(parts.at(-1)?.toLowerCase()==="map & directions")parts.pop();
  if(parts.length===4&&!/^\d/u.test(parts[0])&&parts[0].length<=60&&!/\b(?:mailing|billing|corporate|headquarters)\b/iu.test(parts[0]))parts.shift();
  return parts.length===3?teeItUpCompleteStreetAddress(parts.join(", ")):undefined;
}
function phoneValues(value:string){return [...value.matchAll(/(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}/gu)].map(m=>normalizePublicCoursePhone(m[0])).filter(Boolean);}
/** The short name is earned by a closed canonical terminal category and a
 * complete independently corroborated physical contact, never a tenant slug. */
export function deriveAcuityOfficialContact(source:OfficialIdentitySource,page:OfficialIdentityPage,providerName:string,canonicalPhone:string){
  const root=source.officialUrl&&freshNativeCanonicalRootDocument(page,source.officialUrl), visible=page.visibleEvidence;
  const short=source.venueName.replace(/ Indoor Golf & Bar$/u,"");
  const canonical=teeItUpCompleteStreetAddress(source.venueAddress??""), phone=normalizePublicCoursePhone(canonicalPhone);
  const fail=():never=>{throw Error("ACUITY_OFFICIAL_CONTACT_UNVERIFIED");};
  if(!root||!visible||short===source.venueName||short.length<5||name(short)!==name(providerName)||!canonical||!canonical.unit||!phone||
    visible.phoneTextsOmitted!==false||visible.delegatedFrameSources?.omitted!==false||!visible.headings.some(h=>name(h)===name(short)))return fail();
  const all=nodes(parse(page.html));const base={...canonical,unit:"",unitType:""};
  const primary=all.filter(n=>n.tagName==="h1");
  if(!primary.length||primary.some(n=>name(text(n))!==name(short)))return fail();
  const rawAddresses=all.map(n=>printedAddress(text(n))).filter(Boolean);
  const shownAddresses=visible.addressTexts.map(printedAddress);
  if(!rawAddresses.length||rawAddresses.some(a=>JSON.stringify(a)!==JSON.stringify(base))||!shownAddresses.length||shownAddresses.some(a=>!a||JSON.stringify(a)!==JSON.stringify(base)))return fail();
  const phones=[...new Set((visible.phoneTexts??[]).map(normalizePublicCoursePhone))];
  if(phones.length!==1||phones[0]!==phone)return fail();
  const cards=all.filter(n=>["ul","address","section","div"].includes(n.tagName)&&clean(text(n)).length<=700&&
    phoneValues(text(n)).includes(phone)&&("childNodes"in n)&&nodes(n).some(c=>JSON.stringify(printedAddress(text(c)))===JSON.stringify(base)));
  const compact=cards.filter(n=>!cards.some(other=>other!==n&&nodes(n).includes(other)));
  if(compact.length!==1||cards.some(n=>new Set(phoneValues(text(n))).size!==1)||new Set(phoneValues(text(parse(page.html)))).size!==1)return fail();
  const booking=new URL(source.bookingUrl);const entry=new URL("/",booking);
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.as\.me$/u.test(booking.hostname)||!/^\/schedule\/[a-zA-Z0-9]{4,40}$/u.test(booking.pathname)||booking.search||booking.hash)return fail();
  const frames=visible.delegatedFrameSources.rows.filter(row=>row.visible&& !row.srcdoc&&!row.inForm&&row.src===entry.href);
  const rawFrames=all.filter(n=>n.tagName==="iframe"&&attr(n,"src")===entry.href&&attr(n,"srcdoc")===undefined);
  if(frames.length!==1||rawFrames.length!==1||all.filter(n=>n.tagName==="iframe"&&/\.as\.me(?:\/|$)/u.test(attr(n,"src")??"")).length!==1)return fail();
  const value={kind:"OFFICIAL_BASE_ADDRESS_PHONE_V1" as const,requiredCapability:"LOCAL_CHROME" as const,warmTransport:"NATIVE_CHROME" as const,
    officialUrl:source.officialUrl!,documentUrl:root.documentUrl,bookingUrl:source.bookingUrl,
    entryUrl:entry.href,venueName:source.venueName,venueAddress:source.venueAddress!,timeZone:source.timeZone,providerName,
    addressRepresentation:"CANONICAL_UNIT_OMITTED" as const,canonicalPhoneSha256:sha(phone)};
  return acuityOfficialContactProofSchema.parse({...value,witnessSha256:sha(value)});
}
