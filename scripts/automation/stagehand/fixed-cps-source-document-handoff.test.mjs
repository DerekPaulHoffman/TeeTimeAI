import test from 'node:test';import assert from 'node:assert/strict';
import{createDiscoveryBrowser}from'../course-discovery-worker.mjs';
const base={cwd:'C:/fixture',deadlineAt:new Date(Date.now()+60000).toISOString(),initialUrls:['https://official.example/']};
test('only fixed inspection can request an exact public CPS document snapshot',()=>{
 for(const value of['https://public-course.cps.golf/','https://public-course.cps.golf/onlineresweb/search-teetime']){
  let spawned;createDiscoveryBrowser({...base,fixedInspection:true,fixedCpsSourceDocumentUrl:value,processFactory:o=>{spawned=o;return{};}});
  const n=spawned.args.indexOf('--fixed-cps-source-document');assert.ok(n>=0);assert.equal(spawned.args[n+1],value);
  assert.equal(spawned.environment.COURSE_DISCOVERY_FIXED_INSPECTION,'1');
  assert.equal(spawned.args[spawned.args.indexOf('--initial-urls')+1],JSON.stringify(base.initialUrls));
 }
 assert.throws(()=>createDiscoveryBrowser({...base,fixedCpsSourceDocumentUrl:'https://public-course.cps.golf/'}),/FIXED_CPS_SOURCE_DOCUMENT_SCOPE_INVALID/);
 for(const value of['https://official.example/','https://admin.cps.golf/','https://public-course.cps.golf/?slot=1','https://public-course.cps.golf/#calendar','https://public-course.cps.golf/checkout'])
  assert.throws(()=>createDiscoveryBrowser({...base,fixedInspection:true,fixedCpsSourceDocumentUrl:value}),/FIXED_CPS_SOURCE_DOCUMENT_SCOPE_INVALID/);
});
test('ordinary source/model browsers receive no document-only capability',()=>{
 let spawned;createDiscoveryBrowser({...base,processFactory:o=>{spawned=o;return{};}});
 assert.ok(!spawned.args.includes('--fixed-cps-source-document'));assert.equal(spawned.environment.COURSE_DISCOVERY_FIXED_INSPECTION,undefined);
});
