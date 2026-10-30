import test from 'node:test';import assert from 'node:assert/strict';
import{stageNativeHistoryNavigation,nativeHistoryNavigations}from'./source-provenance.mjs';
function fixture(){const root='https://public-course.example/',stamp=new Date().toISOString();return{report:{startedAt:stamp,visitedUrls:[root],officialLinkLedger:[{kind:'NATIVE_VISIBLE_DOM',pageUrl:root,observedAt:stamp,links:[]}],nativeHistoryNavigations:[]},value:{kind:'NATIVE_DOCUMENT_HISTORY_ROUTE',documentUrl:root+'-home?',finalUrl:root,finalStatus:200,observedAt:stamp,completedAt:stamp,documentHash:'a'.repeat(64)}};}
test('native served document rewritten before the first visible read is retained with full provenance',()=>{
 const{report,value}=fixture(),before=structuredClone(report),staged=stageNativeHistoryNavigation(report,value);
 assert.deepEqual(report,before);assert.deepEqual(staged.visitedUrls,[value.finalUrl,value.documentUrl]);
 assert.deepEqual(nativeHistoryNavigations(staged),[value]);assert.equal(staged.officialLinkLedger.at(-1).documentHash,value.documentHash);
});
for(const [label,change]of Object.entries({foreign:{documentUrl:'https://foreign.example/-home'},status:{finalStatus:503},hash:{documentHash:'bad'},old:{observedAt:'2020-01-01T00:00:00.000Z'},future:{completedAt:'2040-01-01T00:00:00.000Z'},extra:{loaderId:'unowned'},same:{documentUrl:'https://public-course.example/'},unobserved:{finalUrl:'https://public-course.example/elsewhere'}}))test('staging refuses '+label+' history without mutating prior provenance',()=>{
 const{report,value}=fixture(),before=structuredClone(report);assert.throws(()=>stageNativeHistoryNavigation(report,{...value,...change}),/STAGEHAND_SOURCE_OUTPUT_INVALID/);assert.deepEqual(report,before);
});
test('staging requires the visible native document, unique history and bounded ledgers',()=>{
 for(const mutate of[r=>r.officialLinkLedger=[],r=>r.visitedUrls=[],r=>r.nativeHistoryNavigations=Array(4).fill({}),r=>r.officialLinkLedger=Array(512).fill(r.officialLinkLedger[0])]){const{report,value}=fixture();mutate(report);const before=structuredClone(report);assert.throws(()=>stageNativeHistoryNavigation(report,value));assert.deepEqual(report,before);}
 const{report,value}=fixture(),staged=stageNativeHistoryNavigation(report,value);assert.throws(()=>stageNativeHistoryNavigation(staged,value));
});
