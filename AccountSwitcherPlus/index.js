(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";

/*
 * Kettu AccountSwitcher+ v2.0.0
 * PC/Web style mobile account switcher.
 * - No PIN / no vault UI.
 * - Adds "Hesap Değiştir" directly below Discord's Logout row when possible.
 * - Automatically remembers accounts you use.
 * - Uses Discord's internal switchAccountToken.
 */

const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};

const ROW_KEY="BAY4LLY_ACCOUNT_SWITCHER";
const SHEET_KEY="bay4lly-account-switcher";
const unpatches=[];

let TokenManager=null;
let Auth=null;
let UserStore=null;
let Flux=null;
let ActionSheet=null;
let SettingConstants=null;
let CreateListModule=null;

let cryptoKeyPromise=null;
let captureTimer=null;

const diag={
 row:false,
 listPatch:false,
 tokenManager:false,
 auth:false,
 crypto:false,
 nativeImported:0,
 captured:0,
 switched:0,
 lastError:""
};

function err(where,e){
 diag.lastError=`${where}: ${e?.message||e}`;
 try{logger?.error?.(diag.lastError,e)}catch{}
}

function toast(text){
 try{ui?.showToast?.(String(text))}catch{}
}

function defaults(){
 if(!storage.quickAccounts || typeof storage.quickAccounts!=="object" || Array.isArray(storage.quickAccounts)){
  storage.quickAccounts={};
 }
 if(storage.version===undefined)storage.version=2;
 if(storage.autoRemember===undefined)storage.autoRemember=true;
}

function hasCrypto(){
 return !!globalThis.crypto?.subtle
  && typeof globalThis.crypto?.getRandomValues==="function"
  && typeof TextEncoder!=="undefined"
  && typeof TextDecoder!=="undefined";
}

function bytesToB64(bytes){
 let s="";
 for(const b of bytes)s+=String.fromCharCode(b);
 return btoa(s);
}

function b64ToBytes(s){
 return Uint8Array.from(atob(String(s||"")),c=>c.charCodeAt(0));
}

async function getCryptoKey(){
 if(cryptoKeyPromise)return cryptoKeyPromise;

 cryptoKeyPromise=(async()=>{
  if(!hasCrypto())throw new Error("Bu Discord/Kettu sürümünde WebCrypto bulunamadı");

  if(!storage.localAccountKey){
   const raw=crypto.getRandomValues(new Uint8Array(32));
   storage.localAccountKey=bytesToB64(raw);
   raw.fill(0);
  }

  return crypto.subtle.importKey(
   "raw",
   b64ToBytes(storage.localAccountKey),
   {name:"AES-GCM"},
   false,
   ["encrypt","decrypt"]
  );
 })();

 return cryptoKeyPromise;
}

async function encryptToken(token){
 const key=await getCryptoKey();
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const data=new TextEncoder().encode(String(token));
 try{
  const encrypted=new Uint8Array(
   await crypto.subtle.encrypt({name:"AES-GCM",iv},key,data)
  );
  return `k2:${bytesToB64(iv)}:${bytesToB64(encrypted)}`;
 }finally{
  data.fill(0);
  iv.fill(0);
 }
}

async function decryptToken(blob){
 const value=String(blob||"");
 if(!value.startsWith("k2:"))throw new Error("Bu hesap eski AccountSwitcher formatında. Hesaba bir kez yeniden giriş yap.");

 const [,iv64,data64]=value.split(":");
 const key=await getCryptoKey();
 const decrypted=await crypto.subtle.decrypt(
  {name:"AES-GCM",iv:b64ToBytes(iv64)},
  key,
  b64ToBytes(data64)
 );

 return new TextDecoder().decode(decrypted);
}

function avatarUrl(account,size=128){
 if(!account?.id || !account?.avatar)return null;
 const ext=String(account.avatar).startsWith("a_")?"gif":"png";
 return `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.${ext}?size=${size}`;
}

function normalizeAccount(user,tokenBlob){
 if(!user?.id)return null;
 return {
  id:String(user.id),
  username:String(user.username||"hesap"),
  displayName:String(user.globalName||user.global_name||user.displayName||user.username||"Hesap"),
  avatar:user.avatar||null,
  token:tokenBlob,
  savedAt:Date.now()
 };
}

function getCurrentId(){
 try{return String(UserStore?.getCurrentUser?.()?.id||"")}catch{return ""}
}

async function captureCurrent(silent=true){
 try{
  if(!storage.autoRemember)return null;

  const token=TokenManager?.getToken?.();
  const user=UserStore?.getCurrentUser?.();

  if(!token || !user?.id)return null;

  const old=storage.quickAccounts[String(user.id)];
  const encrypted=await encryptToken(token);

  storage.quickAccounts[String(user.id)]={
   ...normalizeAccount(user,encrypted),
   savedAt:old?.savedAt||Date.now(),
   lastSeen:Date.now()
  };

  diag.captured++;
  if(!silent)toast(`${user.globalName||user.username} hatırlandı`);
  return storage.quickAccounts[String(user.id)];
 }catch(e){
  err("captureCurrent",e);
  if(!silent)toast(`Hesap kaydedilemedi: ${e?.message||e}`);
  return null;
 }
}

function scheduleCapture(delay=500){
 if(captureTimer)clearTimeout(captureTimer);
 captureTimer=setTimeout(()=>{
  captureTimer=null;
  captureCurrent(true);
 },delay);
}

async function fetchUserForToken(token){
 try{
  const r=await fetch("https://discord.com/api/v9/users/@me",{
   headers:{Authorization:String(token)}
  });
  if(!r.ok)return null;
  return await r.json();
 }catch{
  return null;
 }
}

function tokenLooksPlausible(token){
 const s=String(token||"");
 return s.length>=30 && (
  s.startsWith("mfa.")
  || s.includes(".")
  || /^[A-Za-z0-9_\-]{40,}$/.test(s)
 );
}

async function importTokenMap(value){
 if(!value)return 0;

 let entries=[];

 if(value instanceof Map){
  entries=[...value.entries()];
 }else if(Array.isArray(value)){
  entries=value.map((v,i)=>[String(i),v]);
 }else if(typeof value==="object"){
  entries=Object.entries(value);
 }

 let imported=0;

 for(const [hint,raw] of entries.slice(0,20)){
  let token=null;
  let profile=null;

  if(typeof raw==="string"){
   token=raw;
  }else if(raw && typeof raw==="object"){
   token=raw.token||raw.authToken||raw.accessToken||null;
   profile=raw.user||raw.account||raw.profile||null;
  }

  if(!tokenLooksPlausible(token))continue;

  try{
   if(!profile?.id){
    profile=await fetchUserForToken(token);
   }

   if(!profile?.id && /^\d{10,25}$/.test(String(hint))){
    profile={
     id:String(hint),
     username:`Hesap ${String(hint).slice(-4)}`,
     global_name:null,
     avatar:null
    };
   }

   if(!profile?.id)continue;

   const id=String(profile.id);
   if(storage.quickAccounts[id]?.token)continue;

   const encrypted=await encryptToken(token);
   storage.quickAccounts[id]={
    ...normalizeAccount(profile,encrypted),
    savedAt:Date.now(),
    lastSeen:Date.now(),
    imported:true
   };
   imported++;
  }catch(e){
   err("importTokenMap",e);
  }
 }

 return imported;
}

async function tryImportDiscordAccounts(){
 let total=0;

 const candidates=[
  TokenManager,
  M.findByProps?.("getTokens"),
  M.findByProps?.("getAllTokens"),
  M.findByProps?.("getAccountTokens"),
  M.findByProps?.("getAccounts","getToken")
 ].filter(Boolean);

 const methods=["getTokens","getAllTokens","getAccountTokens","getStoredTokens"];

 for(const mod of candidates){
  for(const name of methods){
   if(typeof mod?.[name]!=="function")continue;
   try{
    const result=await Promise.resolve(mod[name]());
    total+=await importTokenMap(result);
   }catch{}
  }
 }

 diag.nativeImported+=total;
 return total;
}

async function switchTo(account){
 if(!account?.id)return;

 const current=getCurrentId();
 if(current===String(account.id)){
  toast("Zaten bu hesaptasın");
  try{ActionSheet?.hideActionSheet?.(SHEET_KEY)}catch{}
  return;
 }

 if(typeof Auth?.switchAccountToken!=="function"){
  throw new Error("Discord'un switchAccountToken modülü bulunamadı");
 }

 const token=await decryptToken(account.token);

 try{
  try{ActionSheet?.hideActionSheet?.(SHEET_KEY)}catch{}
  toast(`${account.displayName||account.username} hesabına geçiliyor…`);
  await Promise.resolve(Auth.switchAccountToken(token));
  diag.switched++;
  scheduleCapture(1800);
 }finally{
  // JavaScript string values cannot be zeroed reliably.
 }
}

function forgetAccount(id){
 const current=getCurrentId();
 if(String(id)===current){
  toast("Aktif hesabı unutamazsın");
  return false;
 }
 delete storage.quickAccounts[String(id)];
 return true;
}

async function beginAddAccount(){
 try{
  await captureCurrent(true);

  const Alerts=ui?.showConfirmationAlert
   ? ui
   : M.findByProps?.("showConfirmationAlert");

  const doLogout=async()=>{
   try{
    ActionSheet?.hideActionSheet?.(SHEET_KEY);
    if(typeof Auth?.logout!=="function")throw new Error("Discord logout modülü bulunamadı");
    await Promise.resolve(Auth.logout());
   }catch(e){
    err("beginAddAccount",e);
    toast(`Giriş ekranı açılamadı: ${e?.message||e}`);
   }
  };

  if(Alerts?.showConfirmationAlert){
   Alerts.showConfirmationAlert({
    title:"Başka hesap ekle",
    content:"Mevcut hesap hatırlandı. Şimdi giriş ekranında diğer hesabına giriş yap. Bundan sonra iki hesap arasında çıkış yapmadan geçebilirsin.",
    confirmText:"Giriş ekranına git",
    cancelText:"İptal",
    confirmColor:"brand",
    onConfirm:doLogout
   });
  }else{
   await doLogout();
  }
 }catch(e){
  err("beginAddAccount",e);
  toast(e?.message||e);
 }
}

function accountList(){
 const current=getCurrentId();
 return Object.values(storage.quickAccounts||{})
  .filter(a=>a?.id&&a?.token)
  .sort((a,b)=>{
   if(String(a.id)===current)return -1;
   if(String(b.id)===current)return 1;
   return Number(b.lastSeen||b.savedAt||0)-Number(a.lastSeen||a.savedAt||0);
  });
}

function AccountSwitcherSheet(){
 const [,force]=React.useReducer(x=>x+1,0);
 const [busy,setBusy]=React.useState(false);

 React.useEffect(()=>{
  let alive=true;
  (async()=>{
   await captureCurrent(true);
   await tryImportDiscordAccounts();
   if(alive)force();
  })();
  return()=>{alive=false};
 },[]);

 const V=RN.View;
 const T=RN.Text;
 const SV=RN.ScrollView||V;
 const P=RN.Pressable||RN.TouchableOpacity||V;
 const Img=RN.Image;
 const current=getCurrentId();
 const accounts=accountList();

 const st={
  root:{padding:16,paddingBottom:28,gap:10},
  header:{fontSize:22,fontWeight:"700",color:"#f2f3f5",marginBottom:2},
  sub:{fontSize:13,color:"#b5bac1",marginBottom:8},
  card:{
   flexDirection:"row",
   alignItems:"center",
   padding:12,
   borderRadius:12,
   backgroundColor:"#2b2d31",
   gap:12
  },
  active:{borderWidth:1,borderColor:"#23a55a"},
  avatar:{
   width:46,height:46,borderRadius:23,
   backgroundColor:"#1e1f22"
  },
  info:{flex:1,minWidth:0},
  name:{fontSize:16,fontWeight:"600",color:"#f2f3f5"},
  user:{fontSize:12,color:"#b5bac1",marginTop:2},
  badge:{fontSize:12,color:"#23a55a",marginTop:3,fontWeight:"600"},
  button:{
   paddingVertical:9,paddingHorizontal:12,
   borderRadius:8,backgroundColor:"#5865f2"
  },
  buttonMuted:{backgroundColor:"#404249"},
  buttonDanger:{backgroundColor:"#3b2a2d"},
  buttonText:{color:"#fff",fontWeight:"600",fontSize:13},
  add:{
   padding:13,borderRadius:10,
   backgroundColor:"#5865f2",marginTop:4
  },
  addText:{color:"#fff",fontSize:15,fontWeight:"700",textAlign:"center"},
  empty:{
   padding:14,borderRadius:10,
   backgroundColor:"#2b2d31"
  },
  emptyText:{color:"#b5bac1",fontSize:13,lineHeight:18}
 };

 const onSwitch=async(a)=>{
  if(busy)return;
  try{
   setBusy(true);
   await switchTo(a);
  }catch(e){
   err("switch",e);
   toast(`Hesap değiştirilemedi: ${e?.message||e}`);
  }finally{
   setBusy(false);
  }
 };

 return React.createElement(
  SV,{contentContainerStyle:st.root},

  React.createElement(T,{style:st.header},"Hesap Değiştir"),
  React.createElement(
   T,{style:st.sub},
   "Kayıtlı hesaplarından birine dokun. Aktif hesap yeşil işaretlidir."
  ),

  accounts.length===0
   ? React.createElement(
      V,{style:st.empty},
      React.createElement(
       T,{style:st.emptyText},
       "Henüz hesap bulunamadı. Mevcut hesabın otomatik olarak hatırlanmaya çalışılıyor."
      )
     )
   : accounts.map(a=>{
      const active=String(a.id)===current;
      const uri=avatarUrl(a);

      return React.createElement(
       V,{key:String(a.id),style:[st.card,active&&st.active]},

       uri&&Img
        ?React.createElement(Img,{source:{uri},style:st.avatar})
        :React.createElement(
          V,{style:[st.avatar,{alignItems:"center",justifyContent:"center"}]},
          React.createElement(T,{style:{color:"#fff",fontSize:18,fontWeight:"700"}},
           String(a.displayName||a.username||"?").slice(0,1).toUpperCase()
          )
         ),

       React.createElement(
        V,{style:st.info},
        React.createElement(T,{style:st.name},a.displayName||a.username),
        React.createElement(T,{style:st.user},`@${a.username}`),
        active?React.createElement(T,{style:st.badge},"● Şu an açık"):null
       ),

       active
        ?React.createElement(
          V,{style:[st.button,st.buttonMuted]},
          React.createElement(T,{style:st.buttonText},"Aktif")
         )
        :React.createElement(
          V,{style:{gap:6}},
          React.createElement(
           P,{onPress:()=>onSwitch(a),disabled:busy,style:st.button},
           React.createElement(T,{style:st.buttonText},busy?"…":"Geç")
          ),
          React.createElement(
           P,{
            onPress:()=>{
             if(forgetAccount(a.id))force();
            },
            style:[st.button,st.buttonDanger]
           },
           React.createElement(T,{style:st.buttonText},"Unut")
          )
         )
      );
     }),

  React.createElement(
   P,{onPress:beginAddAccount,style:st.add},
   React.createElement(T,{style:st.addText},"＋ Başka hesap ekle")
  ),

  React.createElement(
   T,{style:[st.sub,{marginTop:5}]},
   "Yeni hesabı yalnızca ilk kez eklerken giriş ekranına gitmen gerekir. Kaydedildikten sonra hesaplar arasında doğrudan geçiş yapılır."
  )
 );
}

function openAccountSwitcher(){
 try{
  if(!React)throw new Error("React bulunamadı");

  ActionSheet=ActionSheet||M.findByProps?.("openLazy","hideActionSheet");
  if(!ActionSheet?.openLazy)throw new Error("Discord ActionSheet modülü bulunamadı");

  captureCurrent(true);
  ActionSheet.openLazy(
   Promise.resolve({default:AccountSwitcherSheet}),
   SHEET_KEY,
   {}
  );
 }catch(e){
  err("openAccountSwitcher",e);
  toast(`Hesap Değiştir açılamadı: ${e?.message||e}`);
 }
}

function rendererTitle(config,key){
 try{
  const values=[
   typeof config?.useTitle==="function"?config.useTitle():config?.useTitle,
   typeof config?.title==="function"?config.title():config?.title,
   key
  ];
  return values.filter(v=>typeof v==="string").join(" ");
 }catch{
  return String(key||"");
 }
}

function looksLikeLogout(key,config){
 const s=rendererTitle(config,key).toLocaleLowerCase("tr-TR");
 return /(^|[\s_-])(log\s*out|logout|sign\s*out|çıkış|oturumu\s*kapat)([\s_-]|$)/i.test(s)
  || /logout|log_out|sign_out/i.test(String(key||""));
}

function injectRowIntoSections(sections){
 if(!Array.isArray(sections))return false;

 const renderer=SettingConstants?.SETTING_RENDERER_CONFIG||{};

 for(const section of sections){
  if(!Array.isArray(section?.settings))continue;

  if(section.settings.includes(ROW_KEY))return true;

  const logoutIndex=section.settings.findIndex(k=>looksLikeLogout(k,renderer?.[k]));
  if(logoutIndex!==-1){
   section.settings.splice(logoutIndex+1,0,ROW_KEY);
   diag.row=true;
   return true;
  }
 }

 // Fallback: put it in the account section if Discord changed the logout key.
 const accountSection=sections.find(s=>
  Array.isArray(s?.settings)
  && s.settings.some(k=>String(k).toUpperCase()==="ACCOUNT" || String(k).toUpperCase().includes("ACCOUNT"))
 );

 if(accountSection){
  if(!accountSection.settings.includes(ROW_KEY))accountSection.settings.push(ROW_KEY);
  diag.row=true;
  return true;
 }

 return false;
}

function installSettingsRow(){
 try{
  SettingConstants=M.findByProps?.("SETTING_RENDERER_CONFIG");
  CreateListModule=M.findByProps?.("createList");

  if(!SettingConstants?.SETTING_RENDERER_CONFIG){
   throw new Error("SETTING_RENDERER_CONFIG bulunamadı");
  }

  const originalDescriptor=Object.getOwnPropertyDescriptor(SettingConstants,"SETTING_RENDERER_CONFIG");
  let rendererValue=SettingConstants.SETTING_RENDERER_CONFIG;

  Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",{
   enumerable:true,
   configurable:true,
   get:()=>({
    ...rendererValue,
    [ROW_KEY]:{
     type:"pressable",
     title:()=> "Hesap Değiştir",
     useTitle:()=> "Hesap Değiştir",
     onPress:openAccountSwitcher,
     withArrow:true
    }
   }),
   set:v=>{rendererValue=v}
  });

  unpatches.push(()=>{
   try{
    if(originalDescriptor){
     Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",originalDescriptor);
    }else{
     Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",{
      value:rendererValue,
      writable:true,
      configurable:true,
      enumerable:true
     });
    }
   }catch{}
  });

  if(CreateListModule && typeof CreateListModule.createList==="function"){
   unpatches.push(
    patcher.after("createList",CreateListModule,(args,ret)=>{
     try{
      const config=args?.[0];
      if(Array.isArray(config?.sections)){
       injectRowIntoSections(config.sections);
       diag.listPatch=true;
      }
     }catch(e){
      err("createList patch",e);
     }
     return ret;
    })
   );
  }

  // Fallback for Discord builds where settings list is already rendered through SettingsOverviewScreen.
  const SettingsOverviewScreen=M.findByName?.("SettingsOverviewScreen",false);
  if(SettingsOverviewScreen && typeof SettingsOverviewScreen.default==="function"){
   unpatches.push(
    patcher.after("default",SettingsOverviewScreen,(_,tree)=>{
     try{
      const seen=new WeakSet();
      let budget=1200;

      function walk(v,d){
       if(!v||typeof v!=="object"||d>12||budget--<0)return false;
       if(seen.has(v))return false;
       seen.add(v);

       if(Array.isArray(v?.props?.sections)){
        injectRowIntoSections(v.props.sections);
        return true;
       }

       if(Array.isArray(v)){
        for(const x of v)if(walk(x,d+1))return true;
       }else{
        for(const k of Object.keys(v)){
         if(k==="__proto__"||typeof v[k]==="function")continue;
         if(walk(v[k],d+1))return true;
        }
       }
       return false;
      }

      walk(tree,0);
     }catch(e){
      err("SettingsOverview fallback",e);
     }
     return tree;
    })
   );
  }

 }catch(e){
  err("installSettingsRow",e);
 }
}

function discover(){
 try{
  TokenManager=
   M.findByProps?.("getToken")
   ||M.findByProps?.("getToken","setToken");
  diag.tokenManager=!!TokenManager;
 }catch{}

 try{
  Auth=
   M.findByProps?.("login","logout","switchAccountToken")
   ||M.findByProps?.("logout","switchAccountToken")
   ||M.findByProps?.("switchAccountToken");
  diag.auth=typeof Auth?.switchAccountToken==="function";
 }catch{}

 try{
  UserStore=M.findByStoreName?.("UserStore");
 }catch{}

 try{
  Flux=M.findByProps?.("dispatch","subscribe");
 }catch{}

 try{
  ActionSheet=M.findByProps?.("openLazy","hideActionSheet");
 }catch{}

 diag.crypto=hasCrypto();
}

function installCaptureWatcher(){
 if(!Flux || typeof Flux.dispatch!=="function")return;

 unpatches.push(
  patcher.after("dispatch",Flux,([action])=>{
   try{
    const type=String(action?.type||"");
    if(
     type==="CONNECTION_OPEN"
     ||type==="CURRENT_USER_UPDATE"
     ||type==="READY"
     ||type==="LOGIN_SUCCESS"
     ||type==="AUTH_SESSION_CHANGE"
     ||type.includes("LOGIN_SUCCESS")
    ){
     scheduleCapture(900);
    }
   }catch{}
  })
 );
}

function onLoad(){
 defaults();
 discover();
 installSettingsRow();
 installCaptureWatcher();

 scheduleCapture(700);
 setTimeout(()=>tryImportDiscordAccounts().catch(()=>{}),1800);
}

function onUnload(){
 if(captureTimer)clearTimeout(captureTimer);
 captureTimer=null;

 while(unpatches.length){
  try{unpatches.pop()?.()}catch{}
 }

 try{ActionSheet?.hideActionSheet?.(SHEET_KEY)}catch{}
 cryptoKeyPromise=null;
}

return {
 onLoad,
 onUnload,
 __test:{
  hasCrypto,
  rendererTitle,
  looksLikeLogout,
  injectRowIntoSections,
  accountList
 }
};

})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils);
