"use strict";
const fs=require("fs"),vm=require("vm"),assert=require("assert");
function patcher(){return{before(k,o,cb){const x=o[k];o[k]=function(...a){const r=cb(a);return x.apply(this,Array.isArray(r)?r:a)};return()=>o[k]=x},after(k,o,cb){const x=o[k];o[k]=function(...a){const r=x.apply(this,a),n=cb(a,r);return n===undefined?r:n};return()=>o[k]=x},instead(k,o,cb){const x=o[k];o[k]=function(...a){const self=this;return cb.call(self,a,(...z)=>x.apply(self,z.length?z:a))};return()=>o[k]=x}}}
const messages=new Map(),sent=[];
const Flux={subscribe(){},dispatch(a){if(a.type==="MESSAGE_CREATE")messages.set(`${a.message.channel_id}:${a.message.id}`,a.message);else if(a.type==="MESSAGE_UPDATE")messages.set(`${a.channelId||a.message.channel_id}:${a.message.id}`,a.message);else if(a.type==="MESSAGE_DELETE")messages.delete(`${a.channelId}:${a.id}`);return a}};
const MessageActions={sendMessage(ch,msg,opt={}){sent.push({ch,msg:JSON.parse(JSON.stringify(msg)),opt:JSON.parse(JSON.stringify(opt))});return true},editMessage(){},startEditMessage(){}};
const emojis={"111":{id:"111",name:"foreign",animated:false,guildId:"g2",available:true,type:1}};
const EmojiStore={getCustomEmojiById:id=>emojis[id]||null,getGuildEmojis:()=>Object.values(emojis)};
const StickerStore={getStickerById:()=>null,getGuildStickers:()=>[]};
const ChannelStore={getChannel:id=>({id,guild_id:"g1",isPrivate:()=>false}),emitChange(){}};
const UserStore={getCurrentUser:()=>({id:"me",premiumType:0}),getUser:()=>({id:"me",premiumType:0})};
const PermissionStore={can:()=>true};const PermissionsBits={USE_EXTERNAL_EMOJIS:1n,USE_EXTERNAL_STICKERS:2n};
const caps={canUseEmojisEverywhere:()=>false,canUseAnimatedEmojis:()=>false,canUseExternalEmojis:()=>false,canUseCustomStickersEverywhere:()=>false,canUseExternalStickers:()=>false,canUseHighVideoUploadQuality:()=>false,canStreamQuality:()=>false,canUseClientThemes:()=>false,canUsePremiumAppIcons:()=>false,canUseSoundboardEverywhere:()=>false};
const MessageStore={getMessage:(ch,id)=>messages.get(`${ch}:${id}`),emitChange(){}};
class RowManager{generate(row){return {messageId:row.message.id,body:{content:row.message.content,style:{}},message:{id:row.message.id,content:row.message.content}}}invalidateMessage(){}}
const modules=[Flux,MessageActions,EmojiStore,StickerStore,ChannelStore,UserStore,PermissionStore,PermissionsBits,caps];const stores={EmojiStore,StickersStore:StickerStore,StickerStore,ChannelStore,UserStore,PermissionStore,MessageStore};const names={RowManager};
const common={React:null,ReactNative:{processColor:x=>x,StyleSheet:{flatten:x=>x}},FluxDispatcher:Flux,constants:{PermissionsBits}};
const metro={common,findByProps:(...ps)=>modules.find(m=>m&&ps.every(p=>p in m))||null,findByPropsAll:(...ps)=>modules.filter(m=>m&&ps.every(p=>p in m)),findByStoreName:n=>stores[n]||null,findByName:n=>names[n]||null};
const v={metro,patcher:patcher(),plugin:{storage:{}},logger:{log(){},error(){}},ui:{showToast(){},components:{}},utils:{}};
const ctx={vendetta:v,console,setTimeout:(f)=>{f();return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){},URL,Map,Set,WeakMap,WeakSet,Date,Array,Object,String,Number,Math,JSON,RegExp,Promise,Uint8Array,Error};ctx.globalThis=ctx;
function load(path,storage){v.plugin.storage=storage;return vm.runInNewContext(fs.readFileSync(path,"utf8"),ctx,{filename:path})}
const fakeStorage={},mlStorage={};
const fake=load(__dirname+"/FakeNitro/index.js",fakeStorage);fake.onLoad();
const ml=load(__dirname+"/MessageLogger/index.js",mlStorage);ml.onLoad();
MessageActions.sendMessage("c",{content:"<:foreign:111>",validNonShortcutEmojis:[emojis["111"]]},{});assert(sent.at(-1).msg.content.includes("cdn.discordapp.com/emojis/111"),"FakeNitro send transform broke");
const m={id:"m1",channel_id:"c",content:"hello",author:{id:"u",username:"Bob"},attachments:[]};Flux.dispatch({type:"MESSAGE_CREATE",message:m});Flux.dispatch({type:"MESSAGE_DELETE",channelId:"c",id:"m1"});const kept=messages.get("c:m1");assert(kept,"MessageLogger lost deleted message with FakeNitro loaded");const row=new RowManager().generate({message:kept});assert(JSON.stringify(row).includes("f04747"),"deleted message not red with FakeNitro loaded");
const e={id:"m2",channel_id:"c",content:"one",author:{id:"u",username:"Bob"},attachments:[]};Flux.dispatch({type:"MESSAGE_CREATE",message:e});const upd={...e,content:"two",edited_timestamp:"2026-09-08T20:00:00Z"};Flux.dispatch({type:"MESSAGE_UPDATE",channelId:"c",message:upd});Flux.dispatch({type:"MESSAGE_UPDATE",channelId:"c",message:upd});assert((messages.get("c:m2").content.match(/✎/g)||[]).length===1,"edit history lost/duplicated with FakeNitro loaded");
ml.onUnload();fake.onUnload();console.log("PASS cross-plugin: FakeNitro + MessageLogger v2.3");
