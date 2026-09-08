(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";

/*
 * Kettu MessageLogger v4.2.0
 * Author: bay4lly
 *
 * Safe DCDChat implementation:
 * - Never feeds hand-built fake MessageRecords to RowManager.
 * - Uses Discord's own createMessageRecord for edit-history render records.
 * - Deleted messages follow the proven MESSAGE_DELETE -> MESSAGE_UPDATE technique.
 * - Native RowManager output only receives fields known to Discord's serializer.
 */

const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};

const RED="#f04747";
const OVERLAY_BG="#da373c22";
const OVERLAY_GUTTER="#da373cff";

const unpatches=[];
const timers=[];
const rowUnpatches=[];

const deleted=new Map();       // channel:id -> metadata
const edits=new Map();         // channel:id -> [{content, after, time}]
const rawCurrent=new Map();    // channel:id -> real current content
const lastEditEvent=new Map(); // channel:id -> dedupe info
const whiteOverrides=new Set();// user chose "Beyaz göster"

let Flux=null;
let MessageStore=null;
let RowManager=null;
let RecordUtils=null;
let MessageRecordModule=null;
let LazyActionSheet=null;
let ActionSheetRow=null;

let fluxPatched=false;
let recordPatched=false;
let rowPatched=false;
let sheetPatched=false;

const diag={
 flux:false,store:false,records:false,row:false,sheet:false,
 deletes:0,edits:0,deduped:0,rowRenders:0,red:0,overlay:0,
 renderRecords:0,rearms:0,colorInt:0,colorSkipped:0,colorFields:new Set(),fallbackOverlay:0,lastError:""
};

function fail(where,e){
 diag.lastError=`${where}: ${e?.message||e}`;
 try{logger?.error?.(diag.lastError,e)}catch{}
}
function toast(v){try{ui?.showToast?.(String(v))}catch{}}

function defaults(){
 if(storage.logDeletes===undefined)storage.logDeletes=true;
 if(storage.logEdits===undefined)storage.logEdits=true;
 if(storage.inlineEdits===undefined)storage.inlineEdits=true;
 if(storage.keepDeletedVisible===undefined)storage.keepDeletedVisible=true;
 if(storage.deletedStyle===undefined)storage.deletedStyle="redText";
 if(storage.redFallbackOverlay===undefined)storage.redFallbackOverlay=true;
}

function k(ch,id){return `${String(ch||"?")}:${String(id||"?")}`}
function channelOf(m,fallback){return m?.channel_id||m?.channelId||fallback}
function idOf(m){return m?.id||m?.message_id||m?.messageId}

function stripLegacy(text){
 const raw=String(text??"").replace(/\u200B|\u2060/g,"");
 const lines=raw.split("\n");
 let i=0,found=false;
 while(i<lines.length && /^-#\s*✎\s+\d{1,2}:\d{2}\s{2}/.test(lines[i])){
  found=true;i++;
  while(i<lines.length && /^-#\s*↳\s{2}/.test(lines[i]))i++;
 }
 return found && i<lines.length ? lines.slice(i).join("\n") : raw;
}

function getStore(ch,id){
 try{return MessageStore?.getMessage?.(ch,id)||null}catch{return null}
}

function fmtTime(ms){
 try{
  return new Date(ms).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
 }catch{
  return new Date(ms).toLocaleTimeString().slice(0,5);
 }
}

function editTimestamp(m){
 const v=m?.edited_timestamp||m?.editedTimestamp;
 const n=v?new Date(v).getTime():Date.now();
 return Number.isFinite(n)?n:Date.now();
}

function historyLine(entry){
 const lines=String(entry.content??"").split("\n");
 if(!lines.length)return `-# ✎ ${fmtTime(entry.time)}  (boş mesaj)`;
 return lines.map((line,i)=>
  `-# ${i===0?`✎ ${fmtTime(entry.time)}  `:"↳  "}${line||" "}`
 ).join("\n");
}

function cleanedHistory(key){
 const src=edits.get(key)||[];
 const out=[];
 for(const e of src){
  const prev=out[out.length-1];
  if(prev && prev.content===e.content && prev.after===e.after){
   diag.deduped++;
   continue;
  }
  if(prev && prev.content===e.content && Math.abs(Number(prev.time)-Number(e.time))<30000){
   diag.deduped++;
   continue;
  }
  out.push(e);
 }
 if(out.length!==src.length)edits.set(key,out);
 return out;
}

function displayContent(key,current){
 if(!storage.inlineEdits)return current;
 const list=cleanedHistory(key);
 if(!list.length)return current;
 return `${list.map(historyLine).join("\n")}\n${current}`;
}

/*
 * Only fields used by the known-working Ghost Log Native message reconstruction.
 * Do not spread MessageRecord: many of its fields/getters are non-enumerable.
 */
function messageData(message,content,deletedFlag=false){
 const data={
  id:message?.id,
  channel_id:message?.channel_id||message?.channelId,
  content:String(content??""),
  author:message?.author,
  attachments:message?.attachments?[...message.attachments]:[],
  embeds:message?.embeds??[],
  mentions:message?.mentions??[],
  mention_roles:message?.mention_roles??[],
  mention_everyone:message?.mention_everyone??false,
  timestamp:message?.timestamp,
  edited_timestamp:message?.edited_timestamp??message?.editedTimestamp??null,
  pinned:message?.pinned??false,
  tts:message?.tts??false,
  flags:message?.flags??0,
  type:message?.type??0,
  state:message?.state??"SENT"
 };
 if(deletedFlag)data.__kml_deleted=true;

 if(message?.referenced_message){
  data.referenced_message=message.referenced_message;
  data.message_reference={
   channel_id:message.referenced_message.channel_id,
   message_id:message.referenced_message.id,
   guild_id:message?.messageReference?.guild_id||message?.message_reference?.guild_id
  };
 }
 return data;
}

function findRecordUtils(){
 try{
  const mod=M.findByProps?.("createMessageRecord","updateMessageRecord");
  return typeof mod?.createMessageRecord==="function"?mod:mod?.default;
 }catch{return null}
}

function makeRenderRecord(original,content,deletedFlag){
 try{
  const ru=RecordUtils||findRecordUtils();
  if(typeof ru?.createMessageRecord!=="function")return null;
  const rec=ru.createMessageRecord(
   messageData(original,content,deletedFlag),
   original?.reactions
  );
  if(rec && deletedFlag){
   try{rec.__kml_deleted=true}catch{}
  }
  if(rec)diag.renderRecords++;
  return rec||null;
 }catch(e){
  fail("makeRenderRecord",e);
  return null;
 }
}

function rememberEdit(ch,id,incoming){
 const key=k(ch,id);
 const previous=getStore(ch,id);
 const after=stripLegacy(incoming?.content);
 const before=rawCurrent.has(key)
  ?rawCurrent.get(key)
  :stripLegacy(previous?.content);

 // Always move the raw cache forward first.
 rawCurrent.set(key,after);

 if(before===after)return false;

 const stamp=String(incoming?.edited_timestamp||incoming?.editedTimestamp||"");
 const now=Date.now();
 const last=lastEditEvent.get(key);

 // Strong duplicate suppression:
 // same resulting content + same edit timestamp, or same transition in 30 sec.
 if(last && (
   (stamp && last.stamp===stamp && last.after===after) ||
   (last.before===before && last.after===after && now-last.seen<30000)
 )){
  diag.deduped++;
  return false;
 }

 const list=edits.get(key)||[];
 const tail=list[list.length-1];

 if(tail && tail.content===before && (
   tail.after===after ||
   Math.abs(Number(tail.time)-editTimestamp(incoming))<30000
 )){
  diag.deduped++;
  lastEditEvent.set(key,{before,after,stamp,seen:now});
  return false;
 }

 list.push({
  content:before,
  after,
  time:editTimestamp(incoming)
 });
 if(list.length>50)list.shift();
 edits.set(key,list);
 lastEditEvent.set(key,{before,after,stamp,seen:now});
 diag.edits++;
 return true;
}

function rememberDelete(ch,id,message){
 const key=k(ch,id);
 const content=rawCurrent.has(key)
  ?rawCurrent.get(key)
  :stripLegacy(message?.content);

 rawCurrent.set(key,content);
 if(!deleted.has(key)){
  deleted.set(key,{
   channelId:String(ch),
   id:String(id),
   content,
   deletedAt:Date.now()
  });
 }
 diag.deletes++;
 return key;
}

function discover(){
 try{
  Flux=M.findByProps?.("dispatch","subscribe");
  diag.flux=!!Flux?.dispatch;
 }catch{}
 try{
  MessageStore=M.findByStoreName?.("MessageStore");
  diag.store=!!MessageStore;
 }catch{}
 try{
  RecordUtils=findRecordUtils();
  diag.records=typeof RecordUtils?.createMessageRecord==="function";
 }catch{}
 try{
  RowManager=M.findByName?.("RowManager");
  diag.row=typeof RowManager?.prototype?.generate==="function";
 }catch{}
}

function installRecords(){
 if(recordPatched)return true;
 discover();

 let did=false;
 const ru=RecordUtils;

 if(typeof ru?.createMessageRecord==="function"){
  let pendingInput=null;

  unpatches.push(patcher.before("createMessageRecord",ru,args=>{
   pendingInput=args?.[0]||null;
   return args;
  }));

  unpatches.push(patcher.after("createMessageRecord",ru,(args,ret)=>{
   const input=pendingInput;
   pendingInput=null;
   try{
    if(ret && input?.__kml_deleted)ret.__kml_deleted=true;
   }catch(e){fail("createMessageRecord flag",e)}
   return ret;
  }));

  if(typeof ru.updateMessageRecord==="function"){
   unpatches.push(patcher.instead("updateMessageRecord",ru,(args,original)=>{
    const oldRecord=args?.[0];
    const newRecord=args?.[1];

    try{
     if(newRecord?.__kml_deleted){
      const made=ru.createMessageRecord(newRecord,oldRecord?.reactions);
      try{if(made)made.__kml_deleted=true}catch{}
      return made;
     }
    }catch(e){fail("updateMessageRecord deleted",e)}

    return typeof original==="function"
      ?original.apply(ru,args)
      :oldRecord;
   }));
  }
  did=true;
 }

 try{
  MessageRecordModule=M.findByName?.("MessageRecord",false);
  if(MessageRecordModule && typeof MessageRecordModule.default==="function"){
   let pendingDeleted=false;

   unpatches.push(patcher.before("default",MessageRecordModule,args=>{
    pendingDeleted=!!args?.[0]?.__kml_deleted;
    return args;
   }));

   unpatches.push(patcher.after("default",MessageRecordModule,(args,ret)=>{
    const flag=pendingDeleted;
    pendingDeleted=false;
    try{if(ret && flag)ret.__kml_deleted=true}catch{}
    return ret;
   }));
   did=true;
  }
 }catch(e){fail("MessageRecord patch",e)}

 if(did){
  recordPatched=true;
  diag.records=true;
 }
 return did;
}

function unpatchRow(){
 while(rowUnpatches.length){
  try{rowUnpatches.pop()?.()}catch{}
 }
 rowPatched=false;
}


function paintExistingNumericColors(root,nativeColor){
 let changed=0;
 const seen=new WeakSet();

 function walk(v,depth,path){
  if(!v||typeof v!=="object"||depth>4||seen.has(v))return;
  seen.add(v);

  for(const name of Object.keys(v)){
   let value;
   try{value=v[name]}catch{continue}

   const nextPath=path?`${path}.${name}`:name;

   if(/color/i.test(name) && typeof value==="number"){
    try{
     v[name]=nativeColor;
     diag.colorFields.add(nextPath);
     changed++;
    }catch{}
    continue;
   }

   if(value && typeof value==="object" && !Array.isArray(value)){
    walk(value,depth+1,nextPath);
   }
  }
 }

 walk(root,0,"message");
 return changed;
}

function applyOverlaySafe(ret){
 const pc=RN?.processColor;
 if(typeof pc!=="function")return false;

 const bg=pc(OVERLAY_BG);
 const gutter=pc(OVERLAY_GUTTER);

 if(typeof bg!=="number"||typeof gutter!=="number")return false;

 ret.backgroundHighlight=ret.backgroundHighlight??{};
 ret.backgroundHighlight.backgroundColor=bg;
 ret.backgroundHighlight.gutterColor=gutter;
 return true;
}

function installRow(forceLast=false){
 discover();

 if(forceLast && rowPatched){
  unpatchRow();
  diag.rearms++;
 }

 if(rowPatched)return true;

 const target=RowManager?.prototype;
 if(typeof target?.generate!=="function")return false;

 rowPatched=true;
 diag.row=true;

 /*
  * Before generate:
  * For edited messages only, replace row.message with a REAL MessageRecord made
  * by Discord's own createMessageRecord. This is render-only and never enters MessageStore.
  */
 rowUnpatches.push(patcher.before("generate",target,args=>{
  try{
   const row=args?.[0];
   if(row?.rowType!==1)return args;

   const msg=row?.message;
   if(!msg)return args;

   const ch=channelOf(msg,row?.channelId||row?.channel_id);
   const id=idOf(msg);
   if(!ch||!id)return args;

   const key=k(ch,id);
   const list=cleanedHistory(key);
   if(!storage.inlineEdits || !list.length)return args;

   const current=rawCurrent.has(key)
    ?rawCurrent.get(key)
    :stripLegacy(msg.content);

   const content=displayContent(key,current);
   const deletedFlag=!!msg.__kml_deleted || deleted.has(key);

   const renderRecord=makeRenderRecord(msg,content,deletedFlag);
   if(!renderRecord)return args;

   const nextRow={...row,message:renderRecord};
   const nextArgs=args.slice();
   nextArgs[0]=nextRow;
   return nextArgs;
  }catch(e){
   fail("RowManager before",e);
   return args;
  }
 }));

 /*
  * After generate:
  * ONLY write fields known to Discord's native DCDChat serializer.
  * No custom `color`, no `textColorString`, no extra background fields.
  */
 rowUnpatches.push(patcher.after("generate",target,(args,ret)=>{
  try{
   diag.rowRenders++;

   const row=args?.[0];
   if(row?.rowType!==1 || !ret || typeof ret!=="object")return ret;

   const msg=row?.message;
   if(!msg)return ret;

   const ch=channelOf(msg,row?.channelId||row?.channel_id);
   const id=idOf(msg);
   const key=ch&&id?k(ch,id):null;

   const isDeleted=!!msg.__kml_deleted || !!(key&&deleted.has(key));
   if(!isDeleted)return ret;

   if(key && whiteOverrides.has(key))return ret;

   ret.message=ret.message??{};
   ret.message.edited="deleted";

   if(storage.deletedStyle==="overlay"){
    if(applyOverlaySafe(ret)){
     diag.overlay++;
    }
   }else{
    /*
     * Discord 343.12 no longer has a reliable "body text color" field exposed
     * under the old colorString contract. We therefore NEVER invent a property.
     *
     * Instead, mutate only numeric color fields that already exist in the
     * DCDChat Message object. Same keys, same types => serializer-safe.
     */
    const pc=RN?.processColor;
    let changed=0;

    if(typeof pc==="function"){
     const nativeColor=pc(RED);
     if(typeof nativeColor==="number"){
      changed=paintExistingNumericColors(ret.message,nativeColor);
      if(changed>0){
       diag.colorInt+=changed;
       diag.red++;
      }
     }
    }

    if(changed===0){
     diag.colorSkipped++;
    }

    /*
     * On builds where the body text colour is no longer exposed as a mutable
     * row field, make deletion visually red via the native supported highlight.
     * This is intentionally a fallback, not a fake claim that white text changed.
     */
    if(storage.redFallbackOverlay && applyOverlaySafe(ret)){
     diag.fallbackOverlay++;
    }
   }

   return ret;
  }catch(e){
   fail("RowManager after",e);
   return ret;
  }
 }));

 return true;
}

function invalidate(ch,id){
 try{
  for(const host of [RowManager,RowManager?.prototype]){
   if(!host)continue;
   for(const name of [
    "invalidateMessage","invalidateRow","invalidate",
    "updateRow","updateMessage","clearMessageCache","clearCache"
   ]){
    if(typeof host[name]!=="function")continue;
    try{host[name](ch,id)}catch{
     try{host[name](id)}catch{}
    }
   }
  }
  MessageStore?.emitChange?.();
 }catch{}
}
function refresh(ch,id){
 setTimeout(()=>invalidate(ch,id),0);
 setTimeout(()=>invalidate(ch,id),120);
}

function installFlux(){
 if(fluxPatched)return true;
 discover();
 if(typeof Flux?.dispatch!=="function")return false;

 fluxPatched=true;

 unpatches.push(patcher.before("dispatch",Flux,args=>{
  const event=args?.[0];

  try{
   if(!event || event.__kml_internal)return args;

   if(event.type==="MESSAGE_CREATE"){
    const m=event.message;
    const ch=channelOf(m,event.channelId||event.channel_id);
    const id=idOf(m);
    if(ch&&id&&m?.content!==undefined){
     rawCurrent.set(k(ch,id),stripLegacy(m.content));
    }
    return args;
   }

   if(event.type==="MESSAGE_UPDATE"){
    const m=event.message;
    if(!m || m.__kml_deleted || m.content===undefined)return args;

    if(storage.logEdits){
     const ch=channelOf(m,event.channelId||event.channel_id);
     const id=idOf(m);
     if(ch&&id)rememberEdit(ch,id,m);
    }
    return args;
   }

   if(event.type==="MESSAGE_DELETE" && storage.logDeletes){
    const ch=event.channelId||event.channel_id;
    const id=event.id||event.messageId||event.message_id;
    if(!ch||!id)return args;

    const original=getStore(ch,id);
    if(!original || original.state==="SEND_FAILED")return args;

    const key=rememberDelete(ch,id,original);

    if(storage.keepDeletedVisible){
     const content=rawCurrent.get(key)??stripLegacy(original.content);

     // Proven mobile technique: replace the delete itself with a real message update.
     args[0]={
      type:"MESSAGE_UPDATE",
      message:messageData(original,content,true),
      __kml_internal:true
     };

     refresh(ch,id);
    }
    return args;
   }

   if(event.type==="MESSAGE_DELETE_BULK" && storage.logDeletes){
    const ch=event.channelId||event.channel_id;
    const ids=event.ids||event.messageIds||event.message_ids||[];
    if(!ch || !Array.isArray(ids) || !ids.length)return args;

    const found=[];
    for(const id of ids){
     const original=getStore(ch,id);
     if(!original || original.state==="SEND_FAILED")continue;
     const key=rememberDelete(ch,id,original);
     found.push({
      id,
      original,
      content:rawCurrent.get(key)??stripLegacy(original.content)
     });
    }

    if(storage.keepDeletedVisible && found.length){
     // Use a real MESSAGE_UPDATE for the first item instead of inventing an
     // unknown Flux event type. Schedule the rest immediately after.
     const first=found.shift();
     args[0]={
      type:"MESSAGE_UPDATE",
      message:messageData(first.original,first.content,true),
      __kml_internal:true
     };

     setTimeout(()=>{
      for(const item of found){
       try{
        Flux.dispatch({
         type:"MESSAGE_UPDATE",
         message:messageData(item.original,item.content,true),
         __kml_internal:true
        });
        refresh(ch,item.id);
       }catch{}
      }
     },0);

     refresh(ch,first.id);
    }
    return args;
   }

  }catch(e){
   fail("Flux",e);
  }

  return args;
 }));

 return true;
}

function findRows(root){
 const seen=new WeakSet();
 let budget=1400;

 function walk(v,depth){
  if(v==null||depth>12||budget--<=0)return null;
  if(Array.isArray(v) && v.some(x=>x?.props&&typeof x.props.onPress==="function"))return v;
  if(typeof v!=="object")return null;
  if(seen.has(v))return null;
  seen.add(v);

  for(const name of Object.keys(v)){
   if(typeof v[name]==="function")continue;
   const got=walk(v[name],depth+1);
   if(got)return got;
  }
  return null;
 }

 return walk(root,0);
}

function installLongPress(){
 if(sheetPatched)return true;

 try{
  LazyActionSheet=M.findByProps?.("openLazy","hideActionSheet");
  ActionSheetRow=
   M.findByProps?.("ActionSheetRow")?.ActionSheetRow||
   common?.ActionSheetRow||
   ui?.components?.FormRow;

  if(!LazyActionSheet?.openLazy||!ActionSheetRow)return false;

  unpatches.push(patcher.before("openLazy",LazyActionSheet,([component,sheetKey,props])=>{
   const msg=props?.message;
   const ch=channelOf(msg);
   const id=idOf(msg);
   const key=ch&&id?k(ch,id):null;

   if(sheetKey!=="MessageLongPressActionSheet"||!key||!deleted.has(key)||!component?.then)return;

   component.then(mod=>{
    if(typeof mod?.default!=="function")return;

    const un=patcher.after("default",mod,(_,tree)=>{
     setTimeout(()=>{try{un()}catch{}},0);

     const rows=findRows(tree);
     if(!rows||rows.some(r=>r?.props?.__kmlWhiteToggle))return;

     const white=whiteOverrides.has(key);

     rows.push(React.createElement(ActionSheetRow,{
      key:"kml-white-toggle",
      __kmlWhiteToggle:true,
      label:white?"Kırmızı göster":"Beyaz göster",
      onPress:()=>{
       if(white)whiteOverrides.delete(key);
       else whiteOverrides.add(key);
       try{LazyActionSheet.hideActionSheet?.()}catch{}
       refresh(ch,id);
      }
     }));
    });
   }).catch?.(()=>{});
  }));

  sheetPatched=true;
  diag.sheet=true;
  return true;
 }catch(e){
  fail("longPress",e);
  return false;
 }
}

function installAll(){
 discover();
 installRecords();
 installFlux();
 installRow(false);
 installLongPress();
}

function clearSession(){
 deleted.clear();
 edits.clear();
 rawCurrent.clear();
 lastEditEvent.clear();
 whiteOverrides.clear();
}

function Settings(){
 if(!React||!RN.View||!RN.Text)return null;

 const[,force]=React.useReducer(x=>x+1,0);
 const V=RN.View,T=RN.Text,SV=RN.ScrollView||V;
 const Sw=RN.Switch,P=RN.Pressable||RN.TouchableOpacity||V;

 const st={
  root:{padding:16,paddingBottom:32,gap:10},
  h:{fontSize:22,fontWeight:"700",color:"#fff"},
  card:{padding:12,borderRadius:11,backgroundColor:"#2b2d31",gap:9},
  row:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},
  text:{fontSize:15,color:"#fff",flex:1},
  sub:{fontSize:12,color:"#b5bac1",lineHeight:17},
  btn:{padding:10,borderRadius:8,backgroundColor:"#404249"},
  on:{backgroundColor:"#5865f2"},
  bt:{color:"#fff",fontWeight:"600",textAlign:"center"}
 };

 const set=(name,value)=>{
  storage[name]=value;
  force();
  if(name==="deletedStyle"){
   for(const d of deleted.values())refresh(d.channelId,d.id);
   // Re-arm RowManager after other visual plugins so our supported colorString
   // write is the final visual pass.
   installRow(true);
  }
 };

 const row=(label,name)=>
  React.createElement(V,{style:st.row},
   React.createElement(T,{style:st.text},label),
   Sw&&React.createElement(Sw,{
    value:!!storage[name],
    onValueChange:v=>set(name,v)
   })
  );

 const btn=(label,fn,on)=>
  React.createElement(P,{onPress:fn,style:[st.btn,on&&st.on]},
   React.createElement(T,{style:st.bt},label)
  );

 return React.createElement(SV,{contentContainerStyle:st.root},
  React.createElement(T,{style:st.h},"MessageLogger v4"),
  React.createElement(V,{style:st.card},
   row("Silinen mesajları logla","logDeletes"),
   row("Silinen mesajı sohbette bırak","keepDeletedVisible"),
   row("Düzenlemeleri logla","logEdits"),
   row("Eski düzenlemeleri mesajın üstünde göster","inlineEdits"),
   row("Kırmızı yazı çalışmazsa kırmızı overlay kullan","redFallbackOverlay")
  ),
  React.createElement(V,{style:st.card},
   React.createElement(T,{style:st.text},"Silinen mesaj görünümü"),
   btn("Kırmızı yazı",()=>set("deletedStyle","redText"),storage.deletedStyle==="redText"),
   btn("Kırmızı overlay",()=>set("deletedStyle","overlay"),storage.deletedStyle==="overlay")
  ),
  React.createElement(V,{style:st.card},
   React.createElement(T,{style:st.sub},
    `Flux ${diag.flux?"OK":"YOK"} | Store ${diag.store?"OK":"YOK"} | Records ${diag.records?"OK":"YOK"} | Row ${diag.row?"OK":"YOK"}\n`+
    `Silme ${diag.deletes} | Edit ${diag.edits} | Tekrar ${diag.deduped} | RenderRecord ${diag.renderRecords}\n`+
    `Row ${diag.rowRenders} | Kırmızı ${diag.red} | Overlay ${diag.overlay} | Rearm ${diag.rearms}\n`+
    `Native renk int ${diag.colorInt} | Atlanan renk ${diag.colorSkipped} | Fallback overlay ${diag.fallbackOverlay}\n`+
    `Bulunan renk alanları: ${[...diag.colorFields].slice(0,8).join(", ")||"-"}`+
    `${diag.lastError?`\nSon hata: ${diag.lastError}`:""}`
   ),
   btn("RowManager renk patch'ini sona taşı",()=>{
    installRow(true);
    for(const d of deleted.values())refresh(d.channelId,d.id);
    toast("MessageLogger görsel patch'i yeniden sona taşındı");
    force();
   }),
   btn("Oturum logunu temizle",()=>{
    clearSession();
    force();
   })
  )
 );
}

function onLoad(){
 defaults();
 installAll();

 // Discord modules and other plugins finish loading asynchronously.
 // Retry discovery, then deliberately re-arm our RowManager visual patch late
 // so FakeNitro/theme render patches do not overwrite the deleted colour.
 for(const ms of [250,1000,3000,7000]){
  timers.push(setTimeout(installAll,ms));
 }
 for(const ms of [4500,9000]){
  timers.push(setTimeout(()=>{
   installRecords();
   installRow(true);
  },ms));
 }
}

function onUnload(){
 for(const t of timers)clearTimeout(t);
 timers.length=0;

 unpatchRow();

 while(unpatches.length){
  try{unpatches.pop()?.()}catch{}
 }

 fluxPatched=false;
 recordPatched=false;
 sheetPatched=false;

 clearSession();
}

return {
 onLoad,
 onUnload,
 settings:Settings,
 __test:{
  stripLegacy,
  messageData,
  rememberEdit,
  cleanedHistory,
  displayContent,
  deleted,
  edits,
  rawCurrent,
  paintExistingNumericColors,
  applyOverlaySafe
 }
};

})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils);
