import{describe,expect,it}from"vitest";
import{readSkeddaPublicCalendar,skeddaPublicReadGate}from"./skedda-public-reader";
const sourceUrl="https://harbor.skedda.com/booking",documentUrl=sourceUrl+"?viewdate=2030-01-03";
const read={url:"https://harbor.skedda.com/webs",sourceUrl,documentUrl,method:"GET",resourceType:"fetch",headers:{},mainFrame:true,navigation:false,body:null};
describe("fixed anonymous Skedda browser transport",()=>{
  it("lets the publisher's fresh anonymous verification header remain on its same-origin public reads",()=>{
    expect(skeddaPublicReadGate({...read,headers:{"X-Skedda-RequestVerificationToken":"synthetic-ephemeral"}})).toBe(true);
    expect(skeddaPublicReadGate({...read,url:"https://harbor.skedda.com/bookingslists?start=2030-01-03T00%3A00%3A00&end=2030-01-03T23%3A59%3A59.999"})).toBe(true);
  });
  it.each(["authorization","proxy-authorization","x-api-key","x-csrf-token","x-session-id"])("rejects a credential or unrecognized private header: %s",key=>{
    expect(skeddaPublicReadGate({...read,headers:{[key]:"synthetic-private"}})).toBe(false);
  });
  it.each(["https://harbor.skedda.com/bookings","https://harbor.skedda.com/login","https://harbor.skedda.com/bookings/confirm",
    "https://other.skedda.com/webs","https://harbor.skedda.com/webs?userId=1","https://harbor.skedda.com/bookingslists?start=2030-01-03&end=2030-01-04",
    "https://harbor.skedda.com/bookingslists?start=2030-01-03T00%3A00%3A00&end=2030-01-04T00%3A00%3A00&start=2030-01-03T00%3A00%3A00"])("denies nonpublic, foreign or ambiguous reads: %s",url=>{
    expect(skeddaPublicReadGate({...read,url})).toBe(false);
  });
  it("never grants POST, a GET body, subframes, transactions or token forwarding to assets",()=>{
    for(const changed of [{method:"POST"},{body:"{}"},{mainFrame:false},{url:"https://js.stripe.com/v3",resourceType:"document",navigation:true},
      {url:"https://cdn.skedda.com/assets/main.js",resourceType:"script",headers:{"X-Skedda-RequestVerificationToken":"synthetic-ephemeral"}}])expect(skeddaPublicReadGate({...read,...changed})).toBe(false);
    expect(skeddaPublicReadGate({...read,url:documentUrl,resourceType:"document",navigation:true})).toBe(true);
    expect(skeddaPublicReadGate({...read,url:sourceUrl,resourceType:"document",navigation:true})).toBe(false);
  });
  it("permits only the observed public payment libraries needed to render, with no payment frames or API",()=>{
    for(const url of["https://js.stripe.com/v3","https://connect-js.stripe.com/v1.0/connect.js"])expect(skeddaPublicReadGate({...read,url,resourceType:"script"})).toBe(true);
    for(const url of["https://api.stripe.com/v1/payment_intents","https://js.stripe.com/v3/payment-request.html"])expect(skeddaPublicReadGate({...read,url,resourceType:"script"})).toBe(false);
  });
  it("fails before browser launch when local Chrome capability or the original deadline is absent",async()=>{
    const source={bookingUrl:sourceUrl,venueName:"Harbor Golf",timeZone:"America/New_York"},input={date:"2030-01-03",timeZone:source.timeZone,players:2,durationMinutes:60,startTime:"09:00",endTime:"18:00"};
    await expect(readSkeddaPublicCalendar(source,input,{})).rejects.toThrow("LOCAL_CHROME_REQUIRED");
    await expect(readSkeddaPublicCalendar(source,input,{localCapabilities:["LOCAL_CHROME"],deadlineAt:new Date(0)})).rejects.toThrow("DEADLINE_EXCEEDED");
  });
});
