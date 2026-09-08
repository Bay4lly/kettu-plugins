(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";
/*
 * Kettu FakeNitro v1.2.0
 * Mobile-oriented reimplementation of Vencord FakeNitro behavior for Kettu's
 * Vendetta compatibility API.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Upstream inspiration: Vencord FakeNitro (GPL-3.0-or-later).
 */

const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};
const unpatches=[];
const timers=[];
const patched=new WeakMap();
const moduleIds=new WeakMap();
let nextModuleId=1;

const SIZES=[16,32,48,56,64,96,128,160,256,512,1024];
const DEFAULTS={
  enableEmojiBypass:true,
  emojiSize:48,
  enableStickerBypass:true,
  stickerSize:160,
  useHyperLinks:true,
  hyperLinkText:"{{NAME}}",
  unlockEmojiPicker:true,
  unlockStickerPicker:true,
  unlockClientThemes:true,
  unlockStreamQuality:true,
  unlockPremiumAppIcons:true,
  unlockSoundboard:true,
  forceExternalEmojiLinks:true,
  forceUnavailableStickerLinks:true,
  patchAvailabilityObjects:true,
  preserveLocalThemes:true,
  reapplyLocalTheme:true,
  unlockAppIconPremiumGate:true,
  patchAppIconObjects:true
};

const diag={
  scans:0,
  messageActions:0,
  emojiStore:false,
  stickerStore:false,
  channelStore:false,
  userStore:false,
  permissionStore:false,
  emojiTransforms:0,
  stickerTransforms:0,
  sendPatches:0,
  editPatches:0,
  availabilityPatches:0,
  capabilityPatches:{},
  localThemeEvents:0,
  themeCaptures:0,
  themeReapplies:0,
  themeRevertsBlocked:0,
  themeProtoReady:false,
  appIconModules:0,
  appIconPremiumPatches:0,
  appIconObjectPatches:0,
  appIconContextHits:0,
  appIconGetters:[],
  appIconSetters:[],
  lastError:""
};

const CAPABILITIES={
  emoji:[
    "canUseEmojisEverywhere","canUseAnimatedEmojis","canUseExternalEmojis",
    "canUsePremiumEmojis","canUseCustomEmojisEverywhere","canUseCustomEmojis"
  ],
  sticker:[
    "canUseCustomStickersEverywhere","canUseExternalStickers","canUseStickersEverywhere",
    "canUsePremiumStickers","canUseCustomStickers"
  ],
  stream:[
    "canUseHighVideoUploadQuality","canStreamQuality","canStreamHighQuality",
    "canStreamMidQuality","canStreamHD","canStream1080p","canUseHighQualityStream",
    "canUsePremiumStreamQuality"
  ],
  theme:["canUseClientThemes","canUsePremiumThemes","canUseGradientThemes"],
  appIcon:["canUsePremiumAppIcons","canUseCustomAppIcons","canUseAppIcons"],
  soundboard:["canUseSoundboardEverywhere","canUseExternalSounds","canUsePremiumSoundboard"]
};

let MessageActions=null;
let EmojiStore=null;
let StickersStore=null;
let ChannelStore=null;
let UserStore=null;
let PermissionStore=null;
let PermissionsBits=null;
let FluxDispatcher=common?.FluxDispatcher||null;

let PreloadedSettingsActions=null;
let AppearanceProtoClass=null;
let ClientThemeProtoClass=null;

let localThemeRuntime=null;
let themeReapplyTimer=null;
let themeInternalDispatch=false;

let appIconContextUntil=0;
let appIconContextDepth=0;
const appIconModules=new Set();
const appIconPremiumModules=new Set();

const APP_ICON_CURRENT_GETTERS=[
  "getCurrentDesktopIcon","getCurrentAppIcon","getCurrentMobileIcon",
  "getSelectedAppIcon","getCurrentIcon"
];
const APP_ICON_SETTERS=[
  "setAppIcon","setCurrentAppIcon","setAlternateAppIcon",
  "selectAppIcon","updateAppIcon"
];
const APP_ICON_LIST_GETTERS=[
  "getAppIcons","getAvailableAppIcons","getAppIconOptions",
  "getPremiumAppIcons","getSelectableAppIcons"
];

function initDefaults(){
  for(const [k,v] of Object.entries(DEFAULTS)) if(storage[k]===undefined) storage[k]=v;
}
function logError(where,e){
  const msg=`${where}: ${e?.message||String(e)}`;
  diag.lastError=msg;
  try{logger?.error?.(msg,e);}catch{}
  try{console.warn("[KettuFakeNitro]",msg,e);}catch{}
}
function logInfo(...a){try{logger?.log?.(...a);}catch{try{console.log("[KettuFakeNitro]",...a);}catch{}}}
function getModuleId(obj){
  if(!obj||(typeof obj!=="object"&&typeof obj!=="function")) return "?";
  if(!moduleIds.has(obj)) moduleIds.set(obj,nextModuleId++);
  return moduleIds.get(obj);
}
function isPatched(obj,key){return !!patched.get(obj)?.has(key);}
function markPatched(obj,key){
  let s=patched.get(obj); if(!s){s=new Set();patched.set(obj,s);} s.add(key);
}
function addUnpatch(fn){if(typeof fn==="function") unpatches.push(fn);}
function safeFindByProps(...props){try{return M?.findByProps?.(...props)||null;}catch(e){logError(`findByProps(${props.join(",")})`,e);return null;}}
function safeFindAllByProp(prop){
  const out=[];
  try{
    const all=M?.findByPropsAll?.(prop);
    if(Array.isArray(all)) out.push(...all.filter(Boolean));
  }catch{}
  if(!out.length){const one=safeFindByProps(prop);if(one)out.push(one);}
  return [...new Set(out)];
}
function safeFindStore(name){try{return M?.findByStoreName?.(name)||null;}catch{return null;}}
function getCurrentUser(){try{return UserStore?.getCurrentUser?.()||null;}catch{return null;}}
function premiumType(){const u=getCurrentUser();return Number(u?.premiumType??u?.premium_type??0)||0;}
function currentGuildId(channelId){
  try{
    const ch=ChannelStore?.getChannel?.(channelId);
    return ch?.guild_id||ch?.guildId||null;
  }catch{return null;}
}
function permissionBit(name){
  try{return PermissionsBits?.[name]??null;}catch{return null;}
}
function hasPermission(channelId,name){
  try{
    const ch=ChannelStore?.getChannel?.(channelId);
    if(!ch) return true;
    if(typeof ch.isPrivate==="function"&&ch.isPrivate()) return true;
    const bit=permissionBit(name);
    if(bit==null||!PermissionStore?.can) return true;
    return !!PermissionStore.can(bit,ch);
  }catch{return true;}
}
function normalizeSize(v,fallback){
  const n=Number(v);return SIZES.includes(n)?n:fallback;
}
function safeName(v,fallback="item"){
  const s=String(v||fallback).replace(/[\r\n]/g," ").trim();
  return s||fallback;
}
function markdownEscape(s){return String(s).replace(/([\\`*_[\]<>])/g,"\\$1");}
function labelFor(name){
  const template=String(storage.hyperLinkText||"{{NAME}}");
  return markdownEscape(template.split("{{NAME}}").join(safeName(name,"emoji")));
}
function spacingBefore(s){return !s||/\s$/.test(s)?"":" ";}
function spacingAround(orig,start,len){
  const before=start<=0||/\s/.test(orig[start-1]||"")?"":" ";
  const after=start+len>=orig.length||/\s/.test(orig[start+len]||"")?"":" ";
  return [before,after];
}
function emojiUrl(emoji){
  const id=emoji?.id;
  const animated=!!emoji?.animated;
  const size=normalizeSize(storage.emojiSize,48);
  const ext=animated?"gif":"webp";
  const name=encodeURIComponent(safeName(emoji?.name||emoji?.originalName,"emoji"));
  return `https://cdn.discordapp.com/emojis/${id}.${ext}?size=${size}&quality=lossless&name=${name}`;
}
function stickerFormat(sticker){
  const f=sticker?.format_type??sticker?.formatType;
  return f===4||String(f).toUpperCase()==="GIF"?"gif":"png";
}
function stickerUrl(sticker){
  const size=normalizeSize(storage.stickerSize,160);
  const name=encodeURIComponent(safeName(sticker?.name,"sticker"));
  return `https://media.discordapp.net/stickers/${sticker?.id}.${stickerFormat(sticker)}?size=${size}&name=${name}&lossless=true`;
}
function wrapLink(name,url){return storage.useHyperLinks?`[${labelFor(name)}](${url})`:url;}
function originalAvailability(obj){
  if(obj&&Object.prototype.hasOwnProperty.call(obj,"__kfnOriginalAvailable")) return obj.__kfnOriginalAvailable;
  return obj?.available;
}
function shouldFakeEmoji(emoji,channelId){
  if(!storage.enableEmojiBypass||!emoji?.id) return false;
  if(emoji.type===0) return false;
  if(originalAvailability(emoji)===false) return true;
  const p=premiumType();
  const emojiGuild=emoji.guildId||emoji.guild_id||null;
  const guild=currentGuildId(channelId);
  if(!storage.forceExternalEmojiLinks) return false;
  if(p>0){
    if(emojiGuild&&guild&&emojiGuild!==guild&&!hasPermission(channelId,"USE_EXTERNAL_EMOJIS")) return true;
    return false;
  }
  // Mirrors Vencord FakeNitro's no-Nitro fallback closely: without Nitro,
  // only a static emoji from the current guild is treated as natively usable.
  if(emoji.animated) return true;
  if(emojiGuild&&(!guild||emojiGuild!==guild)) return true;
  return false;
}
function shouldFakeSticker(sticker,channelId){
  if(!storage.enableStickerBypass||!sticker?.id) return false;
  // Official pack stickers are not guild Nitro stickers.
  if(sticker.pack_id||sticker.packId) return false;
  if(originalAvailability(sticker)===false&&storage.forceUnavailableStickerLinks) return true;
  const stickerGuild=sticker.guild_id||sticker.guildId||null;
  const guild=currentGuildId(channelId);
  if(stickerGuild&&guild&&stickerGuild!==guild&&!hasPermission(channelId,"USE_EXTERNAL_STICKERS")) return true;
  // Preserve Vencord's older Nitro fallback for external guild stickers when
  // Discord marks them as restricted in this client build.
  if(premiumType()<2&&stickerGuild&&guild&&stickerGuild!==guild&&storage.forceUnavailableStickerLinks) return true;
  return false;
}
function cloneAvailable(obj){
  if(!obj||typeof obj!=="object") return obj;
  if(obj.available!==false) return obj;
  try{
    const c=Array.isArray(obj)?obj.slice():Object.assign(Object.create(Object.getPrototypeOf(obj)),obj);
    c.__kfnOriginalAvailable=false;
    c.available=true;
    return c;
  }catch{return obj;}
}
function mapAvailability(ret){
  if(!storage.patchAvailabilityObjects||ret==null) return ret;
  if(Array.isArray(ret)) return ret.map(v=>cloneAvailable(v));
  if(typeof ret==="object"){
    if(Object.prototype.hasOwnProperty.call(ret,"available")) return cloneAvailable(ret);
    let changed=false;const out=Array.isArray(ret)?ret.slice():{...ret};
    for(const key of ["emojis","stickers","sounds","soundboardSounds","items"]){
      if(Array.isArray(ret[key])){out[key]=ret[key].map(v=>cloneAvailable(v));changed=true;}
    }
    return changed?out:ret;
  }
  return ret;
}
function locateMessageObject(args){
  if(args?.[1]&&typeof args[1]==="object"&&typeof args[1].content==="string") return args[1];
  for(const a of args||[]) if(a&&typeof a==="object"&&typeof a.content==="string") return a;
  return null;
}
function locateStickerOptions(args){
  for(const a of args||[]){
    if(a&&typeof a==="object"&&Array.isArray(a.stickerIds)) return a;
    if(a?.options&&Array.isArray(a.options.stickerIds)) return a.options;
  }
  return null;
}
function resolveSticker(id){
  try{return StickersStore?.getStickerById?.(String(id))||StickersStore?.getStickerById?.(id)||null;}catch{return null;}
}
function resolveEmoji(id){
  try{return EmojiStore?.getCustomEmojiById?.(String(id))||EmojiStore?.getCustomEmojiById?.(id)||null;}catch{return null;}
}
function transformEmojiToken(content,emoji,channelId){
  if(!shouldFakeEmoji(emoji,channelId)) return content;
  const names=[emoji.originalName,emoji.name].filter(Boolean).map(String);
  if(!names.length) names.push("emoji");
  const id=String(emoji.id);
  const re=new RegExp(`<a?:[^:>]+:${id}>`,`g`);
  let count=0;
  const url=emojiUrl(emoji),replacement=wrapLink(emoji.name||emoji.originalName,url);
  const out=String(content).replace(re,(match,offset,orig)=>{
    count++;
    const [b,a]=spacingAround(orig,offset,match.length);
    return `${b}${replacement}${a}`;
  });
  if(count) diag.emojiTransforms+=count;
  return out;
}
function transformRawEmojiSyntax(content,channelId){
  if(!storage.enableEmojiBypass||typeof content!=="string") return content;
  return content.replace(/<(a?):([^:\n>]+):(\d+)>/g,(full,a,name,id,offset,orig)=>{
    if(offset>0&&orig[offset-1]==="\\") return full;
    const emoji=resolveEmoji(id)||{id,name,originalName:name,animated:a==="a",available:false};
    if(!shouldFakeEmoji(emoji,channelId)) return full;
    diag.emojiTransforms++;
    const [b,after]=spacingAround(orig,offset,full.length);
    return `${b}${wrapLink(emoji.name||name,emojiUrl(emoji))}${after}`;
  });
}
function transformOutgoing(channelId,messageObj,options){
  if(!messageObj||typeof messageObj.content!=="string") return;
  // Stickers first so a sticker-only message can become a URL message.
  if(storage.enableStickerBypass&&options&&Array.isArray(options.stickerIds)&&options.stickerIds.length){
    const id=options.stickerIds[0];
    let sticker=resolveSticker(id);
    if(!sticker) sticker={id,name:"sticker",available:false,format_type:1};
    if(shouldFakeSticker(sticker,channelId)){
      const link=wrapLink(sticker.name,stickerUrl(sticker));
      messageObj.content=`${messageObj.content}${spacingBefore(messageObj.content)}${link}`;
      options.stickerIds.length=0;
      diag.stickerTransforms++;
    }
  }
  if(storage.enableEmojiBypass){
    const list=Array.isArray(messageObj.validNonShortcutEmojis)?messageObj.validNonShortcutEmojis:[];
    let text=messageObj.content;
    for(const emoji of list) text=transformEmojiToken(text,emoji,channelId);
    // Some Discord builds omit validNonShortcutEmojis on edits/special sends.
    text=transformRawEmojiSyntax(text,channelId);
    messageObj.content=text;
  }
}
function patchBefore(obj,key,cb,label){
  if(!obj||typeof obj[key]!=="function"||isPatched(obj,key)) return false;
  try{
    addUnpatch(patcher.before(key,obj,args=>{try{return cb(args);}catch(e){logError(label||key,e);}}));
    markPatched(obj,key);return true;
  }catch(e){logError(`patchBefore:${label||key}`,e);return false;}
}
function patchAfter(obj,key,cb,label){
  if(!obj||typeof obj[key]!=="function"||isPatched(obj,key)) return false;
  try{
    addUnpatch(patcher.after(key,obj,(args,ret)=>{try{return cb(args,ret);}catch(e){logError(label||key,e);return ret;}}));
    markPatched(obj,key);return true;
  }catch(e){logError(`patchAfter:${label||key}`,e);return false;}
}
function patchInstead(obj,key,cb,label){
  if(!obj||typeof obj[key]!=="function"||isPatched(obj,key)) return false;
  try{
    addUnpatch(patcher.instead(key,obj,(args,orig)=>{try{return cb(args,orig);}catch(e){logError(label||key,e);return orig(...args);}}));
    markPatched(obj,key);return true;
  }catch(e){logError(`patchInstead:${label||key}`,e);return false;}
}
function settingForCapability(group){
  return group==="emoji"?"unlockEmojiPicker":group==="sticker"?"unlockStickerPicker":group==="stream"?"unlockStreamQuality":group==="theme"?"unlockClientThemes":group==="appIcon"?"unlockPremiumAppIcons":"unlockSoundboard";
}
function patchCapability(prop,group){
  const modules=safeFindAllByProp(prop);
  let n=0;
  for(const mod of modules){
    if(!mod||typeof mod[prop]!=="function"||isPatched(mod,prop)) continue;
    const setting=settingForCapability(group);
    if(patchInstead(mod,prop,(args,orig)=>storage[setting]?true:orig(...args),`cap:${prop}`)) n++;
  }
  if(n) diag.capabilityPatches[prop]=(diag.capabilityPatches[prop]||0)+n;
  return n;
}
function patchCapabilities(){
  for(const [group,props] of Object.entries(CAPABILITIES)) for(const p of props) patchCapability(p,group);
}
function patchMessageActions(){
  const mods=[];
  const direct=safeFindByProps("sendMessage","editMessage");if(direct)mods.push(direct);
  try{const all=M?.findByPropsAll?.("sendMessage");if(Array.isArray(all))mods.push(...all);}catch{}
  for(const mod of [...new Set(mods)]){
    if(!mod||typeof mod.sendMessage!=="function") continue;
    let did=false;
    if(patchBefore(mod,"sendMessage",args=>{
      const channelId=String(args?.[0]??locateMessageObject(args)?.channel_id??"");
      const msg=locateMessageObject(args);const opts=locateStickerOptions(args);
      transformOutgoing(channelId,msg,opts);
      return args;
    },"sendMessage")){diag.sendPatches++;did=true;}
    if(typeof mod.editMessage==="function"&&patchBefore(mod,"editMessage",args=>{
      const channelId=String(args?.[0]??locateMessageObject(args)?.channel_id??"");
      const msg=locateMessageObject(args);
      if(msg&&typeof msg.content==="string") msg.content=transformRawEmojiSyntax(msg.content,channelId);
      return args;
    },"editMessage")){diag.editPatches++;did=true;}
    if(did)diag.messageActions++;
    MessageActions=MessageActions||mod;
  }
}
function patchAvailabilityStore(store,kind){
  if(!store)return;
  const enabled=()=>kind==="emoji"?storage.unlockEmojiPicker:kind==="sticker"?storage.unlockStickerPicker:storage.unlockSoundboard;
  const candidates=kind==="emoji"
    ?["getCustomEmojiById","getGuildEmoji","getGuildEmojis","getGuildEmojiForEmojiPicker","getAllGuildEmoji"]
    :kind==="sticker"
      ?["getStickerById","getStickersByGuildId","getGuildStickers","getStickersForGuild"]
      :["getSoundById","getSoundsForGuild","getSoundboardSounds","getGuildSounds"];
  for(const key of candidates){
    if(typeof store[key]!=="function"||isPatched(store,key))continue;
    if(patchAfter(store,key,(args,ret)=>enabled()?mapAvailability(ret):ret,`${kind}Availability:${key}`))diag.availabilityPatches++;
  }
}
function discoverStores(){
  EmojiStore=EmojiStore||safeFindStore("EmojiStore")||safeFindByProps("getCustomEmojiById");
  StickersStore=StickersStore||safeFindStore("StickersStore")||safeFindStore("StickerStore")||safeFindByProps("getStickerById");
  ChannelStore=ChannelStore||safeFindStore("ChannelStore")||safeFindByProps("getChannel","getDMFromUserId");
  UserStore=UserStore||safeFindStore("UserStore")||safeFindByProps("getCurrentUser","getUser");
  PermissionStore=PermissionStore||safeFindStore("PermissionStore")||safeFindByProps("can","canManageUser");
  PermissionsBits=PermissionsBits||safeFindByProps("USE_EXTERNAL_EMOJIS","USE_EXTERNAL_STICKERS")||common?.constants?.PermissionsBits||null;
  diag.emojiStore=!!EmojiStore;diag.stickerStore=!!StickersStore;diag.channelStore=!!ChannelStore;diag.userStore=!!UserStore;diag.permissionStore=!!PermissionStore;
}
function patchStores(){
  patchAvailabilityStore(EmojiStore,"emoji");
  patchAvailabilityStore(StickersStore,"sticker");
  const sound=safeFindStore("SoundboardStore")||safeFindByProps("getSoundsForGuild");
  patchAvailabilityStore(sound,"soundboard");
}

function deepClonePlain(value,depth=0,seen=new WeakMap()){
  if(value==null||typeof value!=="object"||depth>8)return value;
  if(seen.has(value))return seen.get(value);
  if(Array.isArray(value)){
    const a=[];seen.set(value,a);
    for(const v of value)a.push(deepClonePlain(v,depth+1,seen));
    return a;
  }
  const out={};seen.set(value,out);
  for(const key of Object.keys(value)){
    const v=value[key];
    if(typeof v==="function")continue;
    out[key]=deepClonePlain(v,depth+1,seen);
  }
  return out;
}

function wrapperValue(v){
  if(v==null)return null;
  if(typeof v==="number"||typeof v==="string")return v;
  if(typeof v==="object"){
    if(v.value!==undefined)return v.value;
    if(v.value_!==undefined)return v.value_;
  }
  return null;
}

function getThemePresetId(appearance){
  const c=appearance?.clientThemeSettings||appearance?.client_theme_settings;
  return wrapperValue(
    c?.backgroundGradientPresetId ??
    c?.background_gradient_preset_id
  );
}

function hasThemeSelection(appearance){
  return getThemePresetId(appearance)!=null;
}

function searchProtoClassField(localName,protoClass){
  try{
    const field=protoClass?.fields?.find?.(f=>f?.localName===localName||f?.name===localName);
    if(!field)return null;
    const getter=Object.values(field).find(v=>typeof v==="function");
    return getter?.()||null;
  }catch{return null;}
}

function discoverThemeProto(){
  try{
    if(!PreloadedSettingsActions){
      const candidates=[
        safeFindByProps("getCurrentValue","ProtoClass"),
        safeFindByProps("ProtoClass","PreloadedUserSettingsActionCreators"),
        safeFindByProps("PreloadedUserSettingsActionCreators")
      ].filter(Boolean);

      for(const c of candidates){
        const x=c?.PreloadedUserSettingsActionCreators||c;
        if(x?.ProtoClass&&typeof x?.getCurrentValue==="function"){
          PreloadedSettingsActions=x;
          break;
        }
      }
    }

    if(PreloadedSettingsActions?.ProtoClass){
      AppearanceProtoClass=
        AppearanceProtoClass||
        searchProtoClassField("appearance",PreloadedSettingsActions.ProtoClass);

      ClientThemeProtoClass=
        ClientThemeProtoClass||
        searchProtoClassField("clientThemeSettings",AppearanceProtoClass);

      diag.themeProtoReady=!!(AppearanceProtoClass&&ClientThemeProtoClass);
    }
  }catch(e){
    logError("discoverThemeProto",e);
  }
}

function snapshotTheme(appearance){
  if(!appearance)return null;
  const presetId=getThemePresetId(appearance);
  if(presetId==null)return null;

  const theme=appearance?.theme;
  const snap={
    theme,
    presetId:Number(presetId),
    capturedAt:Date.now(),
    rawAppearance:appearance
  };

  localThemeRuntime=snap;
  storage.localThemePresetId=snap.presetId;
  if(theme!==undefined)storage.localThemeBase=theme;
  diag.themeCaptures++;
  return snap;
}

function storedThemeSnapshot(){
  if(localThemeRuntime?.presetId!=null)return localThemeRuntime;
  const id=Number(storage.localThemePresetId);
  if(!Number.isFinite(id))return null;
  return {
    theme:storage.localThemeBase,
    presetId:id,
    capturedAt:0,
    rawAppearance:null
  };
}

function buildThemeAppearance(baseAppearance,snap){
  if(!snap||snap.presetId==null)return baseAppearance;

  try{
    discoverThemeProto();

    if(AppearanceProtoClass?.create&&ClientThemeProtoClass?.create){
      const current=baseAppearance||{};
      const client=ClientThemeProtoClass.create({
        backgroundGradientPresetId:{value:snap.presetId}
      });

      return AppearanceProtoClass.create({
        ...current,
        ...(snap.theme!==undefined?{theme:snap.theme}:{}),
        clientThemeSettings:client
      });
    }
  }catch(e){
    logError("buildThemeAppearance(proto)",e);
  }

  // Fallback: preserve the actual object shape Discord already handed us.
  try{
    const out=baseAppearance
      ?Object.assign(Object.create(Object.getPrototypeOf(baseAppearance)),baseAppearance)
      :{};

    if(snap.theme!==undefined)out.theme=snap.theme;

    const existing=
      out.clientThemeSettings||
      out.client_theme_settings||
      snap.rawAppearance?.clientThemeSettings||
      snap.rawAppearance?.client_theme_settings||
      {};

    const client=Object.assign(
      Object.create(Object.getPrototypeOf(existing)||Object.prototype),
      existing
    );
    client.backgroundGradientPresetId={value:snap.presetId};
    out.clientThemeSettings=client;
    return out;
  }catch{
    return baseAppearance;
  }
}

function forceThemeIntoProto(proto){
  const snap=storedThemeSnapshot();
  if(!snap||!proto||typeof proto!=="object")return false;

  try{
    proto.appearance=buildThemeAppearance(proto.appearance,snap);
    return true;
  }catch(e){
    logError("forceThemeIntoProto",e);
    return false;
  }
}

function dispatchLocalTheme(reason="reapply"){
  if(themeInternalDispatch||!storage.unlockClientThemes||!storage.preserveLocalThemes)return false;
  const snap=storedThemeSnapshot();
  if(!snap||!FluxDispatcher?.dispatch)return false;

  try{
    discoverThemeProto();

    let proto=null;
    if(PreloadedSettingsActions?.ProtoClass?.create){
      proto=PreloadedSettingsActions.ProtoClass.create();
      proto.appearance=buildThemeAppearance(
        PreloadedSettingsActions?.getCurrentValue?.()?.appearance,
        snap
      );
    }else{
      proto={appearance:buildThemeAppearance(null,snap)};
    }

    themeInternalDispatch=true;
    FluxDispatcher.dispatch({
      type:"USER_SETTINGS_PROTO_UPDATE",
      local:true,
      partial:true,
      __kfnThemeInternal:true,
      settings:{type:1,proto}
    });
    diag.themeReapplies++;
    return true;
  }catch(e){
    logError(`dispatchLocalTheme:${reason}`,e);
    return false;
  }finally{
    themeInternalDispatch=false;
  }
}

function scheduleThemeReapply(){
  if(!storage.reapplyLocalTheme)return;
  try{clearTimeout(themeReapplyTimer)}catch{}
  themeReapplyTimer=setTimeout(()=>{
    themeReapplyTimer=null;
    dispatchLocalTheme("scheduled");
  },90);
  timers.push(themeReapplyTimer);
}

function markAppIconContext(ms=750){
  appIconContextUntil=Math.max(appIconContextUntil,Date.now()+ms);
  diag.appIconContextHits++;
}
function inAppIconContext(){
  return appIconContextDepth>0||Date.now()<appIconContextUntil;
}

function unlockAppIconObjects(value,depth=0,seen=new WeakMap()){
  if(!storage.patchAppIconObjects||value==null||depth>6)return value;
  if(typeof value!=="object")return value;
  if(seen.has(value))return seen.get(value);

  if(Array.isArray(value)){
    let changed=false;
    const out=value.slice();seen.set(value,out);
    for(let i=0;i<out.length;i++){
      const n=unlockAppIconObjects(out[i],depth+1,seen);
      if(n!==out[i]){out[i]=n;changed=true;}
    }
    return changed?out:value;
  }

  const keys=Object.keys(value);
  const looksIcon=
    keys.some(k=>/icon/i.test(k))||
    ["premium","isPremium","locked","available","disabled","requiresPremium"].some(k=>k in value);

  if(!looksIcon)return value;

  let out=value;
  let changed=false;
  const set=(key,val)=>{
    if(!(key in value)||value[key]===val)return;
    if(out===value)out=Object.assign(Object.create(Object.getPrototypeOf(value)),value);
    out[key]=val;changed=true;
  };

  set("premium",false);
  set("isPremium",false);
  set("requiresPremium",false);
  set("locked",false);
  set("disabled",false);
  set("available",true);

  if(changed)diag.appIconObjectPatches++;
  return out;
}

function patchAppIconRuntime(){
  let found=0;

  const registerModule=(mod)=>{
    if(!mod||appIconModules.has(mod))return;
    appIconModules.add(mod);
    diag.appIconModules++;
    found++;

    for(const key of APP_ICON_CURRENT_GETTERS){
      if(typeof mod[key]!=="function")continue;
      if(!diag.appIconGetters.includes(key))diag.appIconGetters.push(key);

      patchBefore(mod,key,args=>{
        markAppIconContext();
        appIconContextDepth++;
        globalThis.queueMicrotask?.(()=>{appIconContextDepth=Math.max(0,appIconContextDepth-1);});
        return args;
      },`appIconContext:${key}`);
    }

    for(const key of APP_ICON_SETTERS){
      if(typeof mod[key]!=="function")continue;
      if(!diag.appIconSetters.includes(key))diag.appIconSetters.push(key);

      patchBefore(mod,key,args=>{
        markAppIconContext(1500);
        return args;
      },`appIconSetter:${key}`);
    }

    for(const key of APP_ICON_LIST_GETTERS){
      if(typeof mod[key]!=="function")continue;
      patchAfter(mod,key,(args,ret)=>{
        if(!storage.unlockPremiumAppIcons)return ret;
        markAppIconContext();
        return unlockAppIconObjects(ret);
      },`appIconList:${key}`);
    }
  };

  for(const prop of [...APP_ICON_CURRENT_GETTERS,...APP_ICON_SETTERS,...APP_ICON_LIST_GETTERS]){
    for(const mod of safeFindAllByProp(prop))registerModule(mod);
  }

  // Vencord has a second premium gate specifically in the App Icon screen.
  // Runtime Kettu cannot source-patch that exact call, so only make isPremium
  // return true while an App Icon getter/setter is actively rendering/handling.
  if(storage.unlockAppIconPremiumGate){
    for(const mod of safeFindAllByProp("isPremium")){
      if(!mod||typeof mod.isPremium!=="function"||appIconPremiumModules.has(mod))continue;
      appIconPremiumModules.add(mod);

      if(patchInstead(mod,"isPremium",(args,orig)=>{
        if(storage.unlockPremiumAppIcons&&inAppIconContext())return true;
        return orig(...args);
      },"appIcon:isPremium")){
        diag.appIconPremiumPatches++;
      }
    }
  }

  return found;
}

function patchThemeLocalPersistence(){
  FluxDispatcher=FluxDispatcher||common?.FluxDispatcher||safeFindByProps("dispatch","subscribe");
  if(!FluxDispatcher?.dispatch||isPatched(FluxDispatcher,"dispatch"))return;

  discoverThemeProto();

  patchBefore(FluxDispatcher,"dispatch",args=>{
    if(!storage.unlockClientThemes||!storage.preserveLocalThemes)return args;

    const ev=args?.[0];
    if(!ev||ev.__kfnThemeInternal)return args;

    try{
      if(ev.type==="USER_SETTINGS_PROTO_UPDATE"){
        const proto=ev?.settings?.proto;
        const appearance=proto?.appearance;

        if(appearance&&hasThemeSelection(appearance)){
          // This is the actual user-selected Nitro gradient theme.
          snapshotTheme(appearance);
          ev.local=true;
          diag.localThemeEvents++;
          scheduleThemeReapply();
          return args;
        }

        // Discord's sync/save can immediately send back appearance without the
        // premium gradient. Keep our last local selection instead.
        if(proto&&storedThemeSnapshot()&&!ev.local){
          if(forceThemeIntoProto(proto)){
            ev.local=true;
            diag.themeRevertsBlocked++;
            scheduleThemeReapply();
          }
        }
      }

      if(ev.type==="CONNECTION_OPEN"){
        const proto=ev?.userSettingsProto||ev?.user_settings_proto;
        if(proto&&storedThemeSnapshot()){
          if(forceThemeIntoProto(proto)){
            diag.themeRevertsBlocked++;
            scheduleThemeReapply();
          }
        }
      }
    }catch(e){
      logError("themeDispatch",e);
    }

    return args;
  },"USER_SETTINGS_PROTO_UPDATE");
}
function scanAndPatch(){
  diag.scans++;
  try{
    discoverStores();
    patchMessageActions();
    patchCapabilities();
    patchStores();
    patchThemeLocalPersistence();
    patchAppIconRuntime();
  }catch(e){logError("scanAndPatch",e);}
}
function statusText(){
  const cap=Object.entries(diag.capabilityPatches).sort().map(([k,v])=>`${k}: ${v}`).join("\n")||"Henüz capability bulunamadı";
  return [
    `Tarama: ${diag.scans}`,
    `MessageActions: ${diag.messageActions?"OK":"YOK"} (send ${diag.sendPatches}, edit ${diag.editPatches})`,
    `EmojiStore: ${diag.emojiStore?"OK":"YOK"}`,
    `StickerStore: ${diag.stickerStore?"OK":"YOK"}`,
    `ChannelStore: ${diag.channelStore?"OK":"YOK"}`,
    `UserStore: ${diag.userStore?"OK":"YOK"}`,
    `PermissionStore: ${diag.permissionStore?"OK":"YOK"}`,
    `Availability patch: ${diag.availabilityPatches}`,
    `Emoji link dönüşümü: ${diag.emojiTransforms}`,
    `Sticker link dönüşümü: ${diag.stickerTransforms}`,
    `Yerel tema olayı: ${diag.localThemeEvents}`,
    `Tema seçim yakalama: ${diag.themeCaptures}`,
    `Tema reapply: ${diag.themeReapplies}`,
    `Tema revert engeli: ${diag.themeRevertsBlocked}`,
    `Tema proto: ${diag.themeProtoReady?"OK":"fallback"}`,
    `App Icon modülü: ${diag.appIconModules}`,
    `App Icon premium gate: ${diag.appIconPremiumPatches}`,
    `App Icon obje unlock: ${diag.appIconObjectPatches}`,
    `App Icon context hit: ${diag.appIconContextHits}`,
    `App Icon getter: ${diag.appIconGetters.join(", ")||"-"}`,
    `App Icon setter: ${diag.appIconSetters.join(", ")||"-"}`,
    `--- capability patchleri ---`,cap,
    diag.lastError?`Son hata: ${diag.lastError}`:""
  ].filter(Boolean).join("\n");
}
function Settings(){
  if(!React||!RN?.View||!RN?.Text)return null;
  const [,force]=React.useReducer(x=>x+1,0);
  const View=RN.View,Text=RN.Text,ScrollView=RN.ScrollView||RN.View,Switch=RN.Switch,Pressable=RN.Pressable||RN.TouchableOpacity||RN.View,TextInput=RN.TextInput;
  const set=(k,v)=>{storage[k]=v;force();};
  const styles={root:{padding:16,paddingBottom:40,gap:12},title:{fontSize:22,fontWeight:"700",color:"#f2f3f5"},sub:{fontSize:13,color:"#b5bac1",lineHeight:18},card:{padding:12,borderRadius:12,backgroundColor:"#2b2d31",marginBottom:10},head:{fontSize:17,fontWeight:"700",color:"#f2f3f5",marginBottom:4},row:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingVertical:9},label:{fontSize:15,color:"#f2f3f5",flex:1,paddingRight:12},small:{fontSize:12,color:"#b5bac1",lineHeight:17},btn:{paddingVertical:10,paddingHorizontal:12,borderRadius:8,backgroundColor:"#404249",marginTop:7},btnOn:{backgroundColor:"#5865f2"},btnText:{color:"#fff",fontWeight:"600",textAlign:"center"},mono:{fontFamily:"monospace",fontSize:11,color:"#b5bac1",lineHeight:16},input:{backgroundColor:"#1e1f22",borderRadius:8,paddingHorizontal:10,paddingVertical:9,color:"#f2f3f5",marginTop:7}};
  const row=(label,k,desc)=>React.createElement(View,{style:styles.row},React.createElement(View,{style:{flex:1,paddingRight:10}},React.createElement(Text,{style:styles.label},label),desc?React.createElement(Text,{style:styles.small},desc):null),Switch?React.createElement(Switch,{value:!!storage[k],onValueChange:v=>set(k,v)}):null);
  const button=(label,onPress,on)=>React.createElement(Pressable,{onPress,style:[styles.btn,on&&styles.btnOn]},React.createElement(Text,{style:styles.btnText},label));
  const sizeButtons=(key)=>React.createElement(View,null,
    React.createElement(Text,{style:styles.small},`Boyut: ${storage[key]}px`),
    React.createElement(View,{style:{flexDirection:"row",flexWrap:"wrap",gap:6,marginTop:5}},...SIZES.map(n=>React.createElement(Pressable,{key:String(n),onPress:()=>set(key,n),style:[styles.btn,{paddingVertical:7,paddingHorizontal:9,marginTop:0},Number(storage[key])===n&&styles.btnOn]},React.createElement(Text,{style:styles.btnText},String(n)))))
  );
  return React.createElement(ScrollView,{contentContainerStyle:styles.root},
    React.createElement(Text,{style:styles.title},"Kettu FakeNitro v1.2.0"),
    React.createElement(Text,{style:styles.sub},"Kettu için mobil FakeNitro portu. Sunucu tarafında gerçek Nitro vermez; kilitli emoji/stickerları gerektiğinde Discord CDN bağlantısına çevirir ve istemci tarafı Nitro arayüz kontrollerini açmayı dener."),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Emoji"),
      row("Fake emoji gönderimi","enableEmojiBypass","Kullanamadığın custom emojiyi CDN bağlantısına çevirir."),
      row("Emoji seçiciyi aç","unlockEmojiPicker","Animated/external/premium istemci kontrollerini açar."),
      row("Harici emojiyi linke zorla","forceExternalEmojiLinks","Nitro yoksa başka sunucu emojilerini güvenli fallback ile yollar."),
      sizeButtons("emojiSize")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Sticker"),
      row("Fake sticker gönderimi","enableStickerBypass","Kilitli stickerı media.discordapp.net bağlantısına çevirir."),
      row("Sticker seçiciyi aç","unlockStickerPicker","Unavailable/premium istemci kontrollerini açmayı dener."),
      row("Unavailable stickerı linke çevir","forceUnavailableStickerLinks"),
      sizeButtons("stickerSize")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Vencord tarzı link"),
      row("Markdown hyperlink kullan","useHyperLinks","Kapalıysa ham CDN URL gönderilir; embed açısından daha garantici olabilir."),
      TextInput?React.createElement(TextInput,{style:styles.input,value:String(storage.hyperLinkText||""),placeholder:"{{NAME}}",placeholderTextColor:"#80848e",onChangeText:t=>set("hyperLinkText",t)}):null,
      React.createElement(Text,{style:[styles.small,{marginTop:6}]},"{{NAME}} emoji/sticker adıyla değiştirilir.")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Nitro arayüzleri"),
      row("HD yayın / stream quality menüsü","unlockStreamQuality","1080p/60fps ve benzeri client kalite kontrollerini açmayı dener."),
      row("Nitro temaları","unlockClientThemes","Client theme/gradient kontrollerini açar."),
      row("Temayı yerelde koru","preserveLocalThemes","Seçilen gradient temayı Discord sync geri çevirmeye çalışsa bile yerelde korur."),
      row("Tema geri dönerse yeniden uygula","reapplyLocalTheme","Tema seçiminden ve ayar sync'inden sonra yerel protoyu yeniden uygular."),
      button("Kaydedilen Nitro temasını tekrar uygula",()=>{dispatchLocalTheme("manual");force();}),
      button("Kaydedilen tema kilidini temizle",()=>{localThemeRuntime=null;delete storage.localThemePresetId;delete storage.localThemeBase;force();}),
      row("Premium uygulama ikonları","unlockPremiumAppIcons","App Icon ekranındaki capability kontrollerini açar."),
      row("App Icon ikinci premium kapısını aç","unlockAppIconPremiumGate","Sadece App Icon ekranı/aksiyonu aktifken Discord isPremium kontrolünü true yapar."),
      row("App Icon seçenek kilitlerini kaldır","patchAppIconObjects","App Icon listelerindeki locked/premium/disabled alanlarını yerel olarak açar."),
      row("Soundboard erişimi","unlockSoundboard","Unavailable sound istemci kontrollerini açmayı dener.")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Uyumluluk"),
      row("Unavailable nesneleri UI'da available göster","patchAvailabilityObjects","Emoji/sticker/sound seçicilerinde gri kilitleri azaltır."),
      button("Modülleri yeniden tara",()=>{scanAndPatch();force();}),
      React.createElement(Text,{style:[styles.small,{marginTop:8}]},"Discord bazı modülleri ekran açılana kadar yüklemez. Özellikle App Icon ekranını bir kez açıp buraya dönerek \"Modülleri yeniden tara\"ya bas. Tanılamada App Icon getter/setter isimleri görünürse ikinci premium kapısı da yakalanmıştır.")
    ),
    React.createElement(View,{style:styles.card},
      React.createElement(Text,{style:styles.head},"Tanılama"),
      React.createElement(Text,{style:styles.mono},statusText()),
      button("Sayaçları yenile",()=>force())
    )
  );
}
function onLoad(){
  initDefaults();
  scanAndPatch();
  // Discord RN lazily loads a lot of modules. Re-scan a few times so opening the
  // plugin immediately after app start still finds message/premium modules.
  for(const ms of [1200,4000,9000]) timers.push(setTimeout(()=>scanAndPatch(),ms));
  logInfo("loaded",statusText());
}
function onUnload(){
  try{if(themeReapplyTimer)clearTimeout(themeReapplyTimer)}catch{}
  themeReapplyTimer=null;
  while(timers.length){try{clearTimeout(timers.pop());}catch{}}
  while(unpatches.length){try{unpatches.pop()?.();}catch{}}
  appIconModules.clear();
  appIconPremiumModules.clear();
  logInfo("unloaded");
}
return {onLoad,onUnload,settings:Settings,__test:{
  getThemePresetId,snapshotTheme,storedThemeSnapshot,forceThemeIntoProto,
  unlockAppIconObjects,markAppIconContext,inAppIconContext,scanAndPatch,diag
}};
})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils)
