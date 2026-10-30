/** Routing only. This public club entry redirects inside the provider app;
 * it is not an executable facility/date source or availability evidence. */
export function isWhooshClubGateway(value) {
  try {
    const url = new URL(value);
    const match = /^\/patron\/club\/([^/]+)\/?$/u.exec(url.pathname);
    const club = match && decodeURIComponent(match[1]);
    return url.href === value && url.protocol === 'https:' && url.hostname === 'app.whoosh.io' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      typeof club === 'string' && /^[a-z0-9](?:[a-z0-9_'\-]{0,126}[a-z0-9])?$/u.test(club);
  } catch { return false; }
}
/** The older tenant entry is public navigation only. Its actual current
 * calendar must be observed; a sibling vendor URL is never synthesized. */
export function isEzLinksLegacyGateway(value) {
  try {
    if(typeof value!=='string'||value.length>2048)return false;
    const url=new URL(value),tenant=/^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ezlinks\.com$/u.exec(url.hostname)?.[1];
    return Boolean(tenant&&!/^(?:www|api|admin|auth|login|account|portal|private|member|config|dev|qa|staging|sandbox|test)/u.test(tenant)&&
      url.href===value&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&url.pathname==='/');
  }catch{return false;}
}
export const isPublicSourceGateway=value=>isWhooshClubGateway(value)||isEzLinksLegacyGateway(value);
export function isEzLinksPublicSearchDocument(value){
  try{const url=new URL(value),tenant=/^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ezlinksgolf\.com$/u.exec(url.hostname)?.[1];
    return Boolean(typeof value==='string'&&value.length<=2048&&tenant&&!/^(?:www|api|admin|auth|login|account|portal|private|member|config|dev|qa|staging|sandbox|test)/u.test(tenant)&&url.href===value&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&url.pathname==='/search');
  }catch{return false;}
}
