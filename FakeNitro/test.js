"use strict";
const fs=require("fs");
const vm=require("vm");
const assert=require("assert");

function makePatcher(){
  function before(key,obj,cb){const old=obj[key];obj[key]=function(...args){const out=cb(args);return old.apply(this,Array.isArray(out)?out:args)};return()=>{obj[key]=old;return true;};}
  function after(key,obj,cb){const old=obj[key];obj[key]=function(...args){const ret=old.apply(this,args);const out=cb(args,ret);return out===undefined?ret:out;};return()=>{obj[key]=old;return true;};}
  function instead(key,obj,cb){const old=obj[key];obj[key]=function(...args){return cb(args,(...x)=>old.apply(this,x));};return()=>{obj[key]=old;return true;};}
  return {before,after,instead};
}

function buildEnv(){
  const sent=[]; const edited=[];
  const MessageActions={
    sendMessage(channelId,msg,options={}){sent.push({channelId,msg:JSON.parse(JSON.stringify(msg)),options:JSON.parse(JSON.stringify(options))});return true;},
    editMessage(channelId,messageId,msg){edited.push({channelId,messageId,msg:JSON.parse(JSON.stringify(msg))});return true;}
  };
  const emojis={
    "111":{id:"111",name:"foreign",originalName:"foreign",animated:false,guildId:"g2",available:true,type:1},
    "112":{id:"112",name:"anim",originalName:"anim",animated:true,guildId:"g1",available:true,type:1},
    "113":{id:"113",name:"home",originalName:"home",animated:false,guildId:"g1",available:true,type:1},
    "114":{id:"114",name:"locked",originalName:"locked",animated:false,guildId:"g1",available:false,type:1}
  };
  const stickers={
    "201":{id:"201",name:"ForeignSticker",guild_id:"g2",available:false,format_type:1},
    "202":{id:"202",name:"PackSticker",pack_id:"pack",available:true,format_type:1},
    "203":{id:"203",name:"GifSticker",guild_id:"g2",available:false,format_type:4}
  };
  const EmojiStore={getCustomEmojiById:id=>emojis[String(id)]||null,getGuildEmojis:()=>Object.values(emojis)};
  const StickersStore={getStickerById:id=>stickers[String(id)]||null,getGuildStickers:()=>Object.values(stickers)};
  const ChannelStore={getChannel:id=>id==="dm"?{id,isPrivate:()=>true}:{id,guild_id:"g1",isPrivate:()=>false},getDMFromUserId:()=>null};
  const user={id:"me",premiumType:0};
  const UserStore={getCurrentUser:()=>user,getUser:()=>user};
  const PermissionStore={can:()=>true,canManageUser:()=>false};
  const PermissionsBits={USE_EXTERNAL_EMOJIS:1n,USE_EXTERNAL_STICKERS:2n};
  const caps={
    canUseEmojisEverywhere:()=>false,canUseAnimatedEmojis:()=>false,canUseExternalEmojis:()=>false,
    canUseCustomStickersEverywhere:()=>false,canUseExternalStickers:()=>false,
    canUseHighVideoUploadQuality:()=>false,canStreamQuality:()=>false,
    canUseClientThemes:()=>false,canUsePremiumAppIcons:()=>false,
    canUseSoundboardEverywhere:()=>false
  };
  const fluxEvents=[]; const FluxDispatcher={dispatch:e=>{fluxEvents.push(e);return e;}};
  const soundStore={getSoundsForGuild:()=>[{id:"s1",available:false}]};
  const modules=[MessageActions,EmojiStore,StickersStore,ChannelStore,UserStore,PermissionStore,PermissionsBits,caps,soundStore];
  const stores={EmojiStore,StickersStore,StickerStore:StickersStore,ChannelStore,UserStore,PermissionStore,SoundboardStore:soundStore};
  const metro={
    common:{React:null,ReactNative:{},FluxDispatcher,constants:{PermissionsBits}},
    findByProps(...props){return modules.find(m=>props.every(p=>p in m))||null;},
    findByPropsAll(...props){return modules.filter(m=>props.every(p=>p in m));},
    findByStoreName(name){return stores[name]||null;}
  };
  const storage={};
  const vendetta={metro,patcher:makePatcher(),plugin:{storage},logger:{log(){},error(){}},ui:{},utils:{}};
  return {vendetta,storage,MessageActions,EmojiStore,StickersStore,caps,user,sent,edited,FluxDispatcher,fluxEvents,soundStore};
}

function loadPlugin(env){
  const code=fs.readFileSync(__dirname+"/index.js","utf8");
  const context={vendetta:env.vendetta,console,setTimeout,clearTimeout,URL};
  const plugin=vm.runInNewContext(code,context,{filename:"index.js"});
  assert(plugin&&typeof plugin.onLoad==="function"&&typeof plugin.onUnload==="function","plugin export invalid");
  plugin.onLoad();
  return plugin;
}

function run(){
  const e=buildEnv();const p=loadPlugin(e);
  // 1. All requested capability UIs, including premium app icons, become available.
  assert.equal(e.caps.canUsePremiumAppIcons(),true,"app icon capability not unlocked");
  assert.equal(e.caps.canUseClientThemes(),true,"theme capability not unlocked");
  assert.equal(e.caps.canUseHighVideoUploadQuality(),true,"HD upload capability not unlocked");
  assert.equal(e.caps.canStreamQuality({},{}),true,"stream quality capability not unlocked");
  assert.equal(e.caps.canUseEmojisEverywhere(),true,"emoji capability not unlocked");
  assert.equal(e.caps.canUseCustomStickersEverywhere(),true,"sticker capability not unlocked");
  assert.equal(e.caps.canUseSoundboardEverywhere(),true,"soundboard capability not unlocked");

  // 2. Foreign emoji becomes a Vencord-style CDN hyperlink for a non-Nitro user.
  e.MessageActions.sendMessage("c1",{content:"hi <:foreign:111>",validNonShortcutEmojis:[{...e.EmojiStore.getCustomEmojiById("111")}]},{});
  assert(e.sent.at(-1).msg.content.includes("cdn.discordapp.com/emojis/111.webp"),"foreign emoji not transformed");
  assert(e.sent.at(-1).msg.content.includes("[foreign]("),"emoji is not hyperlink form");

  // 3. Same-guild static emoji remains native, matching FakeNitro intent.
  e.MessageActions.sendMessage("c1",{content:"<:home:113>",validNonShortcutEmojis:[{...e.EmojiStore.getCustomEmojiById("113")}]},{});
  assert.equal(e.sent.at(-1).msg.content,"<:home:113>","usable home emoji should stay native");

  // 4. Same-guild animated emoji falls back for non-Nitro, matching upstream behavior.
  e.MessageActions.sendMessage("c1",{content:"<a:anim:112>",validNonShortcutEmojis:[{...e.EmojiStore.getCustomEmojiById("112")}]},{});
  assert(e.sent.at(-1).msg.content.includes("/emojis/112.gif"),"animated emoji not transformed");

  // 5. Unavailable emoji gets availability marker for picker but still falls back on send.
  const locked=e.EmojiStore.getCustomEmojiById("114");
  assert.equal(locked.available,true,"unavailable emoji not exposed to picker");
  assert.equal(locked.__kfnOriginalAvailable,false,"original emoji availability marker lost");
  e.MessageActions.sendMessage("c1",{content:"<:locked:114>",validNonShortcutEmojis:[locked]},{});
  assert(e.sent.at(-1).msg.content.includes("/emojis/114.webp"),"unavailable emoji did not fall back");

  // 6. Edit path transforms raw custom emoji syntax too.
  e.MessageActions.editMessage("c1","m1",{content:"edit <:foreign:111>"});
  assert(e.edited.at(-1).msg.content.includes("/emojis/111.webp"),"edit emoji path not transformed");

  // 7. Locked sticker becomes link and stickerIds is cleared so server does not reject it.
  e.MessageActions.sendMessage("c1",{content:"sticker",validNonShortcutEmojis:[]},{stickerIds:["201"]});
  const st=e.sent.at(-1);
  assert(st.msg.content.includes("media.discordapp.net/stickers/201.png"),"sticker not transformed");
  assert.deepEqual(st.options.stickerIds,[],"stickerIds not cleared");

  // 8. GIF sticker uses gif URL.
  e.MessageActions.sendMessage("c1",{content:"",validNonShortcutEmojis:[]},{stickerIds:["203"]});
  assert(e.sent.at(-1).msg.content.includes("/stickers/203.gif"),"GIF sticker extension wrong");

  // 9. Official pack sticker is not fake-converted.
  e.MessageActions.sendMessage("c1",{content:"",validNonShortcutEmojis:[]},{stickerIds:["202"]});
  assert.deepEqual(e.sent.at(-1).options.stickerIds,["202"],"official pack sticker should remain native");

  // 10. Theme proto event is marked local for local client-theme persistence attempt.
  const evt={type:"USER_SETTINGS_PROTO_UPDATE",settings:{proto:{appearance:{clientThemeSettings:{backgroundGradientPresetId:1}}}}};
  e.FluxDispatcher.dispatch(evt);
  assert.equal(e.fluxEvents.at(-1).local,true,"client theme event not marked local");

  // 11. Toggle works dynamically without restart.
  e.storage.unlockPremiumAppIcons=false;
  assert.equal(e.caps.canUsePremiumAppIcons(),false,"app icon toggle does not restore original behavior");
  e.storage.enableEmojiBypass=false;
  e.MessageActions.sendMessage("c1",{content:"<:foreign:111>",validNonShortcutEmojis:[{id:"111",name:"foreign",guildId:"g2",type:1}]},{});
  assert.equal(e.sent.at(-1).msg.content,"<:foreign:111>","emoji bypass toggle ignored");

  // 12. Raw URL mode works and does not require markdown hyperlinks.
  e.storage.enableEmojiBypass=true;
  e.storage.useHyperLinks=false;
  e.MessageActions.sendMessage("c1",{content:"<:foreign:111>",validNonShortcutEmojis:[{id:"111",name:"foreign",guildId:"g2",available:true,type:1}]},{});
  assert(e.sent.at(-1).msg.content.includes("https://cdn.discordapp.com/emojis/111.webp"),"raw emoji URL mode broken");
  assert(!e.sent.at(-1).msg.content.includes("[foreign]("),"raw URL mode still emitted markdown");

  // 13. External static custom emoji in a DM still needs fallback for non-Nitro.
  e.MessageActions.sendMessage("dm",{content:"<:foreign:111>",validNonShortcutEmojis:[{id:"111",name:"foreign",guildId:"g2",available:true,type:1}]},{});
  assert(e.sent.at(-1).msg.content.includes("/emojis/111.webp"),"DM external emoji fallback broken");

  // 14. Real Nitro + allowed external permission keeps usable external emoji native.
  e.user.premiumType=2;
  e.storage.useHyperLinks=true;
  e.MessageActions.sendMessage("c1",{content:"<:foreign:111>",validNonShortcutEmojis:[{id:"111",name:"foreign",guildId:"g2",available:true,type:1}]},{});
  assert.equal(e.sent.at(-1).msg.content,"<:foreign:111>","real Nitro usable emoji should remain native");

  // 15. Availability patch exposes locked stickers but preserves original state marker.
  const exposedSticker=e.StickersStore.getStickerById("201");
  assert.equal(exposedSticker.available,true,"sticker picker availability not exposed");
  assert.equal(exposedSticker.__kfnOriginalAvailable,false,"sticker original availability marker lost");

  // 16. Unload restores patched methods.
  p.onUnload();
  assert.equal(e.caps.canUseClientThemes(),false,"unload did not restore capability");
  assert.equal(e.caps.canStreamQuality(),false,"unload did not restore stream capability");

  // 17. Missing/lazy modules must not crash the plugin.
  const minimal={
    metro:{common:{React:null,ReactNative:{},FluxDispatcher:{dispatch:x=>x}},findByProps:()=>null,findByPropsAll:()=>[],findByStoreName:()=>null},
    patcher:makePatcher(),plugin:{storage:{}},logger:{log(){},error(){}},ui:{},utils:{}
  };
  const code=fs.readFileSync(__dirname+"/index.js","utf8");
  const minimalPlugin=vm.runInNewContext(code,{vendetta:minimal,console,setTimeout,clearTimeout,URL},{filename:"index.js"});
  assert.doesNotThrow(()=>minimalPlugin.onLoad(),"missing modules caused onLoad crash");
  assert.doesNotThrow(()=>minimalPlugin.onUnload(),"missing modules caused onUnload crash");
  return true;
}

if(require.main===module){run();console.log("PASS: Kettu FakeNitro mock integration tests");}
module.exports={run};
