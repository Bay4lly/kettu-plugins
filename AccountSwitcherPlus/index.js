(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";

/*
 * Kettu AccountSwitcher+ v3.0.0
 * Author: bay4lly
 *
 * PC/Web-style mobile account switcher.
 * - Native Kettu custom settings page (no broken ActionSheet overlay)
 * - "Hesap Değiştir" directly below Logout
 * - Current account is remembered automatically
 * - Add another account with email/phone + password WITHOUT logging out
 * - TOTP / backup-code MFA support
 * - Passwords are never stored
 * - Saved auth tokens are AES-GCM encrypted when WebCrypto is available
 */

const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};

const ROW_KEY="BAY4LLY_ACCOUNT_SWITCHER_V3";
const CUSTOM_ROUTE="PUPU_CUSTOM_PAGE";
const unpatches=[];

let TokenManager=null;
let Auth=null;
let UserStore=null;
let Flux=null;
let SettingConstants=null;
let CreateListModule=null;
let TabsNavigationRef=null;
let captureTimer=null;
let cryptoKeyPromise=null;

const diag={
 row:false,
 nav:false,
 tokenManager:false,
 auth:false,
 currentCaptured:false,
 credentialAdds:0,
 mfaAdds:0,
 switches:0,
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
 if(!storage.accounts || typeof storage.accounts!=="object" || Array.isArray(storage.accounts)){
  storage.accounts={};
 }
 if(storage.version===undefined)storage.version=3;
 if(storage.autoRemember===undefined)storage.autoRemember=true;
}

function hasCrypto(){
 try{
  return !!globalThis.crypto?.subtle
   && typeof globalThis.crypto?.getRandomValues==="function"
   && typeof TextEncoder!=="undefined"
   && typeof TextDecoder!=="undefined";
 }catch{return false}
}

function bytesToB64(bytes){
 let s="";
 for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);
 return btoa(s);
}
function b64ToBytes(s){
 return Uint8Array.from(atob(String(s||"")),c=>c.charCodeAt(0));
}

function getFallbackKey(){
 if(!storage.fallbackKey){
  let s="";
  for(let i=0;i<32;i++)s+=String.fromCharCode(Math.floor(Math.random()*256));
  storage.fallbackKey=btoa(s);
 }
 return b64ToBytes(storage.fallbackKey);
}
function xorSeal(text){
 const key=getFallbackKey();
 const src=new TextEncoder().encode(String(text));
 const out=new Uint8Array(src.length);
 for(let i=0;i<src.length;i++)out[i]=src[i]^key[i%key.length];
 return "obf:"+bytesToB64(out);
}
function xorOpen(blob){
 const key=getFallbackKey();
 const src=b64ToBytes(String(blob).slice(4));
 const out=new Uint8Array(src.length);
 for(let i=0;i<src.length;i++)out[i]=src[i]^key[i%key.length];
 return new TextDecoder().decode(out);
}

async function getCryptoKey(){
 if(cryptoKeyPromise)return cryptoKeyPromise;
 cryptoKeyPromise=(async()=>{
  if(!hasCrypto())return null;
  if(!storage.localEncryptionKey){
   const raw=crypto.getRandomValues(new Uint8Array(32));
   storage.localEncryptionKey=bytesToB64(raw);
   raw.fill(0);
  }
  return crypto.subtle.importKey(
   "raw",
   b64ToBytes(storage.localEncryptionKey),
   {name:"AES-GCM"},
   false,
   ["encrypt","decrypt"]
  );
 })();
 return cryptoKeyPromise;
}

async function sealToken(token){
 const key=await getCryptoKey();
 if(!key)return xorSeal(token);

 const iv=crypto.getRandomValues(new Uint8Array(12));
 const src=new TextEncoder().encode(String(token));
 try{
  const enc=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,src));
  return `aes:${bytesToB64(iv)}:${bytesToB64(enc)}`;
 }finally{
  src.fill(0);
  iv.fill(0);
 }
}

async function openToken(blob){
 const value=String(blob||"");
 if(value.startsWith("aes:")){
  const [,iv64,data64]=value.split(":");
  const key=await getCryptoKey();
  if(!key)throw new Error("Şifreleme anahtarı kullanılamıyor");
  const buf=await crypto.subtle.decrypt(
   {name:"AES-GCM",iv:b64ToBytes(iv64)},
   key,
   b64ToBytes(data64)
  );
  return new TextDecoder().decode(buf);
 }
 if(value.startsWith("obf:"))return xorOpen(value);
 if(value.startsWith("k2:")){
  // Migration from our old v2 format.
  const [,iv64,data64]=value.split(":");
  const key=await getCryptoKey();
  if(!key)throw new Error("Eski hesap kaydı açılamadı");
  const buf=await crypto.subtle.decrypt(
   {name:"AES-GCM",iv:b64ToBytes(iv64)},
   key,
   b64ToBytes(data64)
  );
  return new TextDecoder().decode(buf);
 }
 throw new Error("Hesap kaydı bu sürümle uyumlu değil");
}

function normalizeUser(user){
 if(!user?.id)return null;
 return {
  id:String(user.id),
  username:String(user.username||"hesap"),
  displayName:String(user.global_name||user.globalName||user.displayName||user.username||"Hesap"),
  avatar:user.avatar||null,
  discriminator:user.discriminator||"0"
 };
}

function avatarUrl(account,size=128){
 if(!account?.id||!account?.avatar)return null;
 const ext=String(account.avatar).startsWith("a_")?"gif":"png";
 return `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.${ext}?size=${size}`;
}

function currentUser(){
 try{return UserStore?.getCurrentUser?.()||null}catch{return null}
}
function currentId(){
 return String(currentUser()?.id||"");
}

async function saveAccount(user,plainToken,source="current"){
 if(!user?.id||!plainToken)throw new Error("Hesap bilgisi veya token bulunamadı");
 const id=String(user.id);
 const old=storage.accounts[id]||{};
 const token=await sealToken(plainToken);
 storage.accounts[id]={
  ...old,
  ...normalizeUser(user),
  token,
  source,
  savedAt:old.savedAt||Date.now(),
  lastSeen:Date.now()
 };
 return storage.accounts[id];
}

async function captureCurrent(silent=true){
 try{
  discover();
  if(!storage.autoRemember)return null;
  const token=TokenManager?.getToken?.();
  const user=currentUser();
  if(!token||!user?.id){
   if(!silent)toast("Aktif Discord oturumu okunamadı");
   return null;
  }
  const acc=await saveAccount(user,token,"current");
  diag.currentCaptured=true;
  return acc;
 }catch(e){
  err("captureCurrent",e);
  if(!silent)toast(`Aktif hesap kaydedilemedi: ${e?.message||e}`);
  return null;
 }
}

function scheduleCapture(ms=700){
 if(captureTimer)clearTimeout(captureTimer);
 captureTimer=setTimeout(()=>{
  captureTimer=null;
  captureCurrent(true);
 },ms);
}

async function fetchMe(token){
 const r=await fetch("https://discord.com/api/v9/users/@me",{
  headers:{Authorization:String(token)}
 });
 let j=null;
 try{j=await r.json()}catch{}
 if(!r.ok)throw new Error(j?.message||`Kullanıcı bilgisi alınamadı (HTTP ${r.status})`);
 return j;
}

function loginHeaders(){
 return {
  "Content-Type":"application/json",
  "Accept":"application/json",
  "X-Discord-Locale":"tr"
 };
}

function friendlyLoginError(status,data){
 if(data?.captcha_key||data?.captcha_sitekey){
  return "Discord CAPTCHA istiyor. CAPTCHA plugin içinden güvenli şekilde çözülemiyor; biraz sonra tekrar dene veya hesabı normal Discord girişinden bir kez aç.";
 }
 if(status===429)return "Çok fazla giriş denemesi yapıldı. Biraz bekleyip tekrar dene.";
 if(data?.errors?.login)return "E-posta/telefon bilgisi geçersiz.";
 if(data?.errors?.password)return "Şifre geçersiz.";
 if(data?.message)return String(data.message);
 return `Giriş başarısız (HTTP ${status})`;
}

/*
 * Logs into an additional account without changing the currently active
 * Discord token. It only requests a token from Discord and stores it locally.
 */
async function beginCredentialLogin(login,password){
 const email=String(login||"").trim();
 const pass=String(password||"");
 if(!email||!pass)throw new Error("E-posta/telefon ve şifreyi doldur");

 const response=await fetch("https://discord.com/api/v9/auth/login",{
  method:"POST",
  headers:loginHeaders(),
  body:JSON.stringify({
   login:email,
   password:pass,
   undelete:false,
   login_source:null,
   gift_code_sku_id:null
  })
 });

 let data={};
 try{data=await response.json()}catch{}

 if(data?.token){
  const user=await fetchMe(data.token);
  const account=await saveAccount(user,data.token,"credentials");
  diag.credentialAdds++;
  return {type:"done",account};
 }

 if(data?.mfa&&data?.ticket){
  return {
   type:"mfa",
   ticket:String(data.ticket),
   methods:Array.isArray(data.methods)?data.methods:[]
  };
 }

 throw new Error(friendlyLoginError(response.status,data));
}

async function finishTotp(ticket,code){
 const c=String(code||"").replace(/\s+/g,"").trim();
 if(!ticket)throw new Error("2FA bileti bulunamadı");
 if(!c)throw new Error("2FA veya yedek kodunu gir");

 const response=await fetch("https://discord.com/api/v9/auth/mfa/totp",{
  method:"POST",
  headers:loginHeaders(),
  body:JSON.stringify({
   code:c,
   ticket:String(ticket),
   login_source:null,
   gift_code_sku_id:null
  })
 });

 let data={};
 try{data=await response.json()}catch{}

 if(!response.ok||!data?.token){
  if(response.status===429)throw new Error("Çok fazla 2FA denemesi. Biraz bekle.");
  throw new Error(data?.message||"2FA kodu kabul edilmedi");
 }

 const user=await fetchMe(data.token);
 const account=await saveAccount(user,data.token,"credentials-mfa");
 diag.mfaAdds++;
 return account;
}

async function switchAccount(account){
 if(!account?.id)return;
 if(String(account.id)===currentId()){
  toast("Zaten bu hesaptasın");
  return;
 }

 discover();
 if(typeof Auth?.switchAccountToken!=="function"){
  throw new Error("Discord switchAccountToken modülü bulunamadı");
 }

 const token=await openToken(account.token);
 await Promise.resolve(Auth.switchAccountToken(token));
 diag.switches++;
 scheduleCapture(1800);
}

function forgetAccount(id){
 const sid=String(id);
 if(sid===currentId()){
  toast("Şu an açık hesabı listeden silemezsin");
  return false;
 }
 delete storage.accounts[sid];
 return true;
}

function listAccounts(){
 const active=currentId();
 return Object.values(storage.accounts||{})
  .filter(a=>a?.id&&a?.token)
  .sort((a,b)=>{
   if(String(a.id)===active)return -1;
   if(String(b.id)===active)return 1;
   return Number(b.lastSeen||b.savedAt||0)-Number(a.lastSeen||a.savedAt||0);
  });
}

function AccountSwitcherPage(){
 const [,force]=React.useReducer(x=>x+1,0);
 const [showAdd,setShowAdd]=React.useState(false);
 const [login,setLogin]=React.useState("");
 const [password,setPassword]=React.useState("");
 const [showPassword,setShowPassword]=React.useState(false);
 const [busy,setBusy]=React.useState(false);
 const [errorText,setErrorText]=React.useState("");
 const [mfaTicket,setMfaTicket]=React.useState("");
 const [mfaCode,setMfaCode]=React.useState("");

 React.useEffect(()=>{
  let alive=true;
  (async()=>{
   discover();
   await captureCurrent(true);
   if(alive)force();
  })();
  return()=>{alive=false};
 },[]);

 const V=RN.View,T=RN.Text,SV=RN.ScrollView||V;
 const P=RN.Pressable||RN.TouchableOpacity||V;
 const I=RN.TextInput,Img=RN.Image;
 const current=currentId();
 const accounts=listAccounts();
 const cu=currentUser();

 const st={
  root:{padding:16,paddingBottom:40,gap:12},
  section:{backgroundColor:"#2b2d31",borderRadius:14,padding:12,gap:10},
  title:{fontSize:20,fontWeight:"700",color:"#f2f3f5"},
  sub:{fontSize:13,color:"#b5bac1",lineHeight:18},
  error:{fontSize:13,color:"#fa777c",lineHeight:18},
  success:{fontSize:13,color:"#23a55a"},
  card:{
   flexDirection:"row",alignItems:"center",gap:11,
   backgroundColor:"#2b2d31",borderRadius:14,padding:12
  },
  active:{borderWidth:1,borderColor:"#23a55a"},
  avatar:{width:48,height:48,borderRadius:24,backgroundColor:"#1e1f22"},
  info:{flex:1,minWidth:0},
  name:{fontSize:16,fontWeight:"700",color:"#f2f3f5"},
  user:{fontSize:13,color:"#b5bac1",marginTop:2},
  activeText:{fontSize:12,color:"#23a55a",fontWeight:"700",marginTop:3},
  input:{
   backgroundColor:"#1e1f22",color:"#fff",
   borderWidth:1,borderColor:"#3f4147",
   paddingHorizontal:12,paddingVertical:11,borderRadius:9,fontSize:15
  },
  btn:{paddingVertical:12,paddingHorizontal:14,borderRadius:9,backgroundColor:"#5865f2"},
  btnMuted:{backgroundColor:"#404249"},
  btnDanger:{backgroundColor:"#4a2b2f"},
  btnGreen:{backgroundColor:"#248046"},
  btnText:{color:"#fff",fontWeight:"700",fontSize:14,textAlign:"center"},
  smallBtn:{paddingVertical:8,paddingHorizontal:11,borderRadius:8,backgroundColor:"#5865f2"},
  smallText:{color:"#fff",fontWeight:"700",fontSize:13},
  actions:{gap:7},
  divider:{height:1,backgroundColor:"#3f4147",marginVertical:2}
 };

 const doCredentialAdd=async()=>{
  if(busy)return;
  setErrorText("");
  setBusy(true);
  try{
   const result=await beginCredentialLogin(login,password);
   setPassword(""); // password is never kept after the request
   if(result.type==="mfa"){
    setMfaTicket(result.ticket);
    setErrorText("");
    toast("2FA kodu gerekli");
   }else{
    setLogin("");
    setShowAdd(false);
    setMfaTicket("");
    setMfaCode("");
    toast(`${result.account.displayName} hesaba eklendi`);
    force();
   }
  }catch(e){
   setPassword("");
   setErrorText(String(e?.message||e));
  }finally{
   setBusy(false);
  }
 };

 const doMfa=async()=>{
  if(busy)return;
  setErrorText("");
  setBusy(true);
  try{
   const acc=await finishTotp(mfaTicket,mfaCode);
   setMfaTicket("");
   setMfaCode("");
   setLogin("");
   setPassword("");
   setShowAdd(false);
   toast(`${acc.displayName} hesaba eklendi`);
   force();
  }catch(e){
   setErrorText(String(e?.message||e));
  }finally{
   setBusy(false);
  }
 };

 const doSwitch=async(a)=>{
  if(busy)return;
  setErrorText("");
  setBusy(true);
  try{
   toast(`${a.displayName||a.username} hesabına geçiliyor…`);
   await switchAccount(a);
  }catch(e){
   setErrorText(`Hesap değiştirilemedi: ${e?.message||e}`);
  }finally{
   setBusy(false);
  }
 };

 const renderAvatar=(a)=>{
  const uri=avatarUrl(a);
  if(uri&&Img)return React.createElement(Img,{source:{uri},style:st.avatar});
  return React.createElement(
   V,{style:[st.avatar,{alignItems:"center",justifyContent:"center"}]},
   React.createElement(T,{style:{color:"#fff",fontSize:19,fontWeight:"800"}},
    String(a?.displayName||a?.username||"?").slice(0,1).toUpperCase()
   )
  );
 };

 const content=[];

 content.push(
  React.createElement(
   V,{key:"intro",style:st.section},
   React.createElement(T,{style:st.title},"Hesaplar"),
   React.createElement(
    T,{style:st.sub},
    "PC/web sürümündeki gibi kayıtlı hesaplarından birine geç. Yeni hesap eklemek mevcut hesabını kapatmaz."
   ),
   errorText?React.createElement(T,{style:st.error},errorText):null
  )
 );

 if(accounts.length===0){
  content.push(
   React.createElement(
    V,{key:"empty",style:st.section},
    React.createElement(
     T,{style:st.sub},
     cu?.id
      ?`Aktif hesap: ${cu.globalName||cu.global_name||cu.username}. Oturum kaydı hazırlanıyor…`
      :"Aktif Discord hesabı okunamadı."
    ),
    React.createElement(
     P,{onPress:async()=>{await captureCurrent(false);force()},style:st.btnMuted},
     React.createElement(T,{style:st.btnText},"Aktif hesabı yeniden algıla")
    )
   )
  );
 }else{
  accounts.forEach(a=>{
   const active=String(a.id)===current;
   content.push(
    React.createElement(
     V,{key:a.id,style:[st.card,active&&st.active]},
     renderAvatar(a),
     React.createElement(
      V,{style:st.info},
      React.createElement(T,{style:st.name},a.displayName||a.username),
      React.createElement(T,{style:st.user},`@${a.username}`),
      active?React.createElement(T,{style:st.activeText},"● Şu an açık"):null
     ),
     React.createElement(
      V,{style:st.actions},
      active
       ?React.createElement(
         V,{style:[st.smallBtn,st.btnMuted]},
         React.createElement(T,{style:st.smallText},"Aktif")
        )
       :React.createElement(
         P,{onPress:()=>doSwitch(a),disabled:busy,style:st.smallBtn},
         React.createElement(T,{style:st.smallText},busy?"…":"Geç")
        ),
      !active?React.createElement(
       P,{
        onPress:()=>{if(forgetAccount(a.id))force()},
        disabled:busy,
        style:[st.smallBtn,st.btnDanger]
       },
       React.createElement(T,{style:st.smallText},"Unut")
      ):null
     )
    )
   );
  });
 }

 if(!showAdd){
  content.push(
   React.createElement(
    P,{
     key:"showadd",
     onPress:()=>{setShowAdd(true);setErrorText("");setMfaTicket("")},
     style:st.btn
    },
    React.createElement(T,{style:st.btnText},"＋ Başka hesap ekle")
   )
  );
 }else{
  content.push(
   React.createElement(
    V,{key:"addform",style:st.section},
    React.createElement(T,{style:st.title},"Başka hesap ekle"),
    React.createElement(
     T,{style:st.sub},
     mfaTicket
      ?"Discord bu hesap için iki aşamalı doğrulama istiyor."
      :"E-posta/telefon ve şifrenle Discord'a giriş yapılır. Mevcut hesabın açık kalır ve şifren kaydedilmez."
    ),

    !mfaTicket&&I?React.createElement(
     React.Fragment,null,
     React.createElement(I,{
      style:st.input,
      value:login,
      onChangeText:setLogin,
      placeholder:"E-posta veya telefon",
      placeholderTextColor:"#80848e",
      autoCapitalize:"none",
      autoCorrect:false,
      keyboardType:"email-address",
      editable:!busy
     }),
     React.createElement(I,{
      style:st.input,
      value:password,
      onChangeText:setPassword,
      placeholder:"Şifre",
      placeholderTextColor:"#80848e",
      secureTextEntry:!showPassword,
      autoCapitalize:"none",
      autoCorrect:false,
      editable:!busy,
      onSubmitEditing:doCredentialAdd
     }),
     React.createElement(
      P,{onPress:()=>setShowPassword(!showPassword),style:[st.btn,st.btnMuted]},
      React.createElement(T,{style:st.btnText},showPassword?"Şifreyi gizle":"Şifreyi göster")
     ),
     React.createElement(
      P,{onPress:doCredentialAdd,disabled:busy,style:[st.btn,busy&&{opacity:.55}]},
      React.createElement(T,{style:st.btnText},busy?"Giriş yapılıyor…":"Hesabı ekle")
     )
    ):null,

    mfaTicket&&I?React.createElement(
     React.Fragment,null,
     React.createElement(I,{
      style:st.input,
      value:mfaCode,
      onChangeText:setMfaCode,
      placeholder:"6 haneli 2FA veya yedek kod",
      placeholderTextColor:"#80848e",
      autoCapitalize:"none",
      autoCorrect:false,
      keyboardType:"number-pad",
      editable:!busy,
      onSubmitEditing:doMfa
     }),
     React.createElement(
      P,{onPress:doMfa,disabled:busy,style:[st.btn,st.btnGreen,busy&&{opacity:.55}]},
      React.createElement(T,{style:st.btnText},busy?"Doğrulanıyor…":"2FA ile hesabı ekle")
     ),
     React.createElement(
      P,{onPress:()=>{setMfaTicket("");setMfaCode("");setErrorText("")},style:[st.btn,st.btnMuted]},
      React.createElement(T,{style:st.btnText},"Geri")
     )
    ):null,

    React.createElement(V,{style:st.divider}),
    React.createElement(
     P,{
      onPress:()=>{
       setShowAdd(false);
       setPassword("");
       setMfaTicket("");
       setMfaCode("");
       setErrorText("");
      },
      style:[st.btn,st.btnMuted]
     },
     React.createElement(T,{style:st.btnText},"İptal")
    ),
    React.createElement(
     T,{style:st.sub},
     "CAPTCHA veya yalnızca passkey isteyen hesaplarda Discord bu dahili giriş yöntemini reddedebilir. Böyle bir durumda plugin mevcut hesabından otomatik çıkış yapmaz."
    )
   )
  );
 }

 content.push(
  React.createElement(
   V,{key:"diag",style:st.section},
   React.createElement(T,{style:st.sub},
    `TokenManager ${diag.tokenManager?"OK":"YOK"} | Switch ${diag.auth?"OK":"YOK"} | Navigasyon ${diag.nav?"OK":"YOK"}\n`+
    `Aktif hesap ${diag.currentCaptured?"kaydedildi":"bekleniyor"} | Eklenen ${diag.credentialAdds+diag.mfaAdds} | Geçiş ${diag.switches}`+
    `${diag.lastError?`\nSon hata: ${diag.lastError}`:""}`
   )
  )
 );

 return React.createElement(SV,{contentContainerStyle:st.root,keyboardShouldPersistTaps:"handled"},content);
}

function discover(){
 try{
  TokenManager=M.findByProps?.("getToken")
   ||M.findByProps?.("getToken","setToken");
  diag.tokenManager=!!TokenManager?.getToken;
 }catch{}

 try{
  Auth=M.findByProps?.("login","logout","switchAccountToken")
   ||M.findByProps?.("logout","switchAccountToken")
   ||M.findByProps?.("switchAccountToken");
  diag.auth=typeof Auth?.switchAccountToken==="function";
 }catch{}

 try{UserStore=M.findByStoreName?.("UserStore")}catch{}
 try{Flux=M.findByProps?.("dispatch","subscribe")}catch{}
 try{TabsNavigationRef=M.findByProps?.("getRootNavigationRef");diag.nav=!!TabsNavigationRef?.getRootNavigationRef}catch{}
}

function openPage(){
 try{
  discover();
  const nav=TabsNavigationRef?.getRootNavigationRef?.();
  if(!nav?.navigate)throw new Error("Kettu root navigation bulunamadı");

  nav.navigate(CUSTOM_ROUTE,{
   title:"Hesap Değiştir",
   render:()=>React.createElement(AccountSwitcherPage)
  });
 }catch(e){
  err("openPage",e);
  toast(`Hesap Değiştir açılamadı: ${e?.message||e}`);
 }
}

function configTitle(config,key){
 try{
  let title="";
  if(typeof config?.useTitle==="function"){
   // Do not call hooks here; function name/key checks below are the main path.
  }else if(typeof config?.title==="string"){
   title=config.title;
  }
  return `${String(key||"")} ${title}`.toLocaleLowerCase("tr-TR");
 }catch{return String(key||"").toLowerCase()}
}

function isLogoutKey(key,config){
 const s=configTitle(config,key);
 return /logout|log_out|signout|sign_out|çıkış|oturumu.?kapat/i.test(s);
}

function injectAfterLogout(sections){
 if(!Array.isArray(sections))return false;
 const renderer=SettingConstants?.SETTING_RENDERER_CONFIG||{};

 for(const section of sections){
  if(!Array.isArray(section?.settings))continue;
  if(section.settings.includes(ROW_KEY))return true;

  const idx=section.settings.findIndex(k=>isLogoutKey(k,renderer?.[k]));
  if(idx>=0){
   section.settings.splice(idx+1,0,ROW_KEY);
   diag.row=true;
   return true;
  }
 }

 // Current mobile Discord usually places LOGOUT in the account block.
 const accountSection=sections.find(s=>
  Array.isArray(s?.settings)
  && s.settings.some(k=>String(k).toUpperCase()==="ACCOUNT")
 );
 if(accountSection){
  const logoutIndex=accountSection.settings.findIndex(k=>/logout/i.test(String(k)));
  const insertAt=logoutIndex>=0?logoutIndex+1:accountSection.settings.length;
  if(!accountSection.settings.includes(ROW_KEY)){
   accountSection.settings.splice(insertAt,0,ROW_KEY);
  }
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
  let value=SettingConstants.SETTING_RENDERER_CONFIG;

  Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",{
   enumerable:true,
   configurable:true,
   get:()=>({
    ...value,
    [ROW_KEY]:{
     type:"pressable",
     title:()=> "Hesap Değiştir",
     useTitle:()=> "Hesap Değiştir",
     onPress:openPage,
     withArrow:true
    }
   }),
   set:v=>{value=v}
  });

  unpatches.push(()=>{
   try{
    if(originalDescriptor){
     Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",originalDescriptor);
    }else{
     Object.defineProperty(SettingConstants,"SETTING_RENDERER_CONFIG",{
      value,writable:true,configurable:true,enumerable:true
     });
    }
   }catch{}
  });

  if(CreateListModule&&typeof CreateListModule.createList==="function"){
   unpatches.push(
    patcher.after("createList",CreateListModule,(args,ret)=>{
     try{
      const config=args?.[0];
      if(Array.isArray(config?.sections))injectAfterLogout(config.sections);
     }catch(e){err("settings list",e)}
     return ret;
    })
   );
  }
 }catch(e){
  err("installSettingsRow",e);
 }
}

function installWatcher(){
 if(!Flux?.dispatch)return;
 unpatches.push(
  patcher.after("dispatch",Flux,([a])=>{
   try{
    const type=String(a?.type||"");
    if(
     type==="CONNECTION_OPEN"
     ||type==="READY"
     ||type==="CURRENT_USER_UPDATE"
     ||type.includes("LOGIN_SUCCESS")
     ||type==="AUTH_SESSION_CHANGE"
    ) scheduleCapture(900);
   }catch{}
  })
 );
}

function onLoad(){
 defaults();
 discover();
 installSettingsRow();
 installWatcher();
 scheduleCapture(900);
}

function onUnload(){
 if(captureTimer)clearTimeout(captureTimer);
 captureTimer=null;
 while(unpatches.length){
  try{unpatches.pop()?.()}catch{}
 }
 cryptoKeyPromise=null;
}

return {
 onLoad,
 onUnload,
 settings:AccountSwitcherPage,
 __test:{
  hasCrypto,
  isLogoutKey,
  injectAfterLogout,
  friendlyLoginError,
  listAccounts
 }
};

})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils);
