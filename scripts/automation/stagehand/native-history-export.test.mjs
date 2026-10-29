import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDiscover } from './source-discovery.mjs';
import { validateStagehandSourceReport, createStagehandSourceCheckpoint, readStagehandSourceCheckpoint } from '../course-discovery-stagehand-source.mjs';
import { observedInspectionPath } from '../course-discovery-stagehand-inspection.mjs';

test('completed private history routing survives a checkpoint and retains the independent inspection path',async()=>{
 const official='https://official.example/',gateway="https://app.whoosh.io/patron/club/golfer's-lounge",agenda=gateway+'/agenda/simulators/2030-10-23';
 const first=Date.now(),job={id:'history-job',attempts:1,sourceFingerprint:'a'.repeat(64),firstPickedUpAt:new Date(first).toISOString(),deadlineAt:new Date(first+900000).toISOString(),request:{
  identity:{name:"Golfer's Lounge",officialUrl:official,address:'10 Public Road, Hartford, CT 06103, USA',timeZone:'America/New_York'},
  target:{courseId:'course',offeringId:'offering',kind:'SIMULATOR'},input:{date:'2030-10-23',players:2,timeZone:'America/New_York',startTime:'10:00',endTime:'20:00',durationMinutes:60}}};
 let current=official,evaluations=0,callback;
 const session={localCodexCalls:[],browser:{context:{addInitScript:async()=>{}}},page:{url:async()=>current,evaluate:async()=>++evaluations%2?{url:current,observedAt:new Date().toISOString(),links:current===official?[{href:gateway,text:'Reserve a Bay',visible:true}]:[],frames:[],dom:[]}:[]},
  goto:async()=>({status:()=>200}),extract:async(_instruction,schema)=>({data:schema.parse({decision:'SOURCE_FOUND',reason:'Current observed public source',bookingUrl:current===official?gateway:agenda,nextActionInstruction:''})}),
  observe:async()=>({data:[{method:'click',selector:'a',arguments:[]}]}),act:async()=>{
   callback({kind:'NATIVE_VISIBLE_DOM',pageUrl:official,observedAt:new Date().toISOString(),documentHash:'b'.repeat(64),links:[{href:gateway,visible:true}]});
   current=gateway;return{before:{tag:'A',href:gateway,text:'Reserve a Bay',label:''},afterUrl:gateway,openedNewPage:true};},
  observeHistorySource:async()=>current===agenda?{kind:'NATIVE_DOCUMENT_HISTORY_ROUTE',documentUrl:gateway,finalUrl:agenda,finalStatus:200,observedAt:new Date().toISOString(),completedAt:new Date().toISOString(),documentHash:'c'.repeat(64)}:null,
  observeFrameSources:async()=>{if(current===gateway)current=agenda;return{kind:'NATIVE_VISIBLE_FRAME',pageUrl:current,observedAt:new Date().toISOString(),documentHash:'d'.repeat(64),frames:[]};},
  close:async()=>({browserClosed:true,modelClosed:true})};
 // The public DOM capture, rather than the model, sees the history route.
 const evaluate=session.page.evaluate;session.page.evaluate=async()=>{if(current===gateway)current=agenda;return evaluate();};
 let clock=Date.now();
 const report=await sourceDiscover({job,sourceEvidenceWait:{now:()=>clock,sleep:async ms=>{clock+=ms;}},sessionFactory:async options=>{callback=options.onNativeSourceWitness;return session;}});
 assert.equal(report.outcome,'SOURCE_PROPOSED_UNVERIFIED');assert.equal(report.adapterSourceProposal.bookingUrl,agenda);
 assert.equal(report.nativeHistoryNavigations.length,1);validateStagehandSourceReport(report,job);
 const checkpoint=createStagehandSourceCheckpoint(job,report),resumed=readStagehandSourceCheckpoint({...job,attempts:2,checkpoint:{stagehandSource:checkpoint}},undefined,Date.now());
 assert.deepEqual(resumed.report.nativeHistoryNavigations,report.nativeHistoryNavigations);
 assert.deepEqual(observedInspectionPath(resumed.report,official,agenda),[official,gateway,agenda]);
 const forged=structuredClone(resumed.report);forged.nativeHistoryNavigations[0].documentUrl='https://foreign.example/';
 assert.throws(()=>validateStagehandSourceReport(forged,job),/STAGEHAND_SOURCE_GRAPH_LIMIT/u);
});
