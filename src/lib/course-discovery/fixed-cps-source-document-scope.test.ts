import{it,expect}from'vitest';
import{createCourseDiscoveryBrowserSession}from'./browser-session';
const input=()=>({deadlineAt:new Date(Date.now()+10000),initialUrls:['https://official.example/']});
it('rejects a CPS document-only capability outside the native fixed transport before launching',async()=>{
 await expect(createCourseDiscoveryBrowserSession(input(),{fixedCpsSourceDocumentUrl:'https://public-course.cps.golf/'})).rejects.toThrow('FIXED_CPS_SOURCE_DOCUMENT_SCOPE_INVALID');
});
it.each(['https://official.example/','https://admin.cps.golf/','https://public-course.cps.golf/?slot=1','https://public-course.cps.golf/#selected','https://public-course.cps.golf/checkout',
 'https://public-course.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23&slot=7',
 'https://public-course.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=24'])('rejects an unscoped document-only source %s before launching',async fixedCpsSourceDocumentUrl=>{
 await expect(createCourseDiscoveryBrowserSession(input(),{browserTransport:'NATIVE_CHROME',fixedCpsSourceDocumentUrl})).rejects.toThrow('FIXED_CPS_SOURCE_DOCUMENT_SCOPE_INVALID');
});
