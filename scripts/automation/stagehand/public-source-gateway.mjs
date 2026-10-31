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
/** An official legacy club bookmark must earn its actual current CPS URL by
 * observed navigation. The club slug is never translated into a tenant. */
export function isCpsLegacyGateway(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = new URL(value), slug = /^\/([A-Za-z][A-Za-z0-9_-]{0,63})\/?$/u.exec(url.pathname)?.[1];
    return Boolean(slug && !/^(?:admin|auth|login|account|member|private|checkout|payment|reservation|slot)(?:$|[-_])/iu.test(slug) &&
      url.href === value && url.protocol === 'https:' && url.hostname === 'secure.east.prophetservices.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash);
  } catch { return false; }
}
/** Public tee-sheet bootstrap only. Facility configuration and public inventory
 * remain independently verified by the fixed inspector and saved executor. */
export function isForeupPublicBookingDocument(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = new URL(value), ids = /^\/index\.php\/booking\/(?:index\/)?([1-9]\d{0,9})(?:\/([1-9]\d{0,9}))?\/?$/u.exec(url.pathname);
    return Boolean(url.href === value && url.protocol === 'https:' && url.hostname === 'foreupsoftware.com' &&
      !url.username && !url.password && !url.port && !url.search && ['', '#/', '#/teetimes', '#teetimes'].includes(url.hash) &&
      ids && ids.slice(1).filter(Boolean).every(id => Number(id) <= 2_147_483_647) &&
      !(url.pathname.includes('/booking/index/') && ids[2]));
  } catch { return false; }
}
/** A public Acuity tenant bookmark redirects to its published calendar owner.
 * The owner path must be observed before inspection or recipe persistence. */
export function isAcuityTenantGateway(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = new URL(value), tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.as\.me$/u.exec(url.hostname)?.[1];
    return Boolean(tenant && !/^(?:www|app|api|admin|auth|login|account|member|private|checkout|payment)$/u.test(tenant) &&
      url.href === value && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.pathname === '/' && !url.search && !url.hash);
  } catch { return false; }
}
export function isAcuityPublicCalendarDocument(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 2048 && url.href === value &&
      isAcuityTenantGateway(new URL('/',url).href) && !url.search && !url.hash &&
      /^\/schedule\/[a-zA-Z0-9]{4,40}$/u.test(url.pathname);
  } catch { return false; }
}
export const isPublicSourceGateway=value=>isWhooshClubGateway(value)||isEzLinksLegacyGateway(value)||isCpsLegacyGateway(value);
export function isEzLinksPublicSearchDocument(value){
  try{const url=new URL(value),tenant=/^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ezlinksgolf\.com$/u.exec(url.hostname)?.[1];
    return Boolean(typeof value==='string'&&value.length<=2048&&tenant&&!/^(?:www|api|admin|auth|login|account|portal|private|member|config|dev|qa|staging|sandbox|test)/u.test(tenant)&&url.href===value&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&url.pathname==='/search');
  }catch{return false;}
}
export function isCpsPublicSearchDocument(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const url = new URL(value), tenant = /^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cps\.golf$/u.exec(url.hostname)?.[1];
    return Boolean(tenant && !/^(?:www|api|admin|auth|login|account|private|member|test|staging)$/u.test(tenant) &&
      url.href === value && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      ['/', '/onlineresweb/search-teetime'].includes(url.pathname));
  } catch { return false; }
}
