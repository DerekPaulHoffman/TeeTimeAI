import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicEvidenceUrl } from './public-evidence.mjs';
import { discoveryTurnErrorCategories } from '../course-discovery-diagnostics.mjs';

export const SOURCE_DIAGNOSTIC_MAX_BYTES = 4096;
export const sourceGuardReasons=['TARGET_MISSING','HIDDEN','CREDENTIAL_CONTROL','PRIVATE_FIELD','TRANSACTION_TEXT','SLOT_TIME','REPEATED_UNCHANGED_NAVIGATION'];
export const sourceGuardTerms=['CHECKOUT','PAYMENT','PAY_NOW','PURCHASE','RESERVE','HOLD','SIGN_IN','LOG_IN','LOGIN','CREATE_ACCOUNT','REGISTER','VERIFICATION','CAPTCHA','SEND_EMAIL','CONTACT_US'];
export const sourceGuardFields=['TEXT','LABEL','HREF','FORM_ACTION','COMBINED'];
export const sourceFrameWitnessFailures=['SHAPE','KIND','PAGE_BINDING','PAGE_URL','PAGE_NOT_VISITED','TIMESTAMP','STALE','DEADLINE','DOCUMENT_HASH','FRAME_ARRAY','DUPLICATE_FRAME','FRAME_SHAPE','FRAME_HIDDEN','FRAME_URL','FRAME_SELF','SELECTION'];
export const sourceStopDecisions=['CONTINUE','WAIT','SOURCE_FOUND','UNRESOLVED','OPEN_FRAME'];
export const sourceStopConditions=['RUNNING','SOURCE_FOUND','EXPLICIT_UNRESOLVED','WAIT_LIMIT','EMPTY_CONTINUE','ACTION_UNAVAILABLE_LIMIT','ACTION_REJECTED_LIMIT','ERROR','STEP_LIMIT','CLEANUP_UNCONFIRMED'];
export const sourceActionKinds=['INITIAL_NAVIGATION','click','fill','type','selectOptionFromDropdown','press','scrollTo','nextChunk','prevChunk','hover','openObservedFrameSource'];
const sourceStopSchema=z.object({finalDecision:z.enum(sourceStopDecisions).nullable(),condition:z.enum(sourceStopConditions),lastActionKind:z.enum(sourceActionKinds).nullable()}).strict();
const sourceDocumentSchema=z.object({readyState:z.enum(['loading','interactive','complete','UNKNOWN']),bodyPresent:z.boolean(),mainDocumentCurrent:z.boolean(),mainDocumentComplete:z.boolean(),
  mainReadPending:z.boolean(),pendingReads:z.number().int().min(0).max(2048),mainDocumentStatus:z.number().int().min(100).max(599).nullable()}).strict();
export function projectSourceDocumentReadiness(value){const result=sourceDocumentSchema.safeParse(value);return result.success?result.data:undefined;}
export const intermediaryPreparationStages=['BEGIN','FIRST_CAPTURE','SECOND_CAPTURE','ORIGIN','SELECT','GRANT'];
export const intermediaryPreparationReasons=['ENTRY_LIMIT','PENDING_ENTRY','DOCUMENT_UNSETTLED','NATIVE_DOCUMENT_CHANGED','DOM_CHANGED','OFFICIAL_ORIGIN_UNVERIFIED','NO_UNIQUE_GATEWAY','ALREADY_ENTERED','URL_REJECTED','CLOCK_INVALID','READY','THREW'];
const nullableFact=z.boolean().nullable(),nullableRows=z.number().int().min(0).max(160).nullable();
const intermediaryPreparationSchema=z.object({attempt:z.number().int().min(1).max(1000000),stage:z.enum(intermediaryPreparationStages),reason:z.enum(intermediaryPreparationReasons).nullable(),
 firstRows:nullableRows,secondRows:nullableRows,firstOverflow:nullableFact,secondOverflow:nullableFact,firstSettled:nullableFact,secondSettled:nullableFact,
 firstCandidatePresent:nullableFact,secondCandidatePresent:nullableFact,samePage:nullableFact,sameNativeDocument:nullableFact,sameDocumentHash:nullableFact,
 sameReadinessState:nullableFact,sameRoutingInventory:nullableFact}).strict();
export function projectNativeIntermediaryPreparation(value){const result=intermediaryPreparationSchema.safeParse(value);return result.success?result.data:undefined;}
const sourceGuardTags=['A','BUTTON','INPUT','SELECT','FORM','SPAN','IMG','OTHER'];
const guardProjection=z.object({guardReason:z.enum(sourceGuardReasons),guardTerm:z.enum(sourceGuardTerms).optional(),guardField:z.enum(sourceGuardFields).optional(),
  guardTag:z.enum(sourceGuardTags).optional(),guardHasHref:z.boolean().optional()}).strict();
export function projectActionGuardDiagnostic(value){const result=guardProjection.safeParse(value);return result.success?result.data:undefined;}
export const navigationFailureCodes=['ERR_ABORTED','ERR_FAILED','ERR_BLOCKED_BY_CLIENT','ERR_CONNECTION_CLOSED','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED',
  'ERR_NAME_NOT_RESOLVED','ERR_TIMED_OUT','ERR_CERT_AUTHORITY_INVALID','ERR_CERT_COMMON_NAME_INVALID','ERR_CERT_DATE_INVALID','ERR_SSL_PROTOCOL_ERROR',
  'ERR_TUNNEL_CONNECTION_FAILED','ERR_PROXY_CONNECTION_FAILED','ERR_TOO_MANY_REDIRECTS','ERR_EMPTY_RESPONSE','ERR_HTTP_RESPONSE_CODE_FAILURE',
  'ERR_ADDRESS_UNREACHABLE','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','TIMEOUT','TARGET_CLOSED','SESSION_CLOSED','CDP_CONNECTION_CLOSED',
  'INVALID_PARAMETERS','METHOD_NOT_SUPPORTED','INVALID_URL','PROTOCOL_ERROR','RPC_ERROR','UNKNOWN'];
const navigationErrorNames=['Error','TypeError','RangeError','SyntaxError','TimeoutError','AbortError','ZodError','CDPError','CDPConnectionClosedError','RPCResponseTimeoutError','UNKNOWN'];
const navigationProjection=z.object({navigationCode:z.enum(navigationFailureCodes),navigationErrorName:z.enum(navigationErrorNames)}).strict();
/** Read only fixed browser/protocol markers. No message, URL, stack, or port is retained. */
export function classifyNavigationError(error){
  let code;
  const messages=[error?.message,error?.cause?.message].filter(value=>typeof value==='string').map(value=>value.slice(0,4000));
  for(const message of messages){const found=/\bnet::(ERR_[A-Z0-9_]+)\b/u.exec(message)?.[1];if(found&&navigationFailureCodes.includes(found)){code=found;break;}}
  const rpcCode=error?.cause?.code??error?.diagnostics?.rpcCode;
  if(!code){
    if(error?.name==='TimeoutError'||error?.name==='RPCResponseTimeoutError'||messages.some(value=>/\b(?:timed out|Timeout)\b/iu.test(value)))code='TIMEOUT';
    else if(rpcCode===-32602||messages.some(value=>/\bInvalid parameters\b/iu.test(value)))code='INVALID_PARAMETERS';
    else if(rpcCode===-32601)code='METHOD_NOT_SUPPORTED';
    else if(messages.some(value=>/\b(?:Target|page) (?:has been )?closed\b/iu.test(value)))code='TARGET_CLOSED';
    else if(messages.some(value=>/\bSession (?:has been )?closed\b/iu.test(value)))code='SESSION_CLOSED';
    else if(error?.name==='CDPConnectionClosedError'||messages.some(value=>/\bCDP (?:connection|client) (?:is )?closed\b/iu.test(value)))code='CDP_CONNECTION_CLOSED';
    else if(messages.some(value=>/\b(?:invalid URL|Cannot navigate to invalid URL)\b/iu.test(value)))code='INVALID_URL';
    else if(messages.some(value=>/\bProtocol error\b/iu.test(value)))code='PROTOCOL_ERROR';
    else if(Number.isInteger(rpcCode))code='RPC_ERROR';
  }
  return{navigationCode:code??'UNKNOWN',navigationErrorName:navigationErrorNames.includes(error?.name)?error.name:'UNKNOWN'};
}
export const sourcePhases = ['GUARDED_HOST','SDK_CONNECT','MODEL_CLIENT','SDK_INITIALIZE','SDK_TARGETS','INITIAL_SCRIPT','OPEN','EVIDENCE','EXTRACT','OBSERVE','ACT','SETTLE','CLOSE','FINISHED','UNKNOWN'];
const startupStages = ['SDK_CONNECT','MODEL_CLIENT','SDK_INITIALIZE','SDK_TARGETS'];
const transportPhases = ['catalog','spawn','initialize','account/read','thread/start','turn/start','turn/completed','generate','model','event','channel','stdin','close','UNKNOWN'];
export const sourceTransportCodes = [
  'STAGEHAND_NATIVE_HOST_DEADLINE','STAGEHAND_NATIVE_HOST_SCOPE_INVALID','STAGEHAND_NATIVE_HOST_INVALID','STAGEHAND_NATIVE_HOST_FAILED',
  'STAGEHAND_GUARDED_SOURCE_REJECTED','OWNED_STAGEHAND_CDP_UNAVAILABLE','OWNED_PUBLIC_CDP_UNAVAILABLE','PROVIDER_COORDINATION_UNAVAILABLE',
  'STAGEHAND_GUARDED_BROWSER_REQUIRED','STAGEHAND_UNGUARDED_CONTEXT','STAGEHAND_GUARDED_TARGET_MISSING','STAGEHAND_VERSION_CHANGED',
  'STAGEHAND_CODEX_MESSAGES_REQUIRED','STAGEHAND_CODEX_MESSAGE_ROLE_UNSUPPORTED','STAGEHAND_CODEX_CONTENT_BLOCK_UNSUPPORTED','STAGEHAND_CODEX_STRUCTURED_SCHEMA_REQUIRED',
  'LOCAL_MODEL_MESSAGES_INVALID','LOCAL_MODEL_INLINE_IMAGE_INVALID','LOCAL_MODEL_CONTENT_PART_UNSUPPORTED','LOCAL_MODEL_ROLE_UNSUPPORTED',
  'LOCAL_MODEL_INPUT_LIMIT','LOCAL_MODEL_OUTPUT_LIMIT','LOCAL_MODEL_CHANNEL_OUTPUT_LIMIT','LOCAL_MODEL_CHANNEL_PROTOCOL_INVALID',
  'LOCAL_MODEL_RPC_FAILED','LOCAL_MODEL_EVENT_FAILED','LOCAL_MODEL_PROCESS_FAILED','LOCAL_MODEL_PROCESS_CLOSED','LOCAL_MODEL_INPUT_FAILED',
  'LOCAL_MODEL_ORIGINAL_DEADLINE','LOCAL_MODEL_CLIENT_CLOSED','LOCAL_MODEL_CHANNEL_TIMEOUT','LOCAL_MODEL_CONFIGURATION_INVALID',
  'LOCAL_MODEL_CALL_CANCELLED','LOCAL_MODEL_TOOL_REQUEST','LOCAL_MODEL_FORBIDDEN_ITEM','LOCAL_MODEL_TURN_FAILED','LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED',
  'LOCAL_MODEL_SCHEMA_INVALID','LOCAL_MODEL_SANDBOX_NOT_ACKNOWLEDGED','LOCAL_MODEL_MODEL_NOT_ACKNOWLEDGED','LOCAL_MODEL_OUTPUT_JSON_INVALID',
  'SOURCE_DISCOVERY_ABORTED','WORK_DEADLINE_EXPIRED','STAGEHAND_SOURCE_BUDGET_EXHAUSTED','ADAPTER_SOURCE_NOT_OBSERVED',
  'FRAMEWORK_SOURCE_CANDIDATES_INVALID','FRAMEWORK_SOURCE_CANDIDATES_LIMIT','SOURCE_EVIDENCE_LIMIT','SOL_ONLY_MODEL_RESULT_REQUIRED',
  'METHOD_NOT_PERMITTED','ARGUMENTS_NOT_PERMITTED','ACTION_TARGET_REJECTED','SDK_ACTION_FAILED','SDK_ACTION_POSTCONDITION_FAILED',
  'PUBLIC_NAVIGATION_REJECTED','STAGEHAND_SOURCE_ACTION_UNAVAILABLE','STAGEHAND_SOURCE_ACTION_REJECTED','STAGEHAND_SOURCE_LOADING_INCOMPLETE',
  'STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED',
  'STAGEHAND_SOURCE_UNRESOLVED',
  'PUBLIC_READ_RESPONSE_PROFILE_INVALID',
];
const count = z.number().int().min(0).max(1000000);
const usage = z.object({ totalTokens:count.optional(),inputTokens:count.optional(),cachedInputTokens:count.optional(),outputTokens:count.optional(),reasoningOutputTokens:count.optional() }).strict();
const modelTurnFailureSchema=z.object({turnStatus:z.enum(['failed','interrupted','inProgress']),errorCategory:z.enum(discoveryTurnErrorCategories).optional(),
  httpStatusCode:z.number().int().min(100).max(599).optional()}).strict();
const modelErrorNotificationSchema=modelTurnFailureSchema.omit({turnStatus:true}).extend({willRetry:z.boolean().optional(),
  rpcCode:z.number().int().min(-2147483648).max(2147483647).optional()}).strict();
const modelFailureFields={modelRpcCode:z.number().int().min(-2147483648).max(2147483647).optional(),
  modelTurnFailure:modelTurnFailureSchema.optional(),modelErrorNotification:modelErrorNotificationSchema.optional()};
const modelFailureSchema=z.object({attempt:count.min(1),completedCalls:count,transportCode:z.enum(sourceTransportCodes).optional(),
  transportPhase:z.enum(transportPhases).optional(),rpcCode:z.number().int().min(-2147483648).max(2147483647).optional(),
  httpStatus:z.number().int().min(100).max(599).optional(),failedCallUsage:usage.optional(),...modelFailureFields}).strict();
const ownedCdpFailureSchema=z.object({layer:z.enum(['RPC','ASYNC_LISTENER','SYNC_LISTENER','SEND','TIMEOUT','SOCKET_ERROR','SOCKET_CLOSE','OPEN_TIMEOUT','PROTOCOL','ABORT']),
 method:z.enum(['Extensions.loadUnpacked','Fetch.continueRequest','Fetch.continueResponse','Fetch.enable','Fetch.failRequest','Fetch.getResponseBody','Network.enable','Page.enable','Page.addScriptToEvaluateOnNewDocument','Page.getFrameTree','Page.stopLoading',
  'Runtime.enable','Runtime.evaluate','Runtime.runIfWaitingForDebugger','Target.closeTarget','Target.createTarget','Target.detachFromTarget','Target.getBrowserContexts','Target.getTargets','Target.setAutoAttach','Target.setDiscoverTargets','UNKNOWN']).optional(),
 event:z.enum(['Target.attachedToTarget','Target.detachedFromTarget','Target.targetDestroyed','Fetch.requestPaused','Network.loadingFailed','Network.requestWillBeSent','Page.frameNavigated','Page.frameRequestedNavigation','Page.navigatedWithinDocument','UNKNOWN']).optional(),
 rpcCode:z.number().int().min(-2147483648).max(2147483647).optional(),lifecycle:z.enum(['SESSION_NOT_FOUND','TARGET_CLOSED','CONTEXT_DESTROYED','FRAME_NOT_FOUND','UNKNOWN']).optional(),
 socketErrorName:z.enum(['Error','TypeError','RangeError','SyntaxError','AbortError','DOMException','NetworkError','WebSocketError','MessageSizeExceededError','UNKNOWN']).optional(),
 socketFailureCategory:z.enum(['DECOMPRESSED_MESSAGE_LIMIT','UNKNOWN']).optional(),
 socketErrorCode:z.enum(['UND_ERR_WS_MESSAGE_SIZE_EXCEEDED','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_ABORTED','UND_ERR_DESTROYED','UND_ERR_CLOSED','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED','ERR_INVALID_ARG_TYPE','ERR_OUT_OF_RANGE','WS_ERR_UNSUPPORTED_MESSAGE_LENGTH','Z_DATA_ERROR','Z_BUF_ERROR','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENOTFOUND','UNKNOWN']).optional(),
 socketCauseCode:z.enum(['UND_ERR_WS_MESSAGE_SIZE_EXCEEDED','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_ABORTED','UND_ERR_DESTROYED','UND_ERR_CLOSED','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED','ERR_INVALID_ARG_TYPE','ERR_OUT_OF_RANGE','WS_ERR_UNSUPPORTED_MESSAGE_LENGTH','Z_DATA_ERROR','Z_BUF_ERROR','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENOTFOUND','UNKNOWN']).optional(),
 socketCloseCode:z.number().int().min(1000).max(4999).optional(),socketWasClean:z.boolean().optional(),
 browserConnectedAtFailure:z.boolean().optional(),ownedPageCrashObserved:z.boolean().optional(),ownedPageCloseObserved:z.boolean().optional(),contextClosedObserved:z.boolean().optional(),
 pendingRequests:z.number().int().min(0).max(256)}).strict();
const nativeRouterCodes=['NATIVE_REDIRECT_ABORT_TIMEOUT','NATIVE_REDIRECT_BODY_TIMEOUT','NATIVE_REDIRECT_CANCELLED','NATIVE_REDIRECT_CONTINUE_REJECTED',
 'NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED','NATIVE_REDIRECT_DRAIN_FAILED','NATIVE_REDIRECT_DRAIN_TIMEOUT','NATIVE_REDIRECT_DUPLICATE_FETCH_ID',
 'NATIVE_REDIRECT_FRAME_MISSING','NATIVE_REDIRECT_FRAME_UNGUARDED','NATIVE_REDIRECT_FULFILL_REJECTED','NATIVE_REDIRECT_HANDLER_FAILED','NATIVE_REDIRECT_HEADERS_LIMIT',
 'NATIVE_REDIRECT_INSTALL_FAILED','NATIVE_REDIRECT_INTERCEPT_LIMIT','NATIVE_REDIRECT_LOADER_MISMATCH','NATIVE_REDIRECT_LOADER_TIMEOUT','NATIVE_REDIRECT_NAVIGATION_REJECTED',
 'NATIVE_REDIRECT_NETWORK_FAILED','NATIVE_REDIRECT_NETWORK_ID_MISSING','NATIVE_REDIRECT_PING_UNSUPPORTED','NATIVE_REDIRECT_POST_BODY_LIMIT','NATIVE_REDIRECT_POST_BODY_MISSING',
 'NATIVE_REDIRECT_PROVENANCE_REJECTED','NATIVE_REDIRECT_PROVENANCE_TIMEOUT','NATIVE_REDIRECT_RECORD_LIMIT','NATIVE_REDIRECT_REQUEST_REJECTED','NATIVE_REDIRECT_REQUEST_TIMEOUT',
 'NATIVE_REDIRECT_RESOURCE_KIND_REJECTED','NATIVE_REDIRECT_RESOURCE_REJECTED','NATIVE_REDIRECT_RESPONSE_DUPLICATE','NATIVE_REDIRECT_RESPONSE_FRAME_MISMATCH',
 'NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT','NATIVE_REDIRECT_RESPONSE_METHOD_MISMATCH','NATIVE_REDIRECT_RESPONSE_MISMATCH','NATIVE_REDIRECT_RESPONSE_NETWORK_MISMATCH',
 'NATIVE_REDIRECT_RESPONSE_PRIOR_FAILURE','NATIVE_REDIRECT_RESPONSE_REQUEST_PAUSED','NATIVE_REDIRECT_RESPONSE_STATUS_INVALID','NATIVE_REDIRECT_RESPONSE_TIMEOUT',
 'NATIVE_REDIRECT_RESPONSE_UNADMITTED','NATIVE_REDIRECT_RESPONSE_UNKNOWN','NATIVE_REDIRECT_RESPONSE_URL_MISMATCH','NATIVE_REDIRECT_RETIRED_DISPATCH','NATIVE_REDIRECT_ROUTING_FAILED',
 'NATIVE_RESPONSE_LIMIT','OWNED_STAGEHAND_CDP_UNAVAILABLE','STAGEHAND_GUARDED_SOURCE_REJECTED','UNKNOWN'];
const nativeRouterBooleanKeys=['framePresent','rootFrame','networkIdPresent','duplicateRequestId','hasPostData','postDataPresent','identityPresent','loaderPresent','loaderKnown','identityFresh',
 'identityUrlMatches','identityMethodMatches','identityKindMatches','identityFrameMatches','parentPresent','awaitingDocument','parentCurrentGeneration','documentCommitted',
 'documentIntentPresent','documentIntentUsed','sourceResponseComplete','successorTerminalFailed','declaredLengthPresent','documentResponse','ancillaryResponse',
 'recordGenerationCurrent','recordGenerationRetired','recordAdmitted','recordPaused','recordResponsePaused','recordFailed','recordComplete','recordHandlerDone','recordTerminalObserved'];
export const stagehandRedirectRejections=['PARENT_MISSING','PARENT_UNADMITTED','PARENT_FAILED','PARENT_DEPTH_LIMIT','PARENT_CHILD_RESERVED',
 'PARENT_RESPONSE_MISSING','PARENT_RESPONSE_FAILED','CHILD_RECORD_EXISTS','PARENT_RESPONSE_INCOMPLETE','LOCATION_MISSING','LOCATION_MISMATCH',
 'KIND_NETWORK_MISMATCH','METHOD_MISMATCH','DOCUMENT_PARENT_KIND','DOCUMENT_PARENT_METHOD','CROSS_HOST'];
export const nativeRouterOperations=['REQUEST_METADATA','RESPONSE_METADATA','LOADER_CORRELATION','REDIRECT_PROVENANCE','RESPONSE_WAIT','RESPONSE_BODY','RESPONSE_RELEASE','REQUEST_RELEASE','HANDLER'];
export const nativeRouterErrorNames=['Error','TypeError','RangeError','SyntaxError','TimeoutError','AbortError','ProtocolError','CDPError','UNKNOWN'];
export const nativeRouterErrorCategories=['INVALID_INTERCEPTION_ID','REQUEST_NOT_PAUSED','TARGET_CLOSED','SESSION_CLOSED','CONTEXT_DESTROYED','BODY_UNAVAILABLE','PROTOCOL_ERROR','UNKNOWN'];
const nativeRouterFields={code:z.enum(nativeRouterCodes),
 operation:z.enum(nativeRouterOperations).optional(),errorName:z.enum(nativeRouterErrorNames).optional(),errorCategory:z.enum(nativeRouterErrorCategories).optional(),
 requestUrlSha256:z.string().regex(/^[a-f0-9]{64}$/u).optional(),
 phase:z.enum(['RESPONSE_WAIT','CONTINUE_REQUEST_ACK','CONTINUE_RESPONSE_ACK','LOADER_IDENTITY_WAIT','LOADER_IDENTITY','LOADER_OWNER','REDIRECT_GENERATION','REDIRECT_PROVENANCE','DOCUMENT_INTENT','DOCUMENT_DRAIN','SOURCE_HOST_REQUEST']).optional(),
 sourceRequestGuard:z.enum(['STATE','TRANSACTION_URL','FRAME_OWNERSHIP','URL_POLICY','HEADER_POLICY','NAVIGATION_PROVENANCE','METHOD_POLICY','REQUEST_BUDGET','LEASE','NATIVE_RESPONSE']).optional(),
 redirectRejection:z.enum(stagehandRedirectRejections).optional(),
 method:z.enum(['GET','HEAD','POST','OPTIONS','PUT','PATCH','DELETE','CONNECT','TRACE','OTHER']).optional(),
 resourceType:z.enum(['document','stylesheet','script','image','media','font','xhr','fetch','preflight','other','ping','websocket','eventsource']).optional(),
 limitKind:z.enum(['DECLARED_INVALID','DECLARED_TOO_LARGE','DECODED_BODY','TOTAL_DECODED']).optional(),
 allowedBytes:z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),declaredBytes:z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
 bodyBytes:z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),totalBytes:z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
 ...Object.fromEntries(nativeRouterBooleanKeys.map(key=>[key,z.boolean().optional()]))};
const nativeRouterFailureSchema=z.object(nativeRouterFields).strict().refine(value=>value.redirectRejection===undefined||value.code==='NATIVE_REDIRECT_PROVENANCE_REJECTED'&&value.phase==='REDIRECT_PROVENANCE');
/** Raw current browser facts become closed diagnostics only, never read authority. */
export function projectNativeRouterFailure(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.code!=='string')return undefined;
 const value={code:nativeRouterCodes.includes(raw.code)?raw.code:'UNKNOWN'};
 for(const[key,schema]of Object.entries(nativeRouterFields)){
  if(key==='code'||!Object.hasOwn(raw,key))continue;
  const parsed=schema.safeParse(raw[key]);if(parsed.success&&parsed.data!==undefined)value[key]=parsed.data;
 }
 if(value.code!=='NATIVE_REDIRECT_PROVENANCE_REJECTED'||value.phase!=='REDIRECT_PROVENANCE')delete value.redirectRejection;
 if(value.code!=='STAGEHAND_GUARDED_SOURCE_REJECTED'||value.phase!=='SOURCE_HOST_REQUEST')delete value.sourceRequestGuard;
 const parsed=nativeRouterFailureSchema.safeParse(value);return parsed.success?parsed.data:undefined;
}
export function safeNativeRouterFailure(raw){const parsed=nativeRouterFailureSchema.safeParse(raw);return parsed.success?parsed.data:undefined;}
export const hostGuardReasons={CHECK:['ABORTED','CLOSED','TERMINAL'],GUARDED_TARGETS:['IDS_INVALID','TARGET_MISSING','TARGET_NOT_ATTESTED'],
 SOURCE_DOM:['VALUE_INVALID','JSON_INVALID','FRAME_MISSING','LOADER_MISSING','FRAME_CHANGED','LOADER_CHANGED','NATIVE_URL_CHANGED','DOM_URL_CHANGED'],
 BEFORE_ACTION:['HREF_SHAPE','LINK_INVENTORY_MISSING','HREF_NOT_OBSERVED','HREF_URL_POLICY','HREF_TRANSACTION','OBSERVED_URL_LIMIT']};
const hostGuardFailureSchema=z.object({stage:z.enum(['CHECK','GUARDED_TARGETS','SOURCE_DOM','BEFORE_ACTION']),reason:z.string(),
 nativeFrameHasFragment:z.boolean().optional(),domHasFragment:z.boolean().optional()}).strict().refine(value=>hostGuardReasons[value.stage].includes(value.reason)&&
 (value.stage==='SOURCE_DOM'||value.nativeFrameHasFragment===undefined&&value.domHasFragment===undefined));
export function projectHostGuardFailure(raw){const parsed=hostGuardFailureSchema.safeParse(raw);return parsed.success?parsed.data:undefined;}
/** Captured inside the actual model callback before the SDK can wrap its error. */
export function captureModelFailure(error,attempt,completedCalls){
 const diagnostic=error?.diagnostics??{},value={attempt,completedCalls};
 const code=[error?.code,error?.message].find(item=>sourceTransportCodes.includes(item));
 if(code)value.transportCode=code;
 if(transportPhases.includes(diagnostic.phase))value.transportPhase=diagnostic.phase;
 for(const [field,raw]of[['rpcCode',diagnostic.rpcCode],['httpStatus',diagnostic.httpStatusCode]])
  if(Number.isInteger(raw)&&(field==='rpcCode'?raw>=-2147483648&&raw<=2147483647:raw>=100&&raw<=599))value[field]=raw;
 if(value.rpcCode!==undefined)value.modelRpcCode=value.rpcCode;
 for(const [key,schema]of[['modelTurnFailure',modelTurnFailureSchema],['modelErrorNotification',modelErrorNotificationSchema]]){
  const result=schema.safeParse(diagnostic[key]);if(result.success)value[key]=result.data;
 }
 const partial=usage.safeParse(Object.fromEntries(Object.entries(diagnostic.usage??{}).filter(([key,item])=>['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].includes(key)&&Number.isSafeInteger(item)&&item>=0&&item<=1000000)));
 if(partial.success&&Object.keys(partial.data).length)value.failedCallUsage=partial.data;
 const result=modelFailureSchema.safeParse(value);return result.success?result.data:undefined;
}
export const sourceDiagnosticSchema = z.object({
  schemaVersion:z.literal(1),phase:z.enum(sourcePhases),startupStage:z.enum(startupStages).optional(),
  errorClass:z.enum(['NONE','VALIDATION','TIMEOUT','ABORT','STATIC_TRANSPORT','SDK_ERROR','UNKNOWN']),
  transportCode:z.enum(sourceTransportCodes).optional(),transportPhase:z.enum(transportPhases).optional(),
  guardReason:z.enum(sourceGuardReasons).optional(),
  guardTerm:z.enum(sourceGuardTerms).optional(),guardField:z.enum(sourceGuardFields).optional(),guardTag:z.enum(sourceGuardTags).optional(),guardHasHref:z.boolean().optional(),
  navigationCode:z.enum(navigationFailureCodes).optional(),navigationErrorName:z.enum(navigationErrorNames).optional(),
  ownedCdpFailure:ownedCdpFailureSchema.optional(),
  nativeRouterFailure:nativeRouterFailureSchema.optional(),
  hostGuardFailure:hostGuardFailureSchema.optional(),
  frameWitnessFailure:z.enum(sourceFrameWitnessFailures).optional(),
  sourceStop:sourceStopSchema.optional(),
  sourceDocumentReadiness:sourceDocumentSchema.optional(),
  nativeIntermediaryPreparation:intermediaryPreparationSchema.optional(),
  rpcCode:z.number().int().min(-2147483648).max(2147483647).optional(),httpStatus:z.number().int().min(100).max(599).optional(),
  ...modelFailureFields,sdkRpcCode:z.number().int().min(-2147483648).max(2147483647).optional(),
  elapsedMs:z.number().int().min(0).max(900000),
  counts:z.object({completedSteps:count,actionAttempts:count,executedActions:count,rejectedActions:count,eligibleCandidates:count,
    completedModelCalls:count,attemptedModelCalls:count,failedModelCalls:count}).strict(),
  completedUsageIsLowerBound:z.literal(true),failedCallUsage:usage.optional(),
  cleanup:z.object({browserClosed:z.boolean(),modelClosed:z.boolean()}).strict(),
  graph:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/u),pages:count,links:count,visibleLinks:count,frames:count,actions:count}).strict(),
}).strict();
export function projectSourceDiagnostic(value) {
  const parsed=sourceDiagnosticSchema.safeParse(value);
  if(!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data),'utf8')>SOURCE_DIAGNOSTIC_MAX_BYTES)return undefined;
  return parsed.data;
}
const boundedCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:0;
export function sourceFailureDiagnostic({error,phase,report,startedAt,cleanup,modelAttempts,modelFailure,ownedCdpFailure,nativeRouterFailure,hostGuardFailure,sourceStop,documentReadiness,intermediaryPreparation}={}) {
  const rows=(value,max)=>Array.isArray(value)?value.slice(0,max):[];
  const safe=value=>publicEvidenceUrl(value);
  const ledger=rows(report?.officialLinkLedger,512).map(row=>({pageUrl:safe(row.pageUrl),links:rows(row.links,512).map(link=>({href:safe(link.href),visible:link.visible===true})).filter(link=>link.href)}));
  const frames=rows(report?.frameLedger,512).map(row=>({pageUrl:safe(row.pageUrl),frames:rows(row.frames,32).map(frame=>({src:safe(frame.src),visible:frame.visible===true})).filter(frame=>frame.src)}));
  const actions=rows(report?.actions,256).map(row=>({sourceUrl:safe(row.sourceUrl),href:safe(row.observedTarget?.href),afterUrl:safe(row.afterUrl)}));
  const graph={ledger,frames,actions};
  const diagnostics=error?.diagnostics && typeof error.diagnostics==='object'?error.diagnostics:{};
  const code=[error?.code,error?.message,report?.frameworkFailureCode].find(value=>sourceTransportCodes.includes(value));
  const startupStage=startupStages.includes(error?.stagehandFailureStage)?error.stagehandFailureStage:undefined;
  const effectivePhase=sourcePhases.includes(error?.stagehandPhase)?error.stagehandPhase:sourcePhases.includes(phase)?phase:'UNKNOWN';
  const completed=boundedCount(report?.metrics?.localCodexCalls?.length),attempted=Math.max(completed,boundedCount(modelAttempts));
  const parsedModel=modelFailureSchema.safeParse(modelFailure);
  // A last failure is usable only for this failed operation's latest invocation.
  // Successful or later calls clear it; neither a stale attempt nor cached usage counts.
  const currentModel=error&&parsedModel.success&&parsedModel.data.attempt===attempted&&parsedModel.data.completedCalls===completed&&attempted>completed?
    parsedModel.data:undefined;
  const errorClass=!error&&!report?.frameworkFailureCode?'NONE':error?.name==='ZodError'?'VALIDATION':error?.name==='TimeoutError'?'TIMEOUT':
    error?.name==='AbortError'||['SOURCE_DISCOVERY_ABORTED','LOCAL_MODEL_CALL_CANCELLED','LOCAL_MODEL_ORIGINAL_DEADLINE'].includes(code)?'ABORT':
    code?'STATIC_TRANSPORT':startupStage||['OPEN','EVIDENCE','INITIAL_SCRIPT','EXTRACT','OBSERVE','ACT','SETTLE'].includes(effectivePhase)?'SDK_ERROR':'UNKNOWN';
  const value={schemaVersion:1,phase:effectivePhase,...(startupStage?{startupStage}:{}),errorClass,...(code?{transportCode:code}:{}),
    elapsedMs:Math.max(0,Math.min(900000,Math.trunc(Date.now()-(Number.isFinite(startedAt)?startedAt:Date.now())))),
    counts:{completedSteps:boundedCount(report?.metrics?.completedSteps),actionAttempts:boundedCount(report?.actionAttempts?.length),
      executedActions:boundedCount(report?.actions?.length),rejectedActions:boundedCount(report?.actionAttempts?.filter(row=>row.status==='REJECTED').length),
      eligibleCandidates:boundedCount(report?.eligibleBookingSourceUrls?.length),completedModelCalls:completed,attemptedModelCalls:attempted,failedModelCalls:Math.max(0,attempted-completed)},
    completedUsageIsLowerBound:true,cleanup:{browserClosed:cleanup?.browserClosed===true,modelClosed:cleanup?.modelClosed===true},
    graph:{sha256:createHash('sha256').update(JSON.stringify(graph)).digest('hex'),pages:ledger.length,links:ledger.reduce((n,row)=>n+row.links.length,0),
      visibleLinks:ledger.reduce((n,row)=>n+row.links.filter(link=>link.visible).length,0),frames:frames.reduce((n,row)=>n+row.frames.length,0),actions:actions.length}};
  const guardReason=error?.stagehandGuardReason??report?.actionAttempts?.at(-1)?.guardReason;
  const attempt=report?.actionAttempts?.at(-1);
  const guard=projectActionGuardDiagnostic(error?.stagehandActionDiagnostic)??projectActionGuardDiagnostic({guardReason,
    ...Object.fromEntries(['guardTerm','guardField','guardTag','guardHasHref'].filter(key=>attempt?.[key]!==undefined).map(key=>[key,attempt[key]]))});
  if(guard)Object.assign(value,guard);
  if(sourceFrameWitnessFailures.includes(error?.stagehandFrameWitnessFailure))value.frameWitnessFailure=error.stagehandFrameWitnessFailure;
  const stop=sourceStopSchema.safeParse(sourceStop);if(stop.success)value.sourceStop=stop.data;
  const document=projectSourceDocumentReadiness(error?.stagehandDocumentReadiness??documentReadiness);if(document)value.sourceDocumentReadiness=document;
  const intermediary=projectNativeIntermediaryPreparation(intermediaryPreparation);if(intermediary)value.nativeIntermediaryPreparation=intermediary;
  if(effectivePhase==='OPEN'){
    const annotated=navigationProjection.safeParse(error?.stagehandNavigation);
    Object.assign(value,annotated.success?annotated.data:classifyNavigationError(error));
  }
  if(sourceGuardReasons.includes(guardReason))value.guardReason=guardReason;
  const transportPhase=diagnostics.phase;
  if(transportPhases.includes(transportPhase))value.transportPhase=transportPhase;
  for(const [field,raw]of[['rpcCode',diagnostics.rpcCode??error?.cause?.code],['httpStatus',diagnostics.httpStatusCode??error?.httpStatusCode]])
    if(Number.isInteger(raw)&&(field==='rpcCode'?raw>=-2147483648&&raw<=2147483647:raw>=100&&raw<=599))value[field]=raw;
  const failed=usage.safeParse(Object.fromEntries(Object.entries(diagnostics.usage??{}).filter(([key,item])=>['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].includes(key)&&Number.isSafeInteger(item)&&item>=0&&item<=1000000)));
  if(failed.success&&Object.keys(failed.data).length)value.failedCallUsage=failed.data;
  if(currentModel)for(const key of['transportCode','transportPhase','rpcCode','httpStatus','failedCallUsage',...Object.keys(modelFailureFields)])
    if(value[key]===undefined&&currentModel[key]!==undefined)value[key]=currentModel[key];
  // A local transport error can itself have an inner cause. Only the SDK's
  // wrapper (not that original transport error) supplies a wrapper RPC fact.
  if(currentModel&&!code&&Number.isInteger(error?.cause?.code)&&error.cause.code>=-2147483648&&error.cause.code<=2147483647)value.sdkRpcCode=error.cause.code;
  if(value.transportCode&&value.errorClass==='SDK_ERROR')value.errorClass='STATIC_TRANSPORT';
  const cdp=ownedCdpFailureSchema.safeParse(ownedCdpFailure);
  if(cdp.success)value.ownedCdpFailure=cdp.data;
  const native=nativeRouterFailureSchema.safeParse(nativeRouterFailure);
  if(native.success)value.nativeRouterFailure=native.data;
  const host=projectHostGuardFailure(hostGuardFailure);if(host)value.hostGuardFailure=host;
  return projectSourceDiagnostic(value);
}
