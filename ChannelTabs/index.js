(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";
/* Kettu ChannelTabs v3.1.0 - global Chrome-like persistent top tabs for Discord mobile */
const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};
const unpatches=[];
const timers=[];
const listeners=new Set();

let ChannelStore=null,SelectedChannelStore=null,UserStore=null,GuildStore=null,ReadStateStore=null;
let ChannelRouter=null,Nav=null,Flux=null,LazyActionSheet=null,ActionSheetRow=null;
let rootInstalled=false,rootHookName="",sheetInstalled=false,watcher=null,lastObservedId="",navIntent=null;
let rootChoice=null,rootRank=999,rootBypass=0,globalRootSeen=false;
const rootRefs=new Set(),rootWrappers=new WeakMap(),fallbackPatched=new Set();

const diag={
 root:false,rootHook:"",sheet:false,navigation:false,watcher:false,globalRoot:false,fallbackRoots:0,jsxHooks:0,
 observed:0,newTabs:0,replaced:0,closed:0,recent:0,renders:0,lastError:""
};

function err(where,e){
 diag.lastError=`${where}: ${e?.message||e}`;
 try{logger?.error?.(diag.lastError,e)}catch{}
}
function toast(s){try{ui?.showToast?.(String(s))}catch{}}
function emit(){for(const fn of [...listeners]){try{fn()}catch{}}}
function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}
function uid(){return `kct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`}

function defaults(){
 if(!Array.isArray(storage.tabs))storage.tabs=[];
 if(!Array.isArray(storage.recent))storage.recent=[];
 const d={
  enabled:true,
  maxTabs:8,
  maxRecent:20,
  defaultOpenMode:"current",
  showClose:true,
  showUnread:true,
  showMentions:true,
  showPlus:true,
  showRecents:true,
  compact:false,
  haptic:true,
  statusBarSpacing:true,
  longPressActions:true,
  restoreTabs:true,
  focusExistingOnNew:true
 };
 for(const[k,v]of Object.entries(d))if(storage[k]===undefined)storage[k]=v;
 migrate();
}

function migrate(){
 const seen=new Set();
 storage.tabs=(storage.tabs||[]).map(t=>{
  const channelId=String(t?.channelId||t?.id||"");
  if(!channelId||seen.has(channelId))return null;
  seen.add(channelId);
  return {
   uid:String(t?.uid||uid()),channelId,
   guildId:t?.guildId||t?.guild_id||null,
   name:t?.name||"Kanal",type:t?.type??null,
   kind:t?.kind||null,lastVisited:Number(t?.lastVisited||Date.now())
  };
 }).filter(Boolean).slice(-20);
 if(storage.activeTabUid && !storage.tabs.some(t=>t.uid===storage.activeTabUid))storage.activeTabUid=null;
 storage.recent=(storage.recent||[]).map(r=>({
  channelId:String(r?.channelId||r?.id||""),guildId:r?.guildId||r?.guild_id||null,
  name:r?.name||"Kanal",type:r?.type??null,kind:r?.kind||null,lastVisited:Number(r?.lastVisited||Date.now())
 })).filter(r=>r.channelId);
}

function currentId(){
 try{return String(SelectedChannelStore?.getChannelId?.()||SelectedChannelStore?.getLastSelectedChannelId?.()||"")}catch{return ""}
}
function channel(id){try{return ChannelStore?.getChannel?.(String(id))||null}catch{return null}}
function guildName(id){try{return GuildStore?.getGuild?.(String(id))?.name||""}catch{return ""}}
function user(id){try{return UserStore?.getUser?.(String(id))||null}catch{return null}}
function currentChannel(){const id=currentId();return id?channel(id):null}

function dmUser(c){
 if(!c)return null;
 const ids=Array.isArray(c.recipients)?c.recipients:[];
 return ids.length===1?user(ids[0]):null;
}
function kindOf(c){
 if(!c)return "channel";
 if(!c.guild_id&&!c.guildId){
  if(Number(c.type)===3||(c.recipients?.length||0)>1)return "group";
  return "dm";
 }
 return "channel";
}
function nameOf(c){
 if(!c)return "Kanal";
 const k=kindOf(c);
 if(k==="dm"){
  const u=dmUser(c);
  return u?.globalName||u?.global_name||u?.username||c.name||"DM";
 }
 if(k==="group"){
  if(c.name)return c.name;
  const names=(c.recipients||[]).map(id=>user(id)?.globalName||user(id)?.username).filter(Boolean);
  return names.slice(0,3).join(", ")||"Grup DM";
 }
 return c.name||"Kanal";
}
function descriptor(c){
 if(!c?.id)return null;
 return {
  channelId:String(c.id),guildId:c.guild_id||c.guildId||null,
  name:nameOf(c),type:c.type??null,kind:kindOf(c),lastVisited:Date.now()
 };
}
function tabFrom(c){const d=descriptor(c);return d?{uid:uid(),...d}:null}
function tabIcon(t){return t?.kind==="dm"?"@":t?.kind==="group"?"◉":"#"}
function activeIndex(){
 const tabs=storage.tabs||[];
 let i=tabs.findIndex(t=>t.uid===storage.activeTabUid);
 if(i<0&&tabs.length)i=tabs.length-1;
 return i;
}
function activeTab(){const i=activeIndex();return i>=0?storage.tabs[i]:null}
function setTabs(tabs){storage.tabs=tabs.slice(0,Math.max(1,Math.min(30,Number(storage.maxTabs)||8)));emit()}
function setActive(uidValue){storage.activeTabUid=uidValue||null;emit()}

function rememberRecent(c){
 if(!c?.id)return;
 const d=descriptor(c);if(!d)return;
 const max=Math.max(1,Math.min(100,Number(storage.maxRecent)||20));
 storage.recent=[d,...(storage.recent||[]).filter(r=>r.channelId!==d.channelId)].slice(0,max);
 diag.recent++;emit();
}
function clearRecent(){storage.recent=[];emit()}

function addNewTab(c,activate=true,navigate=false){
 if(!c?.id)return null;
 const cid=String(c.id);
 if(storage.focusExistingOnNew){
  const ex=(storage.tabs||[]).find(t=>t.channelId===cid);
  if(ex){
   if(activate)setActive(ex.uid);
   if(navigate)goTab(ex);
   rememberRecent(c);
   return ex;
  }
 }
 let tabs=[...(storage.tabs||[])];
 const max=Math.max(1,Math.min(30,Number(storage.maxTabs)||8));
 if(tabs.length>=max){
  const ai=activeIndex();
  const removeIndex=ai===0&&tabs.length>1?1:0;
  tabs.splice(removeIndex,1);
 }
 const t=tabFrom(c);if(!t)return null;
 tabs.push(t);storage.tabs=tabs;
 if(activate)storage.activeTabUid=t.uid;
 diag.newTabs++;rememberRecent(c);emit();
 if(navigate)goTab(t);
 return t;
}

function replaceActive(c,navigate=false){
 if(!c?.id)return null;
 let tabs=[...(storage.tabs||[])];
 let i=activeIndex();
 if(i<0)return addNewTab(c,true,navigate);
 const old=tabs[i];
 const d=descriptor(c);if(!d)return null;
 tabs[i]={...old,...d,uid:old.uid};
 storage.tabs=tabs;storage.activeTabUid=old.uid;
 diag.replaced++;rememberRecent(c);emit();
 if(navigate)goTab(tabs[i]);
 return tabs[i];
}

function openChannel(c,mode,navigate=true){
 if(!c?.id)return;
 if(mode==="new")addNewTab(c,true,navigate);
 else replaceActive(c,navigate);
}

function closeTab(uidValue){
 let tabs=[...(storage.tabs||[])];
 const i=tabs.findIndex(t=>t.uid===uidValue);if(i<0)return;
 const wasActive=tabs[i].uid===storage.activeTabUid;
 tabs.splice(i,1);storage.tabs=tabs;diag.closed++;
 if(wasActive){
  const next=tabs[Math.min(i,tabs.length-1)]||tabs[tabs.length-1]||null;
  storage.activeTabUid=next?.uid||null;
  emit();
  if(next)goTab(next);
 }else emit();
}
function closeOthers(uidValue){
 const t=(storage.tabs||[]).find(x=>x.uid===uidValue);if(!t)return;
 storage.tabs=[t];storage.activeTabUid=t.uid;emit();
}
function closeRight(uidValue){
 const tabs=[...(storage.tabs||[])];const i=tabs.findIndex(t=>t.uid===uidValue);if(i<0)return;
 storage.tabs=tabs.slice(0,i+1);if(!storage.tabs.some(t=>t.uid===storage.activeTabUid))storage.activeTabUid=uidValue;emit();
}

function haptic(){if(!storage.haptic)return;try{RN.Vibration?.vibrate?.(12)}catch{}}
function unreadInfo(id){
 let mentions=0,unread=false;
 try{mentions=Number(ReadStateStore?.getMentionCount?.(String(id))||0)}catch{}
 try{unread=!!ReadStateStore?.hasUnread?.(String(id))}catch{}
 return {mentions,unread};
}

function navigateTo(channelId,guildId){
 try{
  const id=String(channelId);const gid=guildId||channel(id)?.guild_id||channel(id)?.guildId||null;
  if(typeof ChannelRouter?.transitionToChannel==="function"){
   ChannelRouter.transitionToChannel(id);diag.navigation=true;return true;
  }
  if(typeof Nav?.transitionToGuild==="function"){
   Nav.transitionToGuild(gid?String(gid):"@me",id);diag.navigation=true;return true;
  }
  if(typeof Nav?.transitionTo==="function"){
   Nav.transitionTo(`/channels/${gid||"@me"}/${id}`);diag.navigation=true;return true;
  }
  throw new Error("Navigation API bulunamadı");
 }catch(e){err("navigate",e);toast("Kanal açılamadı");return false}
}
function goTab(t){
 if(!t?.channelId)return;
 storage.activeTabUid=t.uid;
 t.lastVisited=Date.now();
 storage.tabs=[...(storage.tabs||[])];
 navIntent={channelId:String(t.channelId),uid:t.uid,expires:Date.now()+2500};
 emit();haptic();navigateTo(t.channelId,t.guildId);
}

function observeCurrent(force=false){
 try{
  const id=currentId();if(!id)return;
  if(!force&&id===lastObservedId)return;
  const c=channel(id);if(!c)return;
  lastObservedId=id;diag.observed++;rememberRecent(c);

  if(navIntent&&Date.now()>navIntent.expires)navIntent=null;
  if(navIntent&&navIntent.channelId===id){
   const t=(storage.tabs||[]).find(x=>x.uid===navIntent.uid);
   if(t){storage.activeTabUid=t.uid;t.lastVisited=Date.now();storage.tabs=[...storage.tabs]}
   navIntent=null;emit();return;
  }

  const a=activeTab();
  if(!a){addNewTab(c,true,false);return}
  if(a.channelId===id){a.lastVisited=Date.now();storage.tabs=[...storage.tabs];emit();return}

  if(storage.defaultOpenMode==="new")addNewTab(c,true,false);
  else replaceActive(c,false);
 }catch(e){err("observe",e)}
}

function discover(){
 try{ChannelStore=M.findByStoreName?.("ChannelStore")}catch{}
 try{SelectedChannelStore=M.findByStoreName?.("SelectedChannelStore")||M.findByProps?.("getChannelId","getVoiceChannelId")}catch{}
 try{UserStore=M.findByStoreName?.("UserStore")}catch{}
 try{GuildStore=M.findByStoreName?.("GuildStore")}catch{}
 try{ReadStateStore=M.findByStoreName?.("ReadStateStore")||M.findByProps?.("getMentionCount","hasUnread")}catch{}
 try{ChannelRouter=M.findByProps?.("transitionToChannel","transitionToThread")||M.findByProps?.("transitionToChannel")}catch{}
 try{Nav=M.findByProps?.("transitionTo","transitionToGuild")||M.findByProps?.("transitionToGuild")}catch{}
 try{Flux=M.findByProps?.("dispatch","subscribe")}catch{}
 try{LazyActionSheet=M.findByProps?.("openLazy","hideActionSheet")}catch{}
 try{ActionSheetRow=M.findByProps?.("ActionSheetRow")?.ActionSheetRow||common?.ActionSheetRow||ui?.components?.FormRow}catch{}
}

function useRefresh(){
 const[,force]=React.useReducer(x=>x+1,0);
 React.useEffect(()=>subscribe(force),[]);
 return force;
}

function TabsBar(){
 if(!React||!RN.View||!RN.Text||!storage.enabled)return null;
 useRefresh();diag.renders++;
 const V=RN.View,T=RN.Text,P=RN.Pressable||RN.TouchableOpacity||V,SV=RN.ScrollView||V;
 const tabs=storage.tabs||[],active=storage.activeTabUid;
 const topPad=storage.statusBarSpacing&&RN.Platform?.OS==="android"?Number(RN.StatusBar?.currentHeight||0):0;
 const compact=!!storage.compact;
 const s={
  outer:{paddingTop:topPad,backgroundColor:"#111214",borderBottomWidth:1,borderBottomColor:"#26272b"},
  row:{height:compact?38:46,flexDirection:"row",alignItems:"stretch"},
  sc:{paddingLeft:6,paddingTop:5,gap:4,alignItems:"flex-end"},
  tab:{height:compact?31:39,minWidth:86,maxWidth:190,flexDirection:"row",alignItems:"center",paddingHorizontal:9,borderTopLeftRadius:10,borderTopRightRadius:10,backgroundColor:"#1e1f22",borderWidth:1,borderColor:"#2b2d31",borderBottomWidth:0},
  on:{backgroundColor:"#313338",borderColor:"#3f4147"},
  icon:{color:"#b5bac1",fontSize:compact?12:14,marginRight:5,fontWeight:"700"},
  tx:{color:"#dbdee1",fontSize:compact?11:13,flexShrink:1,flexGrow:1},
  txOn:{color:"#ffffff",fontWeight:"600"},
  dot:{width:6,height:6,borderRadius:3,backgroundColor:"#f2f3f5",marginLeft:5},
  badge:{minWidth:17,height:17,borderRadius:9,paddingHorizontal:4,alignItems:"center",justifyContent:"center",backgroundColor:"#f23f42",marginLeft:5},
  badgeTx:{color:"#fff",fontSize:10,fontWeight:"700"},
  close:{paddingLeft:7,paddingVertical:4},
  closeTx:{color:"#949ba4",fontSize:16,lineHeight:17},
  plus:{width:42,alignItems:"center",justifyContent:"center",borderLeftWidth:1,borderLeftColor:"#26272b"},
  plusTx:{color:"#dbdee1",fontSize:23,fontWeight:"300"},
  empty:{paddingHorizontal:10,justifyContent:"center"},
  emptyTx:{color:"#949ba4",fontSize:12}
 };

 const tabEls=tabs.map(t=>{
  const info=unreadInfo(t.channelId);const is=t.uid===active;
  return React.createElement(P,{key:t.uid,onPress:()=>goTab(t),onLongPress:()=>openTabMenu(t),style:[s.tab,is&&s.on]},
   React.createElement(T,{style:s.icon},tabIcon(t)),
   React.createElement(T,{numberOfLines:1,style:[s.tx,is&&s.txOn]},t.name||nameOf(channel(t.channelId))),
   storage.showMentions&&info.mentions>0?React.createElement(V,{style:s.badge},React.createElement(T,{style:s.badgeTx},info.mentions>99?"99+":String(info.mentions))):
    storage.showUnread&&info.unread?React.createElement(V,{style:s.dot}):null,
   storage.showClose?React.createElement(P,{onPress:e=>{try{e?.stopPropagation?.()}catch{};closeTab(t.uid);haptic()},hitSlop:8,style:s.close},React.createElement(T,{style:s.closeTx},"×")):null
  );
 });

 return React.createElement(V,{style:s.outer,__kctTopBar:true},
  React.createElement(V,{style:s.row},
   React.createElement(SV,{horizontal:true,showsHorizontalScrollIndicator:false,contentContainerStyle:s.sc,style:{flex:1}},
    ...(tabEls.length?tabEls:[React.createElement(V,{key:"empty",style:s.empty},React.createElement(T,{style:s.emptyTx},"Sekme yok • + ile aç"))])
   ),
   storage.showPlus?React.createElement(P,{onPress:openRecentSheet,onLongPress:()=>{const c=currentChannel();if(c)addNewTab(c,true,false)},style:s.plus},React.createElement(T,{style:s.plusTx},"+")):null
  )
 );
}

function RootShell({content,global=false}){
 if(!storage.enabled)return content;
 if(global){globalRootSeen=true;diag.globalRoot=true;}
 const V=RN.View;
 if(!V)return React.createElement(React.Fragment,null,React.createElement(TabsBar),content);
 // Real layout row, not a floating ActionSheet/Modal. It permanently reserves
 // space at the top so Discord cannot draw over the tabs during navigation.
 return React.createElement(V,{style:{flex:1,backgroundColor:"#111214"},__kctRoot:true},
  React.createElement(TabsBar),
  React.createElement(V,{style:{flex:1,minHeight:0},__kctDiscordContent:true},content)
 );
}

function typeName(type){
 try{return String(type?.displayName||type?.name||type?.render?.displayName||type?.render?.name||"")}catch{return ""}
}
function discoverRootRefs(){
 const add=(x)=>{if(x&&(typeof x==="function"||typeof x==="object"))rootRefs.add(x)};
 for(const prop of [
  "NavigationContainer","BaseNavigationContainer","SafeAreaProvider","GestureHandlerRootView",
  "AppNavigationContainer","AppNavigationContainerOrEmpty","PortalProviderComponent",
  "RootThemeContextProvider","BackgroundOrForegroundApp"
 ]){
  try{const m=M.findByProps?.(prop);add(m?.[prop])}catch{}
 }
}
function candidateRank(type,props){
 if(rootRefs.has(type)){
  const n=typeName(type);
  if(/NavigationContainer|AppNavigationContainer/i.test(n))return 1;
  if(/BackgroundOrForegroundApp|AppContainer/i.test(n))return 2;
  if(/SafeAreaProvider|GestureHandlerRootView|PortalProvider/i.test(n))return 4;
  return 3;
 }
 const n=typeName(type);
 if(!n)return 999;
 if(/^(NavigationContainer|BaseNavigationContainer|NavigationContainerInner|AppNavigationContainer|AppNavigationContainerOrEmpty)$/i.test(n))return 1;
 if(/^(App|AppRoot|Root|RootComponent|DiscordApp|BackgroundOrForegroundApp|AppContainer|RootNavigator|RootStack|RootStackNavigator)$/i.test(n))return 2;
 if(/^(RootThemeContextProvider|PortalProviderComponent|GestureWrapper|AccessibilityPreferencesContextProvider)$/i.test(n))return 3;
 if(/SafeAreaProvider|GestureHandlerRootView|SafeAreaWrapper/i.test(n))return 4;
 if(/^(StackNavigator|NativeStackNavigator|ChatPanelNativeStackNavigator|LaunchPadContainer)$/i.test(n))return 5;
 if(/^(MainTabs|TabsNavigator|MainTabsNavigator|MainTabsNavigatorPanel|MainTabsChannelScreenStack)$/i.test(n))return 7;
 if(props&&typeof props==="object"){
  let score=0;
  if("onReady" in props)score++;
  if("onStateChange" in props)score++;
  if("initialState" in props)score++;
  if("linking" in props)score++;
  if("theme" in props)score++;
  if(score>=3)return 2;
 }
 return 999;
}
function chooseRoot(type,rank){
 if(!type||rank>=999)return;
 if(!rootChoice||rank<rootRank){
  rootChoice=type;rootRank=rank;rootInstalled=true;
  rootHookName=`global:${typeName(type)||"anonymous"}@${rank}`;
  diag.root=true;diag.rootHook=rootHookName;emit();
 }
}
function wrapperFor(type){
 if(rootWrappers.has(type))return rootWrappers.get(type);
 const Original=type;
 function KettuChannelTabsGlobalRoot(props){
  let child;
  rootBypass++;
  try{child=React.createElement(Original,props)}finally{rootBypass--}
  if(rootChoice!==Original)return child;
  return React.createElement(RootShell,{content:child,global:true});
 }
 KettuChannelTabsGlobalRoot.displayName=`KettuChannelTabsGlobal_${typeName(type)||"Root"}`;
 rootWrappers.set(type,KettuChannelTabsGlobalRoot);
 return KettuChannelTabsGlobalRoot;
}
function inspectElementArgs(args){
 try{
  if(rootBypass>0||!storage.enabled)return;
  const type=args?.[0],props=args?.[1];
  if(!type||type===RootShell||type===TabsBar)return;
  const n=typeName(type);
  if(/^KettuChannelTabs/.test(n))return;
  const rank=candidateRank(type,props);
  if(rank>=999)return;
  chooseRoot(type,rank);
  // Only replace the chosen exact type. Lower-quality candidates keep rendering
  // untouched, preventing nested duplicate tab bars.
  if(rootChoice===type)args[0]=wrapperFor(type);
 }catch(e){err("inspectRoot",e)}
}
function installGlobalElementHooks(){
 try{
  discoverRootRefs();
  if(React&&typeof React.createElement==="function"){
   unpatches.push(patcher.before("createElement",React,inspectElementArgs));diag.jsxHooks++;
  }
  const jsx=M.findByProps?.("jsx","jsxs");
  if(jsx){for(const m of ["jsx","jsxs"]){if(typeof jsx[m]==="function"){unpatches.push(patcher.before(m,jsx,inspectElementArgs));diag.jsxHooks++;}}}
  const dev=M.findByProps?.("jsxDEV");
  if(typeof dev?.jsxDEV==="function"){unpatches.push(patcher.before("jsxDEV",dev,inspectElementArgs));diag.jsxHooks++;}
  return diag.jsxHooks>0;
 }catch(e){err("globalHooks",e);return false}
}
function patchFallbackScreen(name){
 if(fallbackPatched.has(name))return false;
 try{
  // Named-export modules can be patched directly.
  const named=M.findByProps?.(name);
  if(named&&typeof named[name]==="function"){
   fallbackPatched.add(name);
   unpatches.push(patcher.after(name,named,(_,res)=>{
    try{
     if(!storage.enabled||globalRootSeen||res?.props?.__kctRoot)return res;
     diag.root=true;diag.rootHook=`fallback:${name}`;rootHookName=diag.rootHook;
     return React.createElement(RootShell,{content:res,global:false});
    }catch(e){err(`fallback:${name}`,e);return res}
   }));
   diag.fallbackRoots++;emit();return true;
  }
  // Some Discord modules expose a default export object instead.
  const mod=M.findByName?.(name,false);
  if(mod&&typeof mod.default==="function"){
   fallbackPatched.add(name);
   unpatches.push(patcher.after("default",mod,(_,res)=>{
    try{
     if(!storage.enabled||globalRootSeen||res?.props?.__kctRoot)return res;
     diag.root=true;diag.rootHook=`fallback:${name}`;rootHookName=diag.rootHook;
     return React.createElement(RootShell,{content:res,global:false});
    }catch(e){err(`fallback:${name}`,e);return res}
   }));
   diag.fallbackRoots++;emit();return true;
  }
  // Class components are patchable through prototype.render even when findByName
  // returns the component itself.
  if(typeof mod==="function"&&typeof mod.prototype?.render==="function"){
   fallbackPatched.add(name);
   unpatches.push(patcher.after("render",mod.prototype,(_,res)=>{
    try{
     if(!storage.enabled||globalRootSeen||res?.props?.__kctRoot)return res;
     diag.root=true;diag.rootHook=`fallback:${name}`;rootHookName=diag.rootHook;
     return React.createElement(RootShell,{content:res,global:false});
    }catch(e){err(`fallback:${name}`,e);return res}
   }));
   diag.fallbackRoots++;emit();return true;
  }
 }catch(e){err(`patchFallback:${name}`,e)}
 return false;
}
function installRoot(){
 discoverRootRefs();
 if(diag.jsxHooks===0)installGlobalElementHooks();
 // Names seen in real Discord Android component stacks, highest-level first.
 // We try broad app/navigation roots before chat-only screens so the strip stays
 // present in settings, DMs, guild channels and other routes.
 const primary=[
  "BackgroundOrForegroundApp","App","AppContainer","AppNavigationContainerOrEmpty",
  "AppNavigationContainer","NavigationContainerInner","RootThemeContextProvider",
  "PortalProviderComponent","GestureWrapper","SafeAreaWrapper"
 ];
 let primaryPatched=false;
 for(const n of primary){if(patchFallbackScreen(n)){primaryPatched=true;break}}
 if(!primaryPatched){
  for(const n of [
   "StackNavigator","NativeStackNavigator","ChatPanelNativeStackNavigator","LaunchPadContainer",
   "MainTabs","MainTabsNavigatorPanel","MainTabsChannelScreenStack","TabsNavigator",
   "FirstChannelScreen","StandaloneChannelScreen","SettingsOverviewScreen",
   "UserSettingsOverviewScreen","SettingsScreen","ChannelScreen","Messages"
  ]){
   if(patchFallbackScreen(n))break;
  }
 }
}
function sheetHide(key){try{LazyActionSheet?.hideActionSheet?.(key)}catch{try{LazyActionSheet?.hideActionSheet?.()}catch{}}}
function openSheet(key,Comp){
 try{
  LazyActionSheet=LazyActionSheet||M.findByProps?.("openLazy","hideActionSheet");
  if(!LazyActionSheet?.openLazy)throw new Error("ActionSheet bulunamadı");
  LazyActionSheet.openLazy(Promise.resolve({default:Comp}),key,{});
 }catch(e){err("openSheet",e);toast("Menü açılamadı")}
}

function RecentSheet(){
 useRefresh();
 const V=RN.View,T=RN.Text,SV=RN.ScrollView||V,P=RN.Pressable||RN.TouchableOpacity||V;
 const recents=storage.showRecents?(storage.recent||[]):[];
 const s={root:{padding:16,paddingBottom:28,gap:8},h:{fontSize:21,fontWeight:"700",color:"#f2f3f5"},sub:{fontSize:12,color:"#b5bac1",marginBottom:5},row:{flexDirection:"row",alignItems:"center",padding:10,borderRadius:10,backgroundColor:"#2b2d31",gap:8},info:{flex:1},name:{color:"#f2f3f5",fontSize:15,fontWeight:"600"},meta:{color:"#949ba4",fontSize:11,marginTop:2},btn:{paddingVertical:7,paddingHorizontal:9,borderRadius:7,backgroundColor:"#404249"},newBtn:{backgroundColor:"#5865f2"},bt:{color:"#fff",fontSize:12,fontWeight:"600"},empty:{color:"#949ba4",fontSize:13,padding:12}};
 return React.createElement(SV,{contentContainerStyle:s.root},
  React.createElement(T,{style:s.h},"Yeni Sekme"),
  React.createElement(T,{style:s.sub},"Son açtığın kanal veya DM'yi bu sekmede aç ya da yeni bir sekme oluştur."),
  ...(recents.length?recents.map(r=>{
   const c=channel(r.channelId);const label=c?nameOf(c):r.name;
   return React.createElement(V,{key:r.channelId,style:s.row},
    React.createElement(V,{style:s.info},React.createElement(T,{style:s.name,numberOfLines:1},`${r.kind==="dm"?"@":r.kind==="group"?"◉":"#"} ${label}`),React.createElement(T,{style:s.meta,numberOfLines:1},r.guildId?guildName(r.guildId)||"Sunucu kanalı":"DM")),
    React.createElement(P,{style:s.btn,onPress:()=>{if(c){sheetHide("kct-recent");openChannel(c,"current",true)}}},React.createElement(T,{style:s.bt},"Bu sekme")),
    React.createElement(P,{style:[s.btn,s.newBtn],onPress:()=>{if(c){sheetHide("kct-recent");openChannel(c,"new",true)}}},React.createElement(T,{style:s.bt},"Yeni"))
   )
  }):[React.createElement(T,{key:"empty",style:s.empty},"Henüz son kanal yok.")])
 );
}
function openRecentSheet(){haptic();openSheet("kct-recent",RecentSheet)}

function TabMenuSheetFactory(tab){
 return function TabMenuSheet(){
  const V=RN.View,T=RN.Text,P=RN.Pressable||RN.TouchableOpacity||V;
  const s={root:{padding:16,paddingBottom:28,gap:8},h:{fontSize:20,fontWeight:"700",color:"#fff",marginBottom:4},b:{padding:12,borderRadius:9,backgroundColor:"#2b2d31"},danger:{backgroundColor:"#3b2428"},bt:{color:"#fff",fontSize:14,fontWeight:"600"}};
  const act=(label,fn,danger)=>React.createElement(P,{style:[s.b,danger&&s.danger],onPress:()=>{sheetHide("kct-tab-menu");fn()}},React.createElement(T,{style:s.bt},label));
  return React.createElement(V,{style:s.root},React.createElement(T,{style:s.h},tab.name||"Sekme"),
   act("Bu sekmeyi yeniden aç",()=>goTab(tab)),
   act("Aynı kanalı yeni sekmede aç",()=>{const c=channel(tab.channelId);if(c){const old=storage.focusExistingOnNew;storage.focusExistingOnNew=false;addNewTab(c,true,true);storage.focusExistingOnNew=old}}),
   act("Diğer sekmeleri kapat",()=>closeOthers(tab.uid)),
   act("Sağdaki sekmeleri kapat",()=>closeRight(tab.uid)),
   act("Sekmeyi kapat",()=>closeTab(tab.uid),true)
  );
 }
}
function openTabMenu(tab){haptic();openSheet("kct-tab-menu",TabMenuSheetFactory(tab))}

function findRows(root){
 const seen=new WeakSet();let budget=1600;
 function walk(v,d){
  if(v==null||d>12||budget--<0)return null;
  if(Array.isArray(v)&&v.some(x=>x?.props&&typeof x.props.onPress==="function"))return v;
  if(typeof v!=="object")return null;if(seen.has(v))return null;seen.add(v);
  for(const k of Object.keys(v)){if(typeof v[k]==="function")continue;const r=walk(v[k],d+1);if(r)return r}
  return null;
 }
 return walk(root,0);
}
function dmForUser(userId){
 try{
  const r=ChannelStore?.getDMFromUserId?.(String(userId));
  if(typeof r==="string")return channel(r);if(r?.id)return r;
 }catch{}
 try{
  const all=ChannelStore?.getMutablePrivateChannels?.()||ChannelStore?.getPrivateChannels?.();
  const vals=all instanceof Map?[...all.values()]:Array.isArray(all)?all:Object.values(all||{});
  return vals.find(c=>Array.isArray(c?.recipients)&&c.recipients.includes(String(userId)))||null;
 }catch{return null}
}
function resolveSheetChannel(props){
 let c=props?.channel||props?.channelRecord||null;
 if(!c){const id=props?.channelId||props?.channel_id||props?.channel?.id;if(id)c=channel(id)}
 if(!c&&props?.user?.id)c=dmForUser(props.user.id);
 if(!c&&props?.recipient?.id)c=dmForUser(props.recipient.id);
 return c?.id?c:null;
}
function installLongPressSheet(){
 if(sheetInstalled||!storage.longPressActions)return;
 try{
  LazyActionSheet=LazyActionSheet||M.findByProps?.("openLazy","hideActionSheet");
  ActionSheetRow=ActionSheetRow||M.findByProps?.("ActionSheetRow")?.ActionSheetRow||common?.ActionSheetRow||ui?.components?.FormRow;
  if(!LazyActionSheet?.openLazy||!ActionSheetRow)return;
  unpatches.push(patcher.before("openLazy",LazyActionSheet,([component,key,props])=>{
   try{
    if(!storage.longPressActions||String(key||"").startsWith("kct-")||/MessageLongPress/i.test(String(key||"")))return;
    const c=resolveSheetChannel(props);if(!c?.id||!component?.then)return;
    component.then(mod=>{
     if(typeof mod?.default!=="function")return;
     const u=patcher.after("default",mod,(_,tree)=>{
      setTimeout(()=>{try{u()}catch{}},0);
      const rows=findRows(tree);if(!rows||rows.some(r=>r?.props?.__kctOpenMode))return;
      const newRow=React.createElement(ActionSheetRow,{key:"kct-new",__kctOpenMode:true,label:"↗ Yeni sekmede aç",onPress:()=>{sheetHide(key);openChannel(c,"new",true)}});
      const curRow=React.createElement(ActionSheetRow,{key:"kct-current",__kctOpenMode:true,label:"↪ Bu sekmede aç",onPress:()=>{sheetHide(key);openChannel(c,"current",true)}});
      rows.splice(Math.min(1,rows.length),0,newRow,curRow);
     });
    }).catch?.(()=>{});
   }catch(e){err("longPressSheet",e)}
  }));
  sheetInstalled=true;diag.sheet=true;emit();
 }catch(e){err("installSheet",e)}
}

function installWatcher(){
 if(watcher)return;
 watcher=setInterval(()=>observeCurrent(false),350);diag.watcher=true;
 if(Flux&&typeof Flux.dispatch==="function"){
  unpatches.push(patcher.after("dispatch",Flux,([a])=>{
   const type=String(a?.type||"");
   if(/CHANNEL|GUILD|NAVIGAT|CONNECTION_OPEN|READY/.test(type))setTimeout(()=>observeCurrent(false),20);
  }));
 }
 timers.push(setTimeout(()=>observeCurrent(true),700));
}

function Settings(){
 if(!React||!RN.View||!RN.Text)return null;
 const[,force]=React.useReducer(x=>x+1,0);React.useEffect(()=>subscribe(force),[]);
 const V=RN.View,T=RN.Text,SV=RN.ScrollView||V,Sw=RN.Switch,I=RN.TextInput,P=RN.Pressable||RN.TouchableOpacity||V;
 const S=(k,v)=>{storage[k]=v;emit()};
 const s={root:{padding:16,paddingBottom:30,gap:10},h:{fontSize:22,fontWeight:"700",color:"#fff"},c:{padding:12,borderRadius:10,backgroundColor:"#2b2d31",gap:9},t:{fontSize:15,color:"#fff",flex:1},sub:{fontSize:12,color:"#b5bac1"},row:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},inp:{backgroundColor:"#1e1f22",color:"#fff",padding:9,borderRadius:7},b:{padding:10,borderRadius:7,backgroundColor:"#404249"},bo:{backgroundColor:"#5865f2"},danger:{backgroundColor:"#3b2428"},bt:{color:"#fff",textAlign:"center",fontWeight:"600",fontSize:13}};
 const row=(label,k)=>React.createElement(V,{style:s.row},React.createElement(T,{style:s.t},label),Sw&&React.createElement(Sw,{value:!!storage[k],onValueChange:v=>S(k,v)}));
 const btn=(label,fn,on,danger)=>React.createElement(P,{onPress:fn,style:[s.b,on&&s.bo,danger&&s.danger]},React.createElement(T,{style:s.bt},label));
 const c=currentChannel();
 return React.createElement(SV,{contentContainerStyle:s.root},
  React.createElement(T,{style:s.h},"ChannelTabs"),
  React.createElement(V,{style:s.c},
   row("Üst sekme çubuğu aktif","enabled"),row("Sekmede × göster","showClose"),row("Okunmamış noktası","showUnread"),row("Mention sayısı","showMentions"),row("+ düğmesi","showPlus"),row("Son kanalları göster","showRecents"),row("Kompakt sekmeler","compact"),row("Dokununca titreşim","haptic"),row("Kanal/DM uzun basma seçenekleri","longPressActions"),row("Android durum çubuğu boşluğu","statusBarSpacing")
  ),
  React.createElement(V,{style:s.c},
   React.createElement(T,{style:s.t},"Normal kanal/DM'ye dokununca"),
   btn("Bu sekmede aç",()=>S("defaultOpenMode","current"),storage.defaultOpenMode==="current"),
   btn("Yeni sekmede aç",()=>S("defaultOpenMode","new"),storage.defaultOpenMode==="new"),
   React.createElement(T,{style:s.sub},"Uzun basma menüsünde iki seçenek de ayrıca bulunur.")
  ),
  React.createElement(V,{style:s.c},
   React.createElement(T,{style:s.t},"Maksimum açık sekme"),
   I&&React.createElement(I,{style:s.inp,value:String(storage.maxTabs),keyboardType:"numeric",onChangeText:v=>S("maxTabs",v)}),
   React.createElement(T,{style:s.t},"Son kanal sayısı"),
   I&&React.createElement(I,{style:s.inp,value:String(storage.maxRecent),keyboardType:"numeric",onChangeText:v=>S("maxRecent",v)})
  ),
  React.createElement(V,{style:s.c},
   btn(c?`Şu anki kanalı yeni sekmede aç: ${nameOf(c)}`:"Şu anki kanal bulunamadı",()=>{if(c)addNewTab(c,true,false)}),
   btn("Son kanallar menüsünü aç",openRecentSheet),
   btn("Tüm açık sekmeleri kapat",()=>{storage.tabs=[];storage.activeTabUid=null;emit()},false,true),
   btn("Son kanalları temizle",clearRecent,false,true)
  ),
  React.createElement(V,{style:s.c},
   React.createElement(T,{style:s.t},"Açık sekmeler"),
   ...((storage.tabs||[]).length?(storage.tabs||[]).map(t=>React.createElement(V,{key:t.uid,style:s.row},React.createElement(T,{style:s.sub,numberOfLines:1},`${tabIcon(t)} ${t.name}`),React.createElement(P,{onPress:()=>closeTab(t.uid)},React.createElement(T,{style:{color:"#f23f42"}},"Kapat")))):[React.createElement(T,{key:"none",style:s.sub},"Sekme yok.")])
  ),
  React.createElement(V,{style:s.c},React.createElement(T,{style:s.sub},`Üst UI: ${diag.root?"OK":"YOK"} (${diag.rootHook||"aranıyor"}) | Global: ${diag.globalRoot?"OK":"bekliyor"} | Fallback ${diag.fallbackRoots} | JSX hook ${diag.jsxHooks}\nUzun basma: ${diag.sheet?"OK":"YOK"} | İzleyici: ${diag.watcher?"OK":"YOK"} | Navigation: ${diag.navigation?"OK":"bekliyor"}\nGözlenen ${diag.observed} | Yeni ${diag.newTabs} | Değişen ${diag.replaced} | Kapanan ${diag.closed}${diag.lastError?`\nSon hata: ${diag.lastError}`:""}`))
 );
}

function onLoad(){
 defaults();discover();installRoot();installLongPressSheet();installWatcher();
 for(const ms of [1200,3500,7000])timers.push(setTimeout(()=>{discover();installRoot();installLongPressSheet();observeCurrent(true)},ms));
}
function onUnload(){
 if(watcher)clearInterval(watcher);watcher=null;
 for(const t of timers)clearTimeout(t);timers.length=0;
 while(unpatches.length){try{unpatches.pop()?.()}catch{}}
 listeners.clear();rootInstalled=false;sheetInstalled=false;rootChoice=null;rootRank=999;globalRootSeen=false;rootRefs.clear();fallbackPatched.clear();
}

return {onLoad,onUnload,settings:Settings,__test:{kindOf,nameOf,descriptor,tabFrom,unreadInfo,candidateRank,typeName}};
})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils);
