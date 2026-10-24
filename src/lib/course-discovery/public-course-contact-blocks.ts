import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Page } from "@playwright/test";
import { fullCourseName } from "./teeitup-official-identity";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";

export type PublicCourseContactBlock = { venueName: string; street: string; locality: string; region: string; postalCode: string; country: string; phone: string };
type Node = DefaultTreeAdapterMap["node"];
type RawElement = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is RawElement => "tagName" in node;
const attr = (node: RawElement, key: string) => node.attrs.find(value => value.name === key)?.value ?? "";
const hasClass = (node: RawElement, name: string) => attr(node, "class").split(/\s+/u).includes(name);
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
/** Only an observed CPS physical-business p-tel scalar may carry this exact
 * printed label. Durable canonical phone normalization stays number-only. */
export function normalizePublicCourseContactPhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 47) return;
  return normalizePublicCoursePhone(value.startsWith("Phone: ") ? value.slice(7) : value);
}
const restricted = /\b(?:mailing|corporate|billing|headquarters|account|member|profile|customer|checkout|payment|fax)\b/iu;
function excluded(node: RawElement) {
  return ["script","style","template","noscript","iframe","form","input","textarea","select","button"].includes(node.tagName) ||
    node.attrs.some(value => ["hidden","inert"].includes(value.name) || value.name === "aria-hidden" && value.value === "true") ||
    /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node,"style")) ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/iu.test(attr(node,"class")) ||
    restricted.test(["id","class","title","aria-label"].map(key=>attr(node,key)).join(" ")) ||
    node.childNodes.some(child=>element(child)&&/^h[1-6]$/u.test(child.tagName)&&/\b(?:mailing|corporate|billing|headquarters)\b/iu.test(text(child)));
}
function text(node: Node): string {
  if(node.nodeName==="#text")return (node as DefaultTreeAdapterMap["textNode"]).value;
  if(element(node)&&excluded(node))return "";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
/** Only exact named public organization h-cards. Unrelated course/staff contact
 * blocks are not read as the canonical course's telephone discriminator. */
export function parsePublicCourseContactBlocks(html: string, venueName: string): PublicCourseContactBlock[] {
  if(Buffer.byteLength(html,"utf8")>600_000)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
  const cards: RawElement[]=[], expected=fullCourseName(venueName);let count=0;
  const visit=(node:Node,depth=0)=>{if(depth>64||++count>20_000)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");if(element(node)){if(excluded(node))return;if(hasClass(node,"h-card"))cards.push(node);}if("childNodes"in node)node.childNodes.forEach(child=>visit(child,depth+1));};
  visit(parse(html));if(cards.length>40)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
  const output:PublicCourseContactBlock[]=[];
  for(const card of cards){
    const entries:RawElement[]=[];
    const walk=(node:Node)=>{if(element(node)){if(excluded(node)||node!==card&&hasClass(node,"h-card"))return;entries.push(node);}if("childNodes"in node)node.childNodes.forEach(walk);};walk(card);
    const fields=(names:string[])=>entries.filter(node=>names.some(name=>hasClass(node,name)));
    const names=fields(["p-name"]);if(names.length!==1||fullCourseName(text(names[0]))!==expected)continue;
    const read=(classes:string[])=>{const matches=fields(classes);if(matches.length!==1)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");return clean(text(matches[0]));};
    const address=fields(["h-adr","p-adr"]);
    if(address.length!==1||restricted.test(text(address[0])))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
    for(const field of fields(["p-street-address","p-locality","locality","p-region","p-postal-code","p-country-name"])){
      let parent:Node|undefined=field;while(parent&&parent!==address[0])parent="parentNode"in parent?parent.parentNode??undefined:undefined;
      if(parent!==address[0])throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
    }
    const number=read(["p-tel"]), phones=fields(["p-tel"])[0];
    const anchors=entries.filter(node=>node.tagName==="a"&&attr(node,"href").startsWith("tel:"));
    // A semantic p-tel may be plain printed text. If it links, its exact
    // dial target must be that same printed scalar, not another contact.
    for(const anchor of anchors){let parent:Node|undefined=anchor;let inPhone=false;while(parent&&parent!==card){if(parent===phones)inPhone=true;parent="parentNode"in parent?parent.parentNode??undefined:undefined;}if(inPhone&&clean(attr(anchor,"href").slice(4)).replace(/\D/gu,"").replace(/^1(?=\d{10}$)/u,"")!==number.replace(/\D/gu,"").replace(/^1(?=\d{10}$)/u,""))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");}
    const countries=fields(["p-country-name"]);
    if(countries.length>1)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
    output.push({venueName:clean(text(names[0])),street:read(["p-street-address"]),locality:read(["p-locality","locality"]),region:read(["p-region"]),postalCode:read(["p-postal-code"]),country:countries.length?clean(text(countries[0])):"US",phone:number});
  }
  return output;
}
export function hasInertPublicBookingLink(html:string,pageUrl:string,bookingUrl:string){
  let found=false,count=0;
  const visit=(node:Node,depth=0)=>{if(depth>64||++count>20_000)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");if(element(node)){if(excluded(node))return;if(node.tagName==="a"&&/\b(?:tee\s*times?|book(?:\s+a)?\s+tee\s*time|reservations?)\b/iu.test(text(node))){try{if(new URL(attr(node,"href"),pageUrl).href===bookingUrl)found=true;}catch{/* No authority from malformed markup. */}}}if("childNodes"in node)node.childNodes.forEach(child=>visit(child,depth+1));};
  visit(parse(html));return found;
}

/** Fixed bounded current DOM capture, with computed visibility of each scalar
 * and its ancestors. No arbitrary selectors, forms or account records. */
export async function readVisiblePublicCourseContactBlocks(page: Page, venueName: string): Promise<PublicCourseContactBlock[]> {
  return page.evaluate(expectedName=>{
    // Object methods keep this callback self-contained under tsx keepNames.
    // Assigned helper arrows gain module-only __name calls in that runtime.
    const helpers={
      normalize(value:string){return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\bgolf (?:club|course)$/u,"golf course");},
      clean(value:string){return value.replace(/\s+/gu," ").trim();},
      visible(node:Element){if(!(node instanceof HTMLElement)||node.closest('form,script,template,noscript,iframe,[hidden],[inert],[aria-hidden="true"]'))return false;let current:Element|null=node,depth=0;const rect=node.getBoundingClientRect();if(!rect.width||!rect.height)return false;while(current&&depth++<64){const style=getComputedStyle(current);if(style.display==="none"||style.visibility==="hidden"||style.opacity==="0")return false;if(/\b(?:mailing|corporate|billing|headquarters|account|member|profile|customer|fax)\b/iu.test([current.id,current.className,current.getAttribute("aria-label")??"",current.getAttribute("title")??""].join(" "))||Array.from(current.children).some(child=>/^H[1-6]$/u.test(child.tagName)&&/\b(?:mailing|corporate|billing|headquarters)\b/iu.test(child.textContent??"")))return false;current=current.parentElement;}return current===null;},
    };
    const cards=Array.from(document.querySelectorAll(".h-card"));if(cards.length>40)throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
    const output:PublicCourseContactBlock[]=[];
    for(const card of cards){
      if(!helpers.visible(card))continue;
      const getters={
        fields(selector:string){return Array.from(card.querySelectorAll(selector)).filter(node=>node.closest(".h-card")===card);},
        read(selector:string){const nodes=getters.fields(selector);if(nodes.length!==1||!helpers.visible(nodes[0]))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");return helpers.clean((nodes[0]as HTMLElement).innerText);},
      };
      const names=getters.fields(".p-name");if(names.length!==1||helpers.normalize(names[0].textContent??"")!==helpers.normalize(expectedName))continue;
      const addresses=getters.fields(".h-adr,.p-adr");if(addresses.length!==1||!helpers.visible(addresses[0]))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
      if(getters.fields(".p-street-address,.p-locality,.locality,.p-region,.p-postal-code,.p-country-name").some(node=>!addresses[0].contains(node)))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
      const countries=getters.fields(".p-country-name");if(countries.length>1||countries.length===1&&!helpers.visible(countries[0]))throw new Error("CPS_POSTAL_CONFLICT_UNVERIFIED");
      output.push({venueName:getters.read(".p-name"),street:getters.read(".p-street-address"),locality:getters.read(".p-locality,.locality"),region:getters.read(".p-region"),postalCode:getters.read(".p-postal-code"),country:countries.length?getters.read(".p-country-name"):"US",phone:getters.read(".p-tel")});
    }
    return output;
  },venueName);
}
