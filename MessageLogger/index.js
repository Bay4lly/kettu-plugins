(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";
/*
 * KettuMessageLogger v2.3
 * Kettu/Revenge/Vendetta mobile-oriented reimplementation of Vencord MessageLogger behavior.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};
const RED="#f04747";
const RED_DARK="#be3535";
const RED_OVERLAY="rgba(240,71,71,0.18)";
const SENTINELS=[]; // v2.3: no invisible content sentinels; avoids cross-plugin/content-cache conflicts

const deleted=new Map();
const edits=new Map();
// Tracks recently-seen edit transitions so duplicate MESSAGE_UPDATE dispatches
// from Discord/Kettu do not create the same history line twice.
const recentEditEvents=new Map();
const rawCurrent=new Map();
const highlightOverrides=new Map();
const refreshParity=new Map(); // retained only for migration; no content mutation in v2.3
const sessionLog=[];
const unpatches=[];
const diag={
  flux:false,messageStore:false,rowManager:false,reactFallback:false,actionSheet:false,editGuard:false,
  deletes:0,bulkDeletes:0,edits:0,rowPaintAttempts:0,rowPaintMutations:0,forcedRefreshes:0,menuToggles:0,inlineEditRenders:0,
  styleRefreshes:0,overlayEnvelopeMutations:0,nativeRowMarks:0,lastError:""
};
let FluxDispatcher=null;
let MessageStore=null;
let RowManager=null;
let LazyActionSheet=null;
let ActionSheetRow=null;
let Messages=null;
let styleRevision=0;

function logError(where,e){
  const text=`${where}: ${e?.message||String(e)}`;
  diag.lastError=text;
  try{logger?.error?.(text,e);}catch{}
  try{console.warn("[KettuMessageLogger]",text,e);}catch{}
}
function logInfo(...a){try{logger?.log?.(...a);}catch{try{console.log("[KettuMessageLogger]",...a);}catch{}}}
function initDefaults(){
  if(storage.logDeletes===undefined) storage.logDeletes=true;
  if(storage.logEdits===undefined) storage.logEdits=true;
  if(storage.inlineEdits===undefined) storage.inlineEdits=true;
  if(storage.keepDeletedVisible===undefined) storage.keepDeletedVisible=true;
  if(storage.deletedStyle===undefined) storage.deletedStyle="redText";
  if(storage.maxSessionEntries===undefined) storage.maxSessionEntries=200;
  if(storage.aggressiveNativeRed===undefined) storage.aggressiveNativeRed=true;
}
function key(channelId,id){return `${channelId||"?"}:${id||"?"}`;}
function getMessageKey(msg,fallbackChannel){
  if(!msg) return null;
  const id=msg.id||msg.message_id||msg.messageId;
  const ch=msg.channel_id||msg.channelId||fallbackChannel;
  return id&&ch?key(ch,id):null;
}
function pushSession(entry){
  sessionLog.unshift({time:Date.now(),...entry});
  const max=Math.max(20,Math.min(1000,Number(storage.maxSessionEntries)||200));
  if(sessionLog.length>max) sessionLog.length=max;
}
function cloneRecord(original,extra){
  try{return Object.assign(Object.create(Object.getPrototypeOf(original)),original,extra||{});}
  catch{return Object.assign({},original,extra||{});}
}
function safeMessage(channelId,id){
  try{return MessageStore?.getMessage?.(channelId,id)||null;}catch{return null;}
}
function stripSentinel(content){return String(content??"").replace(/[\u200B\u2060]+$/g,"");}
function withFreshSentinel(k,content){return stripSentinel(content);}
function snapshotMessage(msg,rawOverride){
  return {
    id:msg?.id,
    channelId:msg?.channel_id||msg?.channelId,
    authorId:msg?.author?.id,
    authorName:msg?.author?.globalName||msg?.author?.global_name||msg?.author?.username||"unknown",
    content:rawOverride!==undefined?rawOverride:stripSentinel(msg?.content??""),
    attachments:Array.isArray(msg?.attachments)?msg.attachments.map(a=>({id:a?.id,url:a?.url||a?.proxy_url,filename:a?.filename,content_type:a?.content_type})):[]
  };
}
function rememberDelete(channelId,id,original){
  const k=key(channelId,id);
  const raw=rawCurrent.get(k)??stripSentinel(original?.content??"");
  rawCurrent.set(k,raw);
  if(!deleted.has(k)) deleted.set(k,{...snapshotMessage(original,raw),deletedAt:Date.now(),original});
  diag.deletes++;
  pushSession({kind:"delete",channelId,messageId:id,author:snapshotMessage(original,raw).authorName,content:raw});
  return k;
}
function parseEditTime(incoming){
  const v=incoming?.edited_timestamp||incoming?.editedTimestamp;
  const t=v?new Date(v).getTime():Date.now();
  return Number.isFinite(t)?t:Date.now();
}
function rememberEdit(channelId,id,previous,incoming,beforeRaw,afterRaw){
  if(!channelId||!id||beforeRaw===afterRaw) return null;
  const k=key(channelId,id);
  const list=edits.get(k)||[];
  const time=parseEditTime(incoming);

  // Discord Android can emit the same edit through more than one MESSAGE_UPDATE
  // path. Prefer the server edited timestamp when available, then fall back to a
  // short transition window. This prevents one real edit from appearing twice.
  const serverStamp=String(incoming?.edited_timestamp||incoming?.editedTimestamp||"");
  const signature=`${beforeRaw}\u0000${afterRaw}\u0000${serverStamp}`;
  const recent=recentEditEvents.get(k);
  if(recent){
    const sameServerEvent=serverStamp&&recent.serverStamp===serverStamp&&recent.before===beforeRaw&&recent.after===afterRaw;
    const sameTransition=!serverStamp&&recent.before===beforeRaw&&recent.after===afterRaw&&Math.abs(time-recent.time)<8000;
    if(sameServerEvent||sameTransition) return list;
  }
  recentEditEvents.set(k,{signature,serverStamp,before:beforeRaw,after:afterRaw,time});

  const last=list[list.length-1];
  const duplicateHistoryLine=!!last&&last.content===beforeRaw&&Math.abs((last.time||0)-time)<8000;
  if(!duplicateHistoryLine){
    list.push({time,content:beforeRaw,after:afterRaw,serverStamp});
    if(list.length>50) list.shift();
    edits.set(k,list);
    diag.edits++;
    pushSession({kind:"edit",channelId,messageId:id,author:snapshotMessage(previous,beforeRaw).authorName,before:beforeRaw,after:afterRaw});
  }
  return list;
}
function formatTime(ts){
  try{return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});}
  catch{return new Date(ts).toLocaleTimeString().slice(0,5);}
}
function toSubtext(content,time){
  const prefix=`✎ ${formatTime(time)}  `;
  const lines=String(content??"").split("\n");
  if(!lines.length||!lines.some(Boolean)) return `-# ${prefix}(boş mesaj)`;
  return lines.map((line,i)=>`-# ${i===0?prefix:"↳  "}${line||" "}`).join("\n");
}
function buildInlineEditDisplay(k,currentRaw){
  const list=edits.get(k)||[];
  if(!storage.inlineEdits||!list.length) return currentRaw;

  // Defensive render-side dedupe too. If an older build already managed to add
  // duplicate entries before this function sees them, never draw both lines.
  const clean=[];
  for(const e of list){
    const prev=clean[clean.length-1];
    if(prev&&prev.content===e.content&&Math.abs((prev.time||0)-(e.time||0))<8000) continue;
    clean.push(e);
  }
  if(clean.length!==list.length) edits.set(k,clean);

  diag.inlineEditRenders++;
  return `${clean.map(e=>toSubtext(e.content,e.time)).join("\n")}\n${currentRaw}`;
}
function deletedInfoForMessage(msg,fallbackChannel){
  const k=getMessageKey(msg,fallbackChannel);
  return k?deleted.get(k):null;
}
function isHighlightEnabledByKey(k){return highlightOverrides.get(k)!==false;}
function isHighlightEnabled(msg,fallbackChannel){
  const k=getMessageKey(msg,fallbackChannel);
  return !!k&&deleted.has(k)&&isHighlightEnabledByKey(k);
}
function processedColor(hex){
  try{return typeof RN?.processColor==="function"?RN.processColor(hex):hex;}catch{return hex;}
}
function colorLike(existing,hex){return typeof existing==="number"?processedColor(hex):hex;}
function mergeRNStyle(base,extra){
  try{const flatten=RN?.StyleSheet?.flatten;if(typeof flatten==="function") return flatten([base,extra]);}catch{}
  if(Array.isArray(base)) return [...base,extra];
  return [base,extra];
}
function applyHighlightToObject(obj,mode){
  if(!obj||typeof obj!=="object") return {value:obj,changed:false};
  let out=obj,changed=false;
  const ensure=()=>{if(out===obj) out={...obj};return out;};
  if(mode==="overlay"){
    const overlayNative=processedColor(RED_OVERLAY);
    // DCDChat rows are native. Some Discord builds consume camelCase fields,
    // some generated payloads use snake_case, and some keep an RN-style bag.
    // When we already know this object belongs to the deleted message path,
    // provide all three forms instead of waiting for an existing field.
    const o=ensure();
    if(o.backgroundColor!==overlayNative){o.backgroundColor=overlayNative;changed=true;}
    if(o.background_color!==overlayNative){o.background_color=overlayNative;changed=true;}
    o.style=mergeRNStyle(obj.style,{backgroundColor:RED_OVERLAY});changed=true;
    if("containerStyle" in obj||"children" in obj||"content" in obj||"message" in obj||"rowType" in obj){
      o.containerStyle=mergeRNStyle(obj.containerStyle,{backgroundColor:RED_OVERLAY});changed=true;
    }
    // Harmless compatibility aliases seen in various native payload layers.
    if("highlightColor" in obj) o.highlightColor=overlayNative;
    if("highlight_color" in obj) o.highlight_color=overlayNative;
  }else{
    const redNative=processedColor(RED);
    const fields=["color","textColor","text_color","foregroundColor","foreground_color","contentColor","messageColor","linkColor","link_color"];
    for(const f of fields){
      if(f in obj){const o=ensure();o[f]=colorLike(obj[f],f.toLowerCase().includes("link")?RED_DARK:RED);changed=true;}
    }
    if("style" in obj){const o=ensure();o.style=mergeRNStyle(obj.style,{color:RED});changed=true;}
    if("textStyle" in obj){const o=ensure();o.textStyle=mergeRNStyle(obj.textStyle,{color:RED});changed=true;}
    if("text_style" in obj){const o=ensure();o.text_style=mergeRNStyle(obj.text_style,{color:RED});changed=true;}
    const textish=("content" in obj||"text" in obj||"rawText" in obj||"messageContent" in obj||"body" in obj||"contentText" in obj||"messageText" in obj);
    if(textish&&storage.aggressiveNativeRed){
      const o=ensure();
      o.color=redNative;o.textColor=redNative;o.text_color=redNative;o.foregroundColor=redNative;o.contentColor=redNative;
      o.style=mergeRNStyle(obj.style,{color:RED});
      o.textStyle=mergeRNStyle(obj.textStyle,{color:RED});
      changed=true;
    }else if(!changed&&textish){
      const o=ensure();o.color=redNative;o.textColor=redNative;o.text_color=redNative;changed=true;
    }
  }
  return {value:out,changed};
}
function makeNeedles(content,authorName,messageId,mode){
  const full=stripSentinel(content);
  const arr=[full];
  // For overlay, message id is a stronger row-level locator than text.
  // It lets us style the native row envelope instead of only the text leaf.
  if(mode==="overlay"&&messageId) arr.push(String(messageId));
  for(const line of full.split("\n")){
    const cleaned=line.replace(/^-#\s*/,"").trim();
    if(cleaned.length>=2) arr.push(cleaned);
    const withoutPrefix=cleaned.replace(/^✎\s+\S+\s+/,"").replace(/^↳\s+/,"").trim();
    if(withoutPrefix.length>=2) arr.push(withoutPrefix);
  }
  return Array.from(new Set(arr.filter(x=>x&&x!==authorName)));
}
function paintGeneratedRow(root,content,mode,authorName,messageId){
  if(root==null||typeof root!=="object") return root;
  diag.rowPaintAttempts++;
  let budget=4200;
  const seen=new WeakMap();
  const needles=makeNeedles(content,authorName,messageId,mode);
  function stringMatches(v){
    if(typeof v!=="string"||v.length<1||v===authorName) return false;
    if(messageId&&v===String(messageId)) return true;
    for(const n of needles){if(v===n)return true;if(n.length>=3&&v.includes(n))return true;if(v.length>=3&&n.includes(v))return true;}
    return false;
  }
  function objectLooksLikeContent(o){
    if(!o||typeof o!=="object")return false;
    const keys=Object.keys(o).map(x=>x.toLowerCase());
    if(keys.some(k=>/content|message.?text|raw.?text|body|markup|markdown|textstyle|contentstyle/.test(k)))return true;
    for(const k of ["text","content","rawText","messageContent","body","contentText","messageText"]){
      const v=o[k]; if(typeof v==="string"&&v!==authorName&&(stringMatches(v)||storage.aggressiveNativeRed))return true;
    }
    return false;
  }
  function walk(v,depth,parentMatched){
    if(v==null||depth>15||budget--<=0)return {value:v,contains:false,changed:false};
    if(typeof v==="string")return {value:v,contains:stringMatches(v),changed:false};
    if(typeof v!=="object"||v instanceof Date)return {value:v,contains:false,changed:false};
    if(seen.has(v))return seen.get(v);
    const holder={value:v,contains:false,changed:false};seen.set(v,holder);
    if(Array.isArray(v)){
      let arr=v,contains=false,changed=false;
      for(let i=0;i<v.length;i++){const r=walk(v[i],depth+1,parentMatched);contains=contains||r.contains;if(r.value!==v[i]){if(arr===v)arr=v.slice();arr[i]=r.value;changed=true;}}
      holder.value=arr;holder.contains=contains;holder.changed=changed;return holder;
    }
    if(Object.prototype.toString.call(v)!=="[object Object]")return holder;
    const directId=[v.id,v.messageId,v.message_id,v?.message?.id,v?.message?.message_id].some(x=>messageId&&String(x)===String(messageId));
    let out=v,contains=!!directId,changed=false;
    for(const prop of Object.keys(v)){
      const val=v[prop];if(typeof val==="function")continue;
      const r=walk(val,depth+1,parentMatched||directId);contains=contains||r.contains;
      if(r.value!==val){if(out===v)out={...v};out[prop]=r.value;changed=true;}
    }
    const contentish=objectLooksLikeContent(out);
    const shouldPaint=mode==="overlay"?(directId||contains):(contentish&&(contains||parentMatched||storage.aggressiveNativeRed));
    if(shouldPaint){const p=applyHighlightToObject(out,mode);if(p.value!==out||p.changed){out=p.value;changed=true;}}
    holder.value=out;holder.contains=contains;holder.changed=changed;return holder;
  }
  const result=walk(root,0,true); // whole generated row already belongs to the deleted message
  if(result.changed){diag.rowPaintMutations++;if(mode==="overlay")diag.overlayEnvelopeMutations++;return result.value;}
  return root;
}
function markRowInput(row,info,mode){
  if(!row?.message) return row;
  const overlayNative=processedColor(RED_OVERLAY);
  const redNative=processedColor(RED);
  const m=cloneRecord(row.message,{
    deleted:true,
    __kettuMessageLoggerDeleted:true,
    __kmlDeletedAt:info?.deletedAt||Date.now(),
    __kmlStyleRevision:styleRevision,
    ...(mode==="overlay"?{
      backgroundColor:overlayNative,background_color:overlayNative,
      deletedBackgroundColor:overlayNative,deleted_background_color:overlayNative
    }:{textColor:redNative,text_color:redNative,contentColor:redNative})
  });
  const next={...row,message:m,__kmlStyleRevision:styleRevision};
  if(mode==="overlay"){
    next.backgroundColor=overlayNative;
    next.background_color=overlayNative;
    next.style=mergeRNStyle(row.style,{backgroundColor:RED_OVERLAY});
    next.containerStyle=mergeRNStyle(row.containerStyle,{backgroundColor:RED_OVERLAY});
  }else{
    next.textColor=redNative;
    next.text_color=redNative;
  }
  diag.nativeRowMarks++;
  return next;
}
function installRowManagerPatch(){
  const candidates=[];
  for(const name of ["RowManager","MessageRowManager","ChatRowManager"]){try{const C=M.findByName?.(name);if(C?.prototype?.generate&&!candidates.includes(C))candidates.push(C);}catch{}}
  try{const C=M.findByProps?.("generate");if(C?.generate&&!candidates.includes(C))candidates.push(C);}catch{}
  for(const C of candidates){
    try{
      const target=typeof C?.prototype?.generate==="function"?C.prototype:C;
      if(typeof target?.generate!=="function")continue;
      diag.rowManager=true; RowManager=RowManager||C;
      unpatches.push(patcher.instead("generate",target,function(args,orig){
        try{
          const row=args?.[0];const msg=row?.message||row?.messageRecord||row?.item?.message;
          const k=getMessageKey(msg,row?.channelId||row?.channel_id);const info=k?deleted.get(k):null;
          if(info){
            const nextArgs=args.slice();const mode=storage.deletedStyle||"redText";
            if(row?.message)nextArgs[0]=markRowInput(row,info,mode);
            const ret=orig.apply(this,nextArgs);
            if(isHighlightEnabledByKey(k))return paintGeneratedRow(ret,msg?.content??info.content,mode,info.authorName,msg?.id||info.id);
            return ret;
          }
        }catch(e){logError("RowManager.generate",e);}
        return orig.apply(this,args);
      }));
    }catch(e){logError("installRowManagerPatch",e);}
  }
}
function messageFromProps(props){return props?.message||props?.messageRecord||props?.item?.message||props?.row?.message||null;}
function patchElementArgs(args){
  try{
    const props=args?.[1];
    if(!props) return;
    const msg=messageFromProps(props);
    const k=getMessageKey(msg,props?.channelId||props?.channel_id);
    if(!k||!deleted.has(k)||!isHighlightEnabledByKey(k)) return;
    const next=args.slice();
    const p={...props};
    if((storage.deletedStyle||"redText")==="overlay"){
      p.style=mergeRNStyle(props.style,{backgroundColor:RED_OVERLAY});
      if(props.containerStyle!==undefined) p.containerStyle=mergeRNStyle(props.containerStyle,{backgroundColor:RED_OVERLAY});
    }else{
      p.style=mergeRNStyle(props.style,{color:RED});
      if(props.textStyle!==undefined) p.textStyle=mergeRNStyle(props.textStyle,{color:RED});
    }
    next[1]=p;
    return next;
  }catch(e){logError("React fallback",e);}
}
function installReactFallback(){
  const add=(name,parent)=>{try{if(parent&&typeof parent[name]==="function") unpatches.push(patcher.before(name,parent,patchElementArgs));}catch{}};
  try{
    add("createElement",React);
    const jsx=M.findByProps?.("jsx","jsxs");add("jsx",jsx);add("jsxs",jsx);
    add("jsxDEV",M.findByProps?.("jsxDEV"));
    diag.reactFallback=true;
  }catch(e){logError("installReactFallback",e);}
}
function makeDisplayMessage(msg,channelId,id,opts){
  const k=key(channelId,id);
  const raw=opts?.raw!==undefined?opts.raw:(rawCurrent.get(k)??stripSentinel(msg?.content??""));
  const display=opts?.inlineEdits===false?raw:buildInlineEditDisplay(k,raw);
  return cloneRecord(msg,{
    content:display,
    ...(opts?.deleted?{deleted:true,__kettuMessageLoggerDeleted:true,__kmlKey:k}:{}),
    __kmlInternal:true,
    __kmlRawContent:raw,
    __kmlEditHistory:(edits.get(k)||[]).slice(),
    __kmlHighlight:isHighlightEnabledByKey(k),
    __kmlStyleRevision:styleRevision
  });
}
function dispatchInternalUpdate(original,channelId,id,opts){
  if(!FluxDispatcher?.dispatch||!original)return;
  try{
    const msg=makeDisplayMessage(original,channelId,id,opts||{});
    diag.forcedRefreshes++;
    FluxDispatcher.dispatch({type:"MESSAGE_UPDATE",channelId,message:msg,__kmlInternal:true,__kmlStyleOnly:!!opts?.styleOnly});
  }catch(e){logError("internal MESSAGE_UPDATE",e);}
}
function invalidateNative(channelId,id){
  const objects=[];
  if(RowManager)objects.push(RowManager,RowManager.prototype);
  for(const o of objects){if(!o)continue;for(const n of ["invalidateMessage","invalidateRow","invalidate","updateRow","updateMessage","clearMessageCache","clearCache","reset"]){
    if(typeof o[n]!=="function")continue;try{o[n](channelId,id);}catch{try{o[n](id);}catch{}}
  }}
  try{MessageStore?.emitChange?.();}catch{}
  try{M.findByStoreName?.("ChannelStore")?.emitChange?.();}catch{}
}
function forceRerender(channelId,id){
  const current=safeMessage(channelId,id);if(!current)return;
  const k=key(channelId,id),raw=rawCurrent.get(k)??stripSentinel(current.content??"");
  invalidateNative(channelId,id);
  dispatchInternalUpdate(current,channelId,id,{raw,deleted:deleted.has(k),styleOnly:true});
  setTimeout(()=>invalidateNative(channelId,id),25);
}
function refreshDeletedMessage(channelId,id){styleRevision++;diag.styleRefreshes++;forceRerender(channelId,id);setTimeout(()=>forceRerender(channelId,id),70);}
function refreshAllDeleted(){styleRevision++;diag.styleRefreshes++;let n=0;for(const info of deleted.values()){const d=Math.min(n++*5,100);setTimeout(()=>forceRerender(info.channelId,info.id),d);setTimeout(()=>invalidateNative(info.channelId,info.id),d+90);}}
function installFluxPatch(){
  try{
    FluxDispatcher=M.findByProps?.("dispatch","subscribe");
    MessageStore=M.findByStoreName?.("MessageStore");
    diag.flux=!!FluxDispatcher;diag.messageStore=!!MessageStore;
    if(!FluxDispatcher||!MessageStore) return;
    unpatches.push(patcher.before("dispatch",FluxDispatcher,([action])=>{
      if(!action?.type) return;
      try{
        if(action.__kmlInternal) return;
        if(action.type==="MESSAGE_CREATE"){
          const m=action.message;
          const ch=m?.channel_id||m?.channelId||action.channelId||action.channel_id;
          if(ch&&m?.id&&m.content!==undefined) rawCurrent.set(key(ch,m.id),stripSentinel(m.content));
          return;
        }
        if(action.type==="MESSAGE_DELETE"&&storage.logDeletes){
          const channelId=action.channelId||action.channel_id;
          const id=action.id||action.messageId||action.message_id;
          const original=safeMessage(channelId,id);
          if(!original) return;
          const k=rememberDelete(channelId,id,original);
          if(storage.keepDeletedVisible){
            action.type="MESSAGE_UPDATE";
            action.message=makeDisplayMessage(original,channelId,id,{raw:rawCurrent.get(k),deleted:true});
            action.__kmlInternal=true;
            setTimeout(()=>refreshDeletedMessage(channelId,id),35);
            // Native DCDChat can cache a row when MESSAGE_DELETE becomes a same-content update.
            // v2.3 keeps content unchanged, then explicitly invalidates/re-renders native DCDChat row caches.
          }
          return;
        }
        if(action.type==="MESSAGE_DELETE_BULK"&&storage.logDeletes){
          const channelId=action.channelId||action.channel_id;
          const ids=action.ids||action.messageIds||action.message_ids||[];
          const originals=[];
          for(const id of ids){
            const original=safeMessage(channelId,id);
            if(!original) continue;
            rememberDelete(channelId,id,original);
            originals.push([id,original]);
          }
          diag.bulkDeletes++;
          if(storage.keepDeletedVisible&&originals.length){
            action.type="KETTU_MESSAGELOGGER_BULK_INTERCEPTED";
            action.__kmlInternal=true;
            setTimeout(()=>{for(const [id,original] of originals){
              dispatchInternalUpdate(original,channelId,id,{raw:rawCurrent.get(key(channelId,id)),deleted:true});
              setTimeout(()=>refreshDeletedMessage(channelId,id),45);
            }},0);
          }
          return;
        }
        if(action.type==="MESSAGE_UPDATE"&&storage.logEdits){
          const incoming=action.message;
          if(!incoming?.id||incoming.content===undefined||incoming.__kettuMessageLoggerDeleted) return;
          const channelId=incoming.channel_id||incoming.channelId||action.channelId||action.channel_id;
          if(!channelId) return;
          const k=key(channelId,incoming.id);
          const previous=safeMessage(channelId,incoming.id);
          const afterRaw=stripSentinel(incoming.content);
          const beforeRaw=rawCurrent.get(k)??stripSentinel(previous?.__kmlRawContent??previous?.content??"");
          rawCurrent.set(k,afterRaw);
          if(previous&&beforeRaw!==afterRaw){
            rememberEdit(channelId,incoming.id,previous,incoming,beforeRaw,afterRaw);
          }
          // Discord Android may emit the exact same MESSAGE_UPDATE twice. The second event
          // must still be decorated, otherwise it overwrites the first inline-history render
          // with the plain server payload and the history appears to randomly vanish.
          if((edits.get(k)||[]).length){
            const display=buildInlineEditDisplay(k,afterRaw);
            action.message=cloneRecord(incoming,{
              content:display,
              __kmlInternal:true,
              __kmlRawContent:afterRaw,
              __kmlEditHistory:(edits.get(k)||[]).slice()
            });
          }
        }
      }catch(e){logError("Flux dispatch",e);}
    }));
  }catch(e){logError("installFluxPatch",e);}
}
function installEditGuard(){
  try{
    Messages=M.findByProps?.("sendMessage","editMessage","startEditMessage")||M.findByProps?.("startEditMessage","editMessage");
    if(!Messages||typeof Messages.startEditMessage!=="function") return;
    unpatches.push(patcher.before("startEditMessage",Messages,args=>{
      try{
        const channelId=args?.[0];
        const messageId=args?.[1];
        const k=key(channelId,messageId);
        const raw=rawCurrent.get(k);
        if(raw===undefined) return;
        // Discord signatures have changed over time. Replace the first string argument after IDs.
        for(let i=2;i<args.length;i++){
          if(typeof args[i]==="string"){args[i]=raw;break;}
          if(args[i]&&typeof args[i]==="object"&&typeof args[i].content==="string"){
            args[i]={...args[i],content:raw};break;
          }
        }
      }catch(e){logError("startEditMessage guard",e);}
    }));
    diag.editGuard=true;
  }catch(e){logError("installEditGuard",e);}
}
function findTree(root,predicate){
  try{if(typeof utils?.findInReactTree==="function") return utils.findInReactTree(root,predicate);}catch{}
  const seen=new WeakSet();let budget=1800;
  function walk(v,depth){
    if(v==null||depth>12||budget--<=0) return null;
    try{if(predicate(v)) return v;}catch{}
    if(typeof v!=="object") return null;
    if(seen.has(v)) return null;seen.add(v);
    if(Array.isArray(v)){
      for(const x of v){const r=walk(x,depth+1);if(r) return r;}
      return null;
    }
    for(const prop of ["props","children","content","items"]){
      if(v[prop]!==undefined){const r=walk(v[prop],depth+1);if(r) return r;}
    }
    for(const prop of Object.keys(v)){
      if(["props","children","content","items"].includes(prop)||typeof v[prop]==="function") continue;
      const r=walk(v[prop],depth+1);if(r) return r;
    }
    return null;
  }
  return walk(root,0);
}
function findActionSheetRows(tree){
  const byName=findTree(tree,x=>Array.isArray(x)&&x.length>0&&x.some(el=>el?.type?.name==="ActionSheetRow"||el?.type?.displayName==="ActionSheetRow"));
  if(byName) return byName;
  return findTree(tree,x=>Array.isArray(x)&&x.length>0&&x.some(el=>el?.props&&typeof el.props.onPress==="function"&&(el.props.label!==undefined||el.props.message!==undefined)));
}
function installMessageLongPressPatch(){
  try{
    LazyActionSheet=M.findByProps?.("openLazy","hideActionSheet");
    ActionSheetRow=M.findByProps?.("ActionSheetRow")?.ActionSheetRow||common?.ActionSheetRow||ui?.components?.FormRow;
    if(!LazyActionSheet||typeof LazyActionSheet.openLazy!=="function"||!ActionSheetRow) return;
    unpatches.push(patcher.before("openLazy",LazyActionSheet,([component,sheetKey,sheetProps])=>{
      try{
        const message=sheetProps?.message;
        const k=getMessageKey(message);
        if(sheetKey!=="MessageLongPressActionSheet"||!message||!k||!deleted.has(k)) return;
        if(!component||typeof component.then!=="function") return;
        component.then(instance=>{
          try{
            if(!instance||typeof instance.default!=="function") return;
            const unpatch=patcher.after("default",instance,(_,res)=>{
              try{
                setTimeout(()=>{try{unpatch?.();}catch{}},0);
                const rows=findActionSheetRows(res);
                if(!rows) return;
                const already=rows.some?.(x=>x?.props?.__kmlToggleRow);
                if(already) return;
                const channelId=message.channel_id||message.channelId;
                const id=message.id;
                const enabled=isHighlightEnabledByKey(k);
                const label=enabled?"Beyaz göster":"Kırmızı göster";
                const row=React.createElement(ActionSheetRow,{
                  key:"kml-toggle-deleted-highlight",
                  label,
                  __kmlToggleRow:true,
                  onPress:()=>{
                    try{
                      highlightOverrides.set(k,!enabled);
                      diag.menuToggles++;
                      LazyActionSheet.hideActionSheet?.();
                      setTimeout(()=>refreshDeletedMessage(channelId,id),0);
                    }catch(e){logError("toggle highlight",e);}
                  }
                });
                rows.push(row);
              }catch(e){logError("message action sheet render",e);}
            });
          }catch(e){logError("message action sheet module",e);}
        }).catch?.(e=>logError("message action sheet promise",e));
      }catch(e){logError("MessageLongPressActionSheet",e);}
    }));
    diag.actionSheet=true;
  }catch(e){logError("installMessageLongPressPatch",e);}
}
function clearSession(removeVisible=false){
  if(removeVisible&&FluxDispatcher?.dispatch){
    for(const info of deleted.values()){
      try{FluxDispatcher.dispatch({type:"MESSAGE_DELETE",channelId:info.channelId,id:info.id,__kmlInternal:true});}catch{}
    }
  }
  deleted.clear();edits.clear();recentEditEvents.clear();rawCurrent.clear();highlightOverrides.clear();refreshParity.clear();sessionLog.length=0;
}
function statusText(){
  return [
    `Flux: ${diag.flux?"OK":"YOK"}`,
    `MessageStore: ${diag.messageStore?"OK":"YOK"}`,
    `RowManager: ${diag.rowManager?"OK":"YOK"}`,
    `Uzun basma menüsü: ${diag.actionSheet?"OK":"YOK"}`,
    `Edit kutusu koruması: ${diag.editGuard?"OK":"YOK"}`,
    `React fallback: ${diag.reactFallback?"OK":"YOK"}`,
    `Silme yakalandı: ${diag.deletes}`,
    `Edit yakalandı: ${diag.edits}`,
    `Inline edit render: ${diag.inlineEditRenders}`,
    `Zorunlu satır yenileme: ${diag.forcedRefreshes}`,
    `Kırmızı/beyaz geçiş: ${diag.menuToggles}`,
    `Kırmızı/overlay render denemesi/değişimi: ${diag.rowPaintAttempts}/${diag.rowPaintMutations}`,
    `Overlay envelope değişimi: ${diag.overlayEnvelopeMutations}`,
    `Native row işaretleme: ${diag.nativeRowMarks}`,
    `Stil yenileme: ${diag.styleRefreshes}`,
    diag.lastError?`Son hata: ${diag.lastError}`:""
  ].filter(Boolean).join("\n");
}
function Settings(){
  if(!React||!RN?.View||!RN?.Text) return null;
  const [,force]=React.useReducer(x=>x+1,0);
  const set=(k,v)=>{
    const changed=storage[k]!==v;
    storage[k]=v;
    force();
    if(changed&&(k==="deletedStyle"||k==="keepDeletedVisible")) setTimeout(refreshAllDeleted,0);
  };
  const View=RN.View,Text=RN.Text,ScrollView=RN.ScrollView||RN.View,Switch=RN.Switch,Pressable=RN.Pressable||RN.TouchableOpacity||RN.View;
  const styles={root:{padding:16,gap:12},title:{fontSize:22,fontWeight:"700",color:"#f2f3f5"},sub:{fontSize:13,color:"#b5bac1",marginBottom:8},row:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingVertical:10},label:{fontSize:16,color:"#f2f3f5",flex:1,paddingRight:12},card:{padding:12,borderRadius:10,backgroundColor:"#2b2d31",marginBottom:10},btn:{paddingVertical:10,paddingHorizontal:12,borderRadius:8,backgroundColor:"#404249",marginTop:6},btnOn:{backgroundColor:"#5865f2"},btnText:{color:"#ffffff",fontWeight:"600",textAlign:"center"},mono:{fontFamily:"monospace",fontSize:12,color:"#b5bac1"},log:{fontSize:12,color:"#dbdee1",marginTop:4}};
  const row=(label,k)=>React.createElement(View,{style:styles.row},React.createElement(Text,{style:styles.label},label),Switch?React.createElement(Switch,{value:!!storage[k],onValueChange:v=>set(k,v)}):null);
  const button=(label,onPress,on)=>React.createElement(Pressable,{onPress,style:[styles.btn,on&&styles.btnOn]},React.createElement(Text,{style:styles.btnText},label));
  return React.createElement(ScrollView,{contentContainerStyle:styles.root},
    React.createElement(Text,{style:styles.title},"Kettu MessageLogger v2.3"),
    React.createElement(Text,{style:styles.sub},"Vencord benzeri silme vurgusu + satır içi edit geçmişi. v2.3 FakeNitro/diğer pluginlerle çakışan görünmez content-refresh yöntemini kaldırır ve native DCDChat satırını mesaj ID üzerinden agresif biçimde boyar."),
    React.createElement(View,{style:styles.card},
      row("Silinen mesajları yakala","logDeletes"),
      row("Silinen mesajı sohbette tut","keepDeletedVisible"),
      row("Düzenleme geçmişini yakala","logEdits"),
      row("Eski sürümleri mesajın üstünde göster","inlineEdits"),
      row("Agresif native kırmızı (önerilen)","aggressiveNativeRed")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.label},"Silinen mesaj görünümü"),
      button("Kırmızı yazı",()=>set("deletedStyle","redText"),storage.deletedStyle==="redText"),
      button("Kırmızı overlay",()=>set("deletedStyle","overlay"),storage.deletedStyle==="overlay")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.label},"Tanılama"),
      React.createElement(Text,{style:styles.mono},statusText()),
      button("Sayaçları yenile",()=>force()),
      button("Oturum geçmişini temizle",()=>{clearSession(true);force();})
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.label},"Son olaylar"),
      ...(sessionLog.slice(0,20).length?sessionLog.slice(0,20).map((e,i)=>React.createElement(Text,{key:String(i),style:styles.log},e.kind==="delete"?`🗑 ${e.author}: ${e.content||"(metin yok)"}`:`✎ ${e.author}: ${e.before} → ${e.after}`)):[React.createElement(Text,{key:"empty",style:styles.sub},"Henüz olay yok.")])
    )
  );
}
function onLoad(){
  initDefaults();
  installFluxPatch();
  installRowManagerPatch();
  installReactFallback();
  installEditGuard();
  installMessageLongPressPatch();
  logInfo("loaded",statusText());
}
function onUnload(){
  clearSession(true);
  while(unpatches.length){try{unpatches.pop()?.();}catch{}}
  logInfo("unloaded");
}
return {onLoad,onUnload,settings:Settings,__test:{rememberDelete,rememberEdit,buildInlineEditDisplay,paintGeneratedRow,refreshDeletedMessage,deleted,edits}};
})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils)
