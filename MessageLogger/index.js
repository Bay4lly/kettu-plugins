(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";
/* Kettu MessageLogger v3.1.0 - bay4lly
 * Mobile DCDChat-focused logger. Keeps store content raw; edit history is render-only.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};
const RED="#f04747";
const OVERLAY_BG="#da373c22";
const OVERLAY_GUTTER="#da373cff";
const unpatches=[];
const deleted=new Map();
const edits=new Map();
const rawCurrent=new Map();
const lastTransitions=new Map();
const highlightOverrides=new Map();
let Flux=null,MessageStore=null,RowManager=null,Messages=null,LazyActionSheet=null,ActionSheetRow=null;
const diag={flux:false,store:false,row:false,sheet:false,editGuard:false,deletes:0,edits:0,deduped:0,rowRenders:0,redPaints:0,overlayPaints:0,inlineRenders:0,lastError:""};

function fail(where,e){diag.lastError=`${where}: ${e?.message||e}`;try{logger?.error?.(diag.lastError,e)}catch{}}
function toast(s){try{ui?.showToast?.(String(s))}catch{}}
function defaults(){
 if(storage.logDeletes===undefined)storage.logDeletes=true;
 if(storage.logEdits===undefined)storage.logEdits=true;
 if(storage.inlineEdits===undefined)storage.inlineEdits=true;
 if(storage.keepDeletedVisible===undefined)storage.keepDeletedVisible=true;
 if(storage.deletedStyle===undefined)storage.deletedStyle="redText";
 if(storage.showDeletedMarker===undefined)storage.showDeletedMarker=false;
}
function key(ch,id){return `${ch||"?"}:${id||"?"}`}
function chOf(m,f){return m?.channel_id||m?.channelId||f}
function idOf(m){return m?.id||m?.message_id||m?.messageId}
function cloneRecord(o,extra){try{return Object.assign(Object.create(Object.getPrototypeOf(o)),o,extra||{})}catch{return {...o,...(extra||{})}}}
function messageUpdateData(message,content){
 const d={
  id:message?.id,
  channel_id:message?.channel_id||message?.channelId,
  content:String(content??""),
  author:message?.author,
  attachments:Array.isArray(message?.attachments)?[...message.attachments]:(message?.attachments??[]),
  embeds:message?.embeds??[],mentions:message?.mentions??[],mention_roles:message?.mention_roles??[],
  mention_everyone:message?.mention_everyone??false,timestamp:message?.timestamp,
  edited_timestamp:message?.edited_timestamp??message?.editedTimestamp??null,
  pinned:message?.pinned??false,tts:message?.tts??false,flags:message?.flags??0,
  type:message?.type??0,state:message?.state??"SENT",components:message?.components??[],
  sticker_items:message?.sticker_items??message?.stickerItems??[],__kml_deleted:true
 };
 if(message?.referenced_message){
  d.referenced_message=message.referenced_message;
  d.message_reference=message.message_reference||message.messageReference||{
   channel_id:message.referenced_message.channel_id,
   message_id:message.referenced_message.id
  };
 }
 return d;
}
function getStore(ch,id){try{return MessageStore?.getMessage?.(ch,id)||null}catch{return null}}
function stripLegacyInline(v){
 const original=String(v??"");const lines=original.split("\n");let i=0,seen=false;
 while(i<lines.length&&/^-#\s*✎\s+.+?\s{2}/.test(lines[i])){
  seen=true;i++;while(i<lines.length&&/^-#\s*↳\s{2}/.test(lines[i]))i++;
 }
 return seen&&i<lines.length?lines.slice(i).join("\n"):original;
}
function rawText(v){return stripLegacyInline(String(v??"").replace(/\u200B|\u2060/g,""))}
function editTime(m){const v=m?.edited_timestamp||m?.editedTimestamp;const n=v?new Date(v).getTime():Date.now();return Number.isFinite(n)?n:Date.now()}
function fmt(ts){try{return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}catch{return new Date(ts).toLocaleTimeString().slice(0,5)}}
function subline(content,time){
 const lines=String(content??"").split("\n");
 if(!lines.some(Boolean))return `-# ✎ ${fmt(time)}  (boş mesaj)`;
 return lines.map((x,i)=>`-# ${i===0?`✎ ${fmt(time)}  `:"↳  "}${x||" "}`).join("\n");
}
function cleanHistory(k){
 const src=edits.get(k)||[],out=[];
 for(const e of src){
  const p=out[out.length-1];
  if(p&&p.content===e.content&&p.after===e.after){diag.deduped++;continue}
  out.push(e);
 }
 if(out.length!==src.length)edits.set(k,out);
 return out;
}
function inlineContent(k,current){
 if(!storage.inlineEdits)return current;
 const list=cleanHistory(k);if(!list.length)return current;
 diag.inlineRenders++;
 return `${list.map(e=>subline(e.content,e.time)).join("\n")}\n${current}`;
}
function rememberEdit(ch,id,previous,incoming,before,after){
 if(!ch||!id||before===after)return false;
 const k=key(ch,id);
 const stamp=String(incoming?.edited_timestamp||incoming?.editedTimestamp||"");
 const sig=`${before}\u0000${after}\u0000${stamp}`;
 const last=lastTransitions.get(k);
 // One actual Discord edit may be dispatched several times. After the first dispatch
 // rawCurrent already equals 'after', but this signature guard also protects weird bridges.
 if(last?.sig===sig || (last?.before===before&&last?.after===after&&Date.now()-last.seen<15000)){
  diag.deduped++;return false;
 }
 const list=edits.get(k)||[];
 const tail=list[list.length-1];
 if(tail&&tail.content===before&&tail.after===after){diag.deduped++;lastTransitions.set(k,{sig,before,after,seen:Date.now()});return false}
 list.push({content:before,after,time:editTime(incoming),stamp});
 if(list.length>50)list.shift();
 edits.set(k,list);
 lastTransitions.set(k,{sig,before,after,seen:Date.now()});
 diag.edits++;
 return true;
}
function rememberDelete(ch,id,msg){
 const k=key(ch,id),raw=rawCurrent.get(k)??rawText(msg?.content);
 rawCurrent.set(k,raw);
 if(!deleted.has(k))deleted.set(k,{channelId:String(ch),id:String(id),content:raw,author:msg?.author,deletedAt:Date.now()});
 diag.deletes++;
 return k;
}
function markerFor(k,content){return storage.showDeletedMarker&&deleted.has(k)?`🗑 ${content}`:content}
function highlightOn(k){return highlightOverrides.get(k)!==false}

function renderMessage(row,msg,k){
 const raw=rawCurrent.get(k)??rawText(msg?.content);
 const display=markerFor(k,inlineContent(k,raw));
 return cloneRecord(msg,{content:display,__kml_render_only:true,__kml_raw:raw,__kml_deleted:deleted.has(k)});
}
function paintNative(ret,k){
 if(!ret||typeof ret!=="object"||!deleted.has(k)||!highlightOn(k))return ret;
 const mode=storage.deletedStyle||"redText";
 try{
  // These are the current DCDChat RowManager output fields used by Discord mobile.
  ret.message=ret.message??{};
  ret.message.edited="deleted";
  if(mode==="overlay"){
   ret.backgroundHighlight=ret.backgroundHighlight??{};
   const pc=RN?.processColor;
   ret.backgroundHighlight.backgroundColor=typeof pc==="function"?pc(OVERLAY_BG):OVERLAY_BG;
   ret.backgroundHighlight.gutterColor=typeof pc==="function"?pc(OVERLAY_GUTTER):OVERLAY_GUTTER;
   diag.overlayPaints++;
  }else{
   ret.message.colorString=RED;
   diag.redPaints++;
  }
 }catch(e){fail("paintNative",e)}
 return ret;
}
function installRow(){
 try{
  RowManager=M.findByName?.("RowManager");
  const target=RowManager?.prototype;
  if(typeof target?.generate!=="function")return;
  diag.row=true;
  const pending=[];
  unpatches.push(patcher.before("generate",target,args=>{
   let k=null;
   try{
    const row=args?.[0];const msg=row?.message||row?.messageRecord||row?.item?.message;
    const ch=chOf(msg,row?.channelId||row?.channel_id);const id=idOf(msg);
    if(ch&&id){
     k=key(ch,id);
     if((edits.get(k)||[]).length||deleted.has(k)){
      const nextRow={...row};
      if(row?.message)nextRow.message=renderMessage(row,msg,k);
      else if(row?.messageRecord)nextRow.messageRecord=renderMessage(row,msg,k);
      else if(row?.item?.message)nextRow.item={...row.item,message:renderMessage(row,msg,k)};
      const next=args.slice();next[0]=nextRow;pending.push(k);return next;
     }
    }
   }catch(e){fail("RowManager input",e)}
   pending.push(k);return args;
  }));
  unpatches.push(patcher.after("generate",target,(args,ret)=>{
   const k=pending.pop()||null;diag.rowRenders++;
   return k?paintNative(ret,k):ret;
  }));
 }catch(e){fail("installRow",e)}
}
function invalidate(ch,id){
 try{
  for(const o of [RowManager,RowManager?.prototype])if(o)for(const n of ["invalidateMessage","invalidateRow","invalidate","updateRow","updateMessage","clearMessageCache","clearCache"]){
   if(typeof o[n]==="function")try{o[n](ch,id)}catch{try{o[n](id)}catch{}}
  }
  MessageStore?.emitChange?.();
 }catch{}
}
function refresh(ch,id){setTimeout(()=>invalidate(ch,id),0);setTimeout(()=>invalidate(ch,id),80)}

function installFlux(){
 try{
  Flux=M.findByProps?.("dispatch","subscribe");MessageStore=M.findByStoreName?.("MessageStore");
  diag.flux=!!Flux;diag.store=!!MessageStore;if(!Flux?.dispatch)return;
  unpatches.push(patcher.before("dispatch",Flux,args=>{
   const a=args?.[0];
   try{
    if(!a||a.__kmlInternal)return;
    if(a.type==="MESSAGE_CREATE"){
     const m=a.message,ch=chOf(m,a.channelId||a.channel_id),id=idOf(m);
     if(ch&&id&&m?.content!==undefined)rawCurrent.set(key(ch,id),rawText(m.content));
     return;
    }
    if(a.type==="MESSAGE_UPDATE"&&storage.logEdits){
     const m=a.message;if(!m||m.content===undefined)return;
     const ch=chOf(m,a.channelId||a.channel_id),id=idOf(m);if(!ch||!id)return;
     const k=key(ch,id);const previous=getStore(ch,id);
     const after=rawText(m.content);
     const before=rawCurrent.has(k)?rawCurrent.get(k):rawText(previous?.content);
     // IMPORTANT: update raw cache first. A duplicate event then becomes before===after.
     rawCurrent.set(k,after);
     if(previous&&before!==after)rememberEdit(ch,id,previous,m,before,after);
     // Do NOT mutate a.message.content. v2 did that, which polluted MessageStore and caused
     // duplicate edit-history entries and FakeNitro/plugin conflicts.
     return;
    }
    if(a.type==="MESSAGE_DELETE"&&storage.logDeletes){
     const ch=a.channelId||a.channel_id,id=a.id||a.messageId||a.message_id;if(!ch||!id)return;
     const original=getStore(ch,id);if(!original)return;
     const k=rememberDelete(ch,id,original);
     if(storage.keepDeletedVisible){
      const raw=rawCurrent.get(k)??rawText(original.content);
      // Replace the raw delete with a full MESSAGE_UPDATE payload. This avoids relying
      // on enumerable fields of Discord's MessageRecord class.
      args[0]={type:"MESSAGE_UPDATE",message:messageUpdateData(original,raw),__kmlInternal:true};
      refresh(ch,id);
     }
     return args;
    }
    if(a.type==="MESSAGE_DELETE_BULK"&&storage.logDeletes){
     const ch=a.channelId||a.channel_id,ids=a.ids||a.messageIds||a.message_ids||[];
     const rows=[];
     for(const id of ids){const original=getStore(ch,id);if(original){rememberDelete(ch,id,original);rows.push([id,original])}}
     if(storage.keepDeletedVisible&&rows.length){
      args[0]={type:"KML_BULK_SWALLOWED",__kmlInternal:true};
      setTimeout(()=>{for(const [id,original] of rows){
       try{Flux.dispatch({type:"MESSAGE_UPDATE",channelId:ch,message:messageUpdateData(original,rawCurrent.get(key(ch,id))??rawText(original.content)),__kmlInternal:true});refresh(ch,id)}catch{}
      }},0);
      return args;
     }
    }
   }catch(e){fail("Flux",e)}
  }));
 }catch(e){fail("installFlux",e)}
}
function installEditGuard(){
 try{
  Messages=M.findByProps?.("sendMessage","editMessage","startEditMessage")||M.findByProps?.("startEditMessage","editMessage");
  if(typeof Messages?.startEditMessage!=="function")return;
  unpatches.push(patcher.before("startEditMessage",Messages,args=>{
   try{
    const ch=args?.[0],id=args?.[1],raw=rawCurrent.get(key(ch,id));if(raw===undefined)return;
    for(let i=2;i<args.length;i++){
     if(typeof args[i]==="string"){args[i]=raw;break}
     if(args[i]&&typeof args[i]==="object"&&typeof args[i].content==="string"){args[i]={...args[i],content:raw};break}
    }
   }catch(e){fail("editGuard",e)}
  }));diag.editGuard=true;
 }catch(e){fail("installEditGuard",e)}
}
function findRows(root){
 const seen=new WeakSet();let budget=1500;
 function walk(v,d){if(v==null||d>12||budget--<0)return null;if(Array.isArray(v)&&v.some(x=>x?.props&&typeof x.props.onPress==="function"))return v;if(typeof v!=="object")return null;if(seen.has(v))return null;seen.add(v);for(const k of Object.keys(v)){if(typeof v[k]==="function")continue;const r=walk(v[k],d+1);if(r)return r}return null}
 return walk(root,0);
}
function installLongPress(){
 try{
  LazyActionSheet=M.findByProps?.("openLazy","hideActionSheet");
  ActionSheetRow=M.findByProps?.("ActionSheetRow")?.ActionSheetRow||common?.ActionSheetRow||ui?.components?.FormRow;
  if(!LazyActionSheet?.openLazy||!ActionSheetRow)return;
  unpatches.push(patcher.before("openLazy",LazyActionSheet,([component,sheetKey,props])=>{
   const m=props?.message,k=m?key(chOf(m),idOf(m)):null;
   if(sheetKey!=="MessageLongPressActionSheet"||!k||!deleted.has(k)||!component?.then)return;
   component.then(mod=>{if(typeof mod?.default!=="function")return;const u=patcher.after("default",mod,(_,tree)=>{
    setTimeout(()=>{try{u()}catch{}},0);const rows=findRows(tree);if(!rows||rows.some(r=>r?.props?.__kmlToggle))return;
    const on=highlightOn(k);rows.push(React.createElement(ActionSheetRow,{key:"kml-toggle",__kmlToggle:true,label:on?"Beyaz göster":"Kırmızı göster",onPress:()=>{highlightOverrides.set(k,!on);LazyActionSheet.hideActionSheet?.();refresh(chOf(m),idOf(m))}}));
   })}).catch?.(()=>{});
  }));diag.sheet=true;
 }catch(e){fail("installLongPress",e)}
}
function clearAll(){deleted.clear();edits.clear();rawCurrent.clear();lastTransitions.clear();highlightOverrides.clear()}
function Settings(){
 if(!React||!RN.View||!RN.Text)return null;
 const[,force]=React.useReducer(x=>x+1,0);const V=RN.View,T=RN.Text,SV=RN.ScrollView||V,Sw=RN.Switch,P=RN.Pressable||RN.TouchableOpacity||V;
 const st={root:{padding:16,paddingBottom:32,gap:10},h:{fontSize:22,fontWeight:"700",color:"#fff"},c:{padding:12,borderRadius:11,backgroundColor:"#2b2d31",gap:9},r:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},t:{fontSize:15,color:"#fff",flex:1},sub:{fontSize:12,color:"#b5bac1",lineHeight:17},b:{padding:10,borderRadius:8,backgroundColor:"#404249"},on:{backgroundColor:"#5865f2"},bt:{color:"#fff",fontWeight:"600",textAlign:"center"}};
 const set=(k,v)=>{storage[k]=v;force();if(k==="deletedStyle")for(const d of deleted.values())refresh(d.channelId,d.id)};
 const row=(l,k)=>React.createElement(V,{style:st.r},React.createElement(T,{style:st.t},l),Sw&&React.createElement(Sw,{value:!!storage[k],onValueChange:v=>set(k,v)}));
 const btn=(l,fn,on)=>React.createElement(P,{onPress:fn,style:[st.b,on&&st.on]},React.createElement(T,{style:st.bt},l));
 return React.createElement(SV,{contentContainerStyle:st.root},
  React.createElement(T,{style:st.h},"MessageLogger"),
  React.createElement(V,{style:st.c},row("Silinen mesajları tut","logDeletes"),row("Edit geçmişini tut","logEdits"),row("Edit geçmişini mesaj üstünde göster","inlineEdits"),row("Silinen mesajı sohbette bırak","keepDeletedVisible"),row("Silinen işareti (🗑) fallback","showDeletedMarker")),
  React.createElement(V,{style:st.c},React.createElement(T,{style:st.t},"Silinen mesaj görünümü"),btn("Kırmızı yazı",()=>set("deletedStyle","redText"),storage.deletedStyle==="redText"),btn("Kırmızı overlay",()=>set("deletedStyle","overlay"),storage.deletedStyle==="overlay")),
  React.createElement(V,{style:st.c},React.createElement(T,{style:st.sub},`Flux ${diag.flux?"OK":"YOK"} | Store ${diag.store?"OK":"YOK"} | RowManager ${diag.row?"OK":"YOK"}\nSilme ${diag.deletes} | Edit ${diag.edits} | Tekrar engellendi ${diag.deduped}\nRow render ${diag.rowRenders} | Kırmızı ${diag.redPaints} | Overlay ${diag.overlayPaints} | Inline ${diag.inlineRenders}${diag.lastError?`\n${diag.lastError}`:""}`),btn("Oturum logunu temizle",()=>{clearAll();force()}))
 );
}
function onLoad(){defaults();installFlux();installRow();installEditGuard();installLongPress()}
function onUnload(){while(unpatches.length){try{unpatches.pop()?.()}catch{}}clearAll()}
return {onLoad,onUnload,settings:Settings,__test:{rememberEdit,cleanHistory,inlineContent,paintNative,stripLegacyInline,messageUpdateData,deleted,edits,rawCurrent}};
})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils)
