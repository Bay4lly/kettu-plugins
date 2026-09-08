(function(M,common,patcher,plugin,logger,ui,utils){
"use strict";
/* Kettu Translate v1.1.0 - legacy Kettu/Revenge/Vendetta plugin */
const React=common?.React;
const RN=common?.ReactNative||{};
const storage=plugin?.storage||{};

const unpatches=[];
const cache=new Map();
const pending=new Map();

let Flux=null,MessageStore=null,UserStore=null,RowManager=null,LazyActionSheet=null,ActionSheetRow=null;

const diag={
 flux:false,row:false,sheet:false,
 requests:0,success:0,failed:0,inline:0,
 lastError:"",lastProvider:""
};

function err(where,e){
 diag.lastError=`${where}: ${e?.message||e}`;
 try{logger?.error?.(diag.lastError,e)}catch{}
}

function defaults(){
 if(storage.enabled===undefined)storage.enabled=true;
 if(storage.targetLanguage===undefined)storage.targetLanguage="tr";
 if(storage.provider===undefined)storage.provider="google";
 if(storage.libreEndpoint===undefined)storage.libreEndpoint="https://libretranslate.com/translate";
 if(storage.libreApiKey===undefined)storage.libreApiKey="";
 if(storage.inline===undefined)storage.inline=true;
 if(storage.autoIncoming===undefined)storage.autoIncoming=false;
 if(storage.ignoreBots===undefined)storage.ignoreBots=true;
 if(storage.ignoreSelf===undefined)storage.ignoreSelf=true;
 if(storage.protectMarkdown===undefined)storage.protectMarkdown=true;
 if(storage.showLanguageTag===undefined)storage.showLanguageTag=true;
 if(storage.maxChars===undefined)storage.maxChars=3500;
}

function key(ch,id){return `${ch||"?"}:${id||"?"}`}

function protect(text){
 if(!storage.protectMarkdown)return {text:String(text??""),tokens:[]};
 const tokens=[];
 let s=String(text??"");
 const patterns=[
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /<a?:\w+:\d+>/g,
  /<[@#]&?!?\d+>/g,
  /https?:\/\/[^\s)]+/g
 ];
 for(const re of patterns){
  s=s.replace(re,m=>{
   const i=tokens.push(m)-1;
   return `⟦KTT${i}⟧`;
  });
 }
 return {text:s,tokens};
}

function restore(text,tokens){
 let s=String(text??"");
 tokens.forEach((v,i)=>{
  s=s.split(`⟦KTT${i}⟧`).join(v);
 });
 return s;
}

async function googleTranslate(text,target){
 const q=encodeURIComponent(text);
 const tl=encodeURIComponent(target);
 const url=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${q}`;
 const r=await fetch(url,{method:"GET"});
 if(!r.ok)throw new Error(`Google HTTP ${r.status}`);
 const j=await r.json();
 const out=Array.isArray(j?.[0])?j[0].map(x=>x?.[0]||"").join(""):"";
 if(!out)throw new Error("Google boş çeviri döndürdü");
 return out;
}

async function libreTranslate(text,target){
 const endpoint=String(storage.libreEndpoint||"").trim();
 if(!endpoint)throw new Error("LibreTranslate endpoint boş");

 const body={
  q:text,
  source:"auto",
  target,
  format:"text"
 };

 const apiKey=String(storage.libreApiKey||"").trim();
 if(apiKey)body.api_key=apiKey;

 const r=await fetch(endpoint,{
  method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify(body)
 });

 let j=null;
 try{j=await r.json()}catch{}

 if(!r.ok){
  const detail=j?.error||j?.message||`HTTP ${r.status}`;
  throw new Error(`LibreTranslate: ${detail}`);
 }

 const out=j?.translatedText??j?.translation??"";
 if(!out)throw new Error("LibreTranslate boş çeviri döndürdü");
 return String(out);
}

async function translateText(input){
 const raw=String(input??"").trim();
 if(!raw)return "";

 const max=Math.max(100,Math.min(10000,Number(storage.maxChars)||3500));
 const cut=raw.slice(0,max);
 const p=protect(cut);
 const target=String(storage.targetLanguage||"tr").trim().toLowerCase()||"tr";

 diag.requests++;

 try{
  let out="";
  if(storage.provider==="libre"){
   diag.lastProvider="LibreTranslate";
   out=await libreTranslate(p.text,target);
  }else{
   diag.lastProvider="Google Web";
   out=await googleTranslate(p.text,target);
  }

  out=restore(out,p.tokens);
  diag.success++;
  diag.lastError="";
  return out;
 }catch(e){
  diag.failed++;
  err("translate",e);
  throw e;
 }
}

function toast(s){
 try{ui?.showToast?.(String(s))}catch{}
}

function showResult(original,translated){
 try{
  const Alert=common?.Alerts||M.findByProps?.("show","close");
  if(Alert?.show){
   Alert.show({
    title:`Çeviri → ${String(storage.targetLanguage||"tr").toUpperCase()}`,
    body:translated,
    confirmText:"Tamam"
   });
  }else toast(translated);
 }catch{
  toast(translated);
 }
}

function clip(text){
 try{
  const C=M.findByProps?.("setString");
  C?.setString?.(String(text));
  toast("Çeviri panoya kopyalandı");
 }catch(e){
  err("clipboard",e);
 }
}

async function translateMessage(msg,show=true){
 const ch=msg?.channel_id||msg?.channelId;
 const id=msg?.id;
 const content=msg?.content||"";
 if(!ch||!id||!content)return null;

 const k=key(ch,id);

 if(cache.has(k)){
  const t=cache.get(k);
  if(show)showResult(content,t);
  return t;
 }

 if(pending.has(k))return pending.get(k);

 const p=translateText(content)
  .then(t=>{
   cache.set(k,t);
   pending.delete(k);
   if(show)showResult(content,t);
   invalidateRow(ch,id);
   return t;
  })
  .catch(e=>{
   pending.delete(k);
   toast(`Çeviri hatası: ${e?.message||e}`);
   return null;
  });

 pending.set(k,p);
 return p;
}

function deepTextPatch(root,source,replacement){
 if(!root||typeof root!=="object"||!source||!replacement)return root;

 let budget=1800;
 const seen=new WeakMap();

 function walk(v,d){
  if(v==null||d>12||budget--<=0)return v;
  if(typeof v==="string")return v===source?replacement:v;
  if(typeof v!=="object"||v instanceof Date)return v;
  if(seen.has(v))return seen.get(v);

  if(Array.isArray(v)){
   let a=v;
   seen.set(v,a);
   for(let i=0;i<v.length;i++){
    const n=walk(v[i],d+1);
    if(n!==v[i]){
     if(a===v){
      a=v.slice();
      seen.set(v,a);
     }
     a[i]=n;
    }
   }
   return a;
  }

  const tag=Object.prototype.toString.call(v);
  if(tag!=="[object Object]")return v;

  let o=v;
  seen.set(v,o);

  for(const k of Object.keys(v)){
   if(typeof v[k]==="function")continue;
   const n=walk(v[k],d+1);
   if(n!==v[k]){
    if(o===v){
     o={...v};
     seen.set(v,o);
    }
    o[k]=n;
   }
  }

  return o;
 }

 return walk(root,0);
}

function invalidateRow(ch,id){
 try{
  for(const n of ["invalidateMessage","invalidate","updateMessage","updateRow","clearCache"]){
   if(typeof RowManager?.prototype?.[n]==="function"){
    try{RowManager.prototype[n](ch,id)}catch{}
   }
  }
  MessageStore?.emitChange?.();
 }catch{}
}

function installRow(){
 try{
  RowManager=M.findByName?.("RowManager");
  const p=RowManager?.prototype;
  if(typeof p?.generate!=="function")return;

  diag.row=true;

  unpatches.push(
   patcher.after("generate",p,(args,res)=>{
    try{
     if(!storage.enabled||!storage.inline)return;

     const msg=args?.[0]?.message;
     const ch=msg?.channel_id||msg?.channelId;
     const id=msg?.id;
     const t=cache.get(key(ch,id));

     if(!t)return;

     const src=String(msg?.content||"");
     if(!src)return;

     diag.inline++;

     const tag=storage.showLanguageTag
      ?`\n-# 🌐 ${String(storage.targetLanguage||"").toUpperCase()}: ${t}`
      :`\n-# ${t}`;

     return deepTextPatch(res,src,src+tag);
    }catch(e){
     err("row",e);
    }
   })
  );
 }catch(e){
  err("installRow",e);
 }
}

function findRows(root){
 const seen=new WeakSet();
 let b=1200;

 function w(v,d){
  if(v==null||d>10||b--<0)return null;
  if(Array.isArray(v)&&v.some(x=>x?.props&&typeof x.props.onPress==="function"))return v;
  if(typeof v!=="object")return null;
  if(seen.has(v))return null;
  seen.add(v);

  for(const k of Object.keys(v)){
   if(typeof v[k]==="function")continue;
   const r=w(v[k],d+1);
   if(r)return r;
  }

  return null;
 }

 return w(root,0);
}

function installSheet(){
 try{
  LazyActionSheet=M.findByProps?.("openLazy","hideActionSheet");
  ActionSheetRow=
   M.findByProps?.("ActionSheetRow")?.ActionSheetRow||
   common?.ActionSheetRow||
   ui?.components?.FormRow;

  if(!LazyActionSheet||!ActionSheetRow)return;

  unpatches.push(
   patcher.before("openLazy",LazyActionSheet,([component,sheetKey,sheetProps])=>{
    const msg=sheetProps?.message;
    if(sheetKey!=="MessageLongPressActionSheet"||!msg?.content||!component?.then)return;

    component.then(mod=>{
     if(typeof mod?.default!=="function")return;

     const u=patcher.after("default",mod,(_,tree)=>{
      setTimeout(()=>{try{u()}catch{}},0);

      const rows=findRows(tree);
      if(!rows||rows.some(r=>r?.props?.__ktt))return;

      rows.push(
       React.createElement(ActionSheetRow,{
        key:"ktt",
        label:"🌐 Mesajı çevir",
        __ktt:true,
        onPress:()=>{
         LazyActionSheet.hideActionSheet?.();
         translateMessage(msg,true);
        }
       })
      );

      rows.push(
       React.createElement(ActionSheetRow,{
        key:"kttcopy",
        label:"🌐 Çeviriyi kopyala",
        __ktt:true,
        onPress:async()=>{
         LazyActionSheet.hideActionSheet?.();
         const t=await translateMessage(msg,false);
         if(t)clip(t);
        }
       })
      );
     });
    }).catch?.(()=>{});
   })
  );

  diag.sheet=true;
 }catch(e){
  err("sheet",e);
 }
}

function installAuto(){
 try{
  Flux=M.findByProps?.("dispatch","subscribe");
  MessageStore=M.findByStoreName?.("MessageStore");
  UserStore=M.findByStoreName?.("UserStore");
  diag.flux=!!Flux;

  if(!Flux)return;

  unpatches.push(
   patcher.after("dispatch",Flux,([a])=>{
    try{
     if(!storage.enabled||!storage.autoIncoming||a?.type!=="MESSAGE_CREATE")return;

     const m=a.message;
     if(!m?.content)return;
     if(storage.ignoreBots&&m.author?.bot)return;
     if(storage.ignoreSelf&&m.author?.id===UserStore?.getCurrentUser?.()?.id)return;

     setTimeout(()=>translateMessage(m,false),80);
    }catch(e){
     err("auto",e);
    }
   })
  );
 }catch(e){
  err("installAuto",e);
 }
}

function Settings(){
 if(!React||!RN?.View||!RN?.Text)return null;

 const[,force]=React.useReducer(x=>x+1,0);
 const [showKey,setShowKey]=React.useState?React.useState(false):[false,()=>{}];
 const [testing,setTesting]=React.useState?React.useState(false):[false,()=>{}];

 const S=(k,v)=>{
  storage[k]=v;
  force();
 };

 const V=RN.View;
 const T=RN.Text;
 const SV=RN.ScrollView||V;
 const Sw=RN.Switch;
 const P=RN.Pressable||RN.TouchableOpacity||V;
 const I=RN.TextInput;

 const st={
  root:{padding:16,gap:10},
  h:{fontSize:22,fontWeight:"700",color:"#f2f3f5"},
  c:{padding:12,borderRadius:10,backgroundColor:"#2b2d31",gap:8},
  t:{fontSize:15,color:"#f2f3f5",flex:1},
  sub:{fontSize:12,color:"#b5bac1"},
  warn:{fontSize:12,color:"#f0b232"},
  ok:{fontSize:12,color:"#23a55a"},
  r:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8},
  inp:{backgroundColor:"#1e1f22",color:"#fff",padding:10,borderRadius:7},
  b:{padding:10,borderRadius:7,backgroundColor:"#404249"},
  bo:{backgroundColor:"#5865f2"},
  bt:{color:"#fff",textAlign:"center",fontWeight:"600"}
 };

 const row=(l,k)=>
  React.createElement(
   V,{style:st.r},
   React.createElement(T,{style:st.t},l),
   Sw&&React.createElement(Sw,{
    value:!!storage[k],
    onValueChange:v=>S(k,v)
   })
  );

 const btn=(l,fn,on,disabled)=>
  React.createElement(
   P,{
    onPress:disabled?undefined:fn,
    disabled:!!disabled,
    style:[st.b,on&&st.bo,disabled&&{opacity:0.5}]
   },
   React.createElement(T,{style:st.bt},l)
  );

 const testProvider=async()=>{
  if(testing)return;
  try{
   setTesting?.(true);
   const t=await translateText("Hello, how are you?");
   showResult("Hello, how are you?",t);
   toast("Çeviri sağlayıcısı çalışıyor");
  }catch(e){
   toast(`Test başarısız: ${e?.message||e}`);
  }finally{
   setTesting?.(false);
   force();
  }
 };

 const providerInfo=storage.provider==="libre"
  ?"LibreTranslate seçili. Sunucun API key istiyorsa aşağıya gir; istemiyorsa boş bırak."
  :"Google Web seçili. API key gerekmez. Bu resmi Google Cloud API değildir.";

 return React.createElement(
  SV,{contentContainerStyle:st.root},

  React.createElement(T,{style:st.h},"Kettu Translate"),

  React.createElement(
   V,{style:st.c},
   row("Aktif","enabled"),
   row("Mesaj içinde çeviriyi göster","inline"),
   row("Gelen mesajları otomatik çevir","autoIncoming"),
   row("Botları atla","ignoreBots"),
   row("Kendi mesajımı atla","ignoreSelf"),
   row("Mention / emoji / link / kodu koru","protectMarkdown"),
   row("Dil etiketini göster","showLanguageTag")
  ),

  React.createElement(
   V,{style:st.c},

   React.createElement(T,{style:st.t},"Hedef dil kodu"),

   I&&React.createElement(I,{
    style:st.inp,
    value:String(storage.targetLanguage||""),
    onChangeText:v=>S("targetLanguage",v.trim().toLowerCase()),
    placeholder:"tr / en / de / fr / es",
    autoCapitalize:"none",
    autoCorrect:false
   }),

   React.createElement(T,{style:st.t},"Çeviri sağlayıcısı"),

   btn(
    "Google Web • API key gerekmez",
    ()=>S("provider","google"),
    storage.provider==="google"
   ),

   btn(
    "LibreTranslate • API key opsiyonel",
    ()=>S("provider","libre"),
    storage.provider==="libre"
   ),

   React.createElement(
    T,
    {style:storage.provider==="libre"?st.warn:st.sub},
    providerInfo
   ),

   storage.provider==="libre"&&I
    ?React.createElement(
      React.Fragment,
      null,

      React.createElement(T,{style:st.t},"LibreTranslate endpoint"),

      React.createElement(I,{
       style:st.inp,
       value:String(storage.libreEndpoint||""),
       onChangeText:v=>S("libreEndpoint",v.trim()),
       placeholder:"https://sunucu.example/translate",
       autoCapitalize:"none",
       autoCorrect:false
      }),

      React.createElement(T,{style:st.t},"LibreTranslate API Key"),

      React.createElement(I,{
       style:st.inp,
       value:String(storage.libreApiKey||""),
       onChangeText:v=>S("libreApiKey",v.trim()),
       placeholder:"API key yoksa boş bırak",
       autoCapitalize:"none",
       autoCorrect:false,
       secureTextEntry:!showKey
      }),

      btn(
       showKey?"API key'i gizle":"API key'i göster",
       ()=>setShowKey?.(!showKey),
       false
      ),

      React.createElement(
       T,
       {style:st.sub},
       "API key yalnızca seçtiğin LibreTranslate endpoint'ine gönderilir."
      )
     )
    :null,

   btn(
    testing?"Test ediliyor...":"Sağlayıcıyı test et",
    testProvider,
    false,
    testing
   )
  ),

  React.createElement(
   V,{style:st.c},

   React.createElement(
    T,
    {style:st.sub},
    `Flux ${diag.flux?"OK":"YOK"} | Row ${diag.row?"OK":"YOK"} | Menü ${diag.sheet?"OK":"YOK"}\n`+
    `Sağlayıcı: ${diag.lastProvider||"-"} | İstek ${diag.requests} | Başarılı ${diag.success} | Hata ${diag.failed} | Inline ${diag.inline}`+
    `${diag.lastError?`\nSon hata: ${diag.lastError}`:""}`
   ),

   btn("Çeviri önbelleğini temizle",()=>{
    cache.clear();
    pending.clear();
    toast("Çeviri önbelleği temizlendi");
    force();
   })
  )
 );
}

function onLoad(){
 defaults();
 installAuto();
 installRow();
 installSheet();
}

function onUnload(){
 while(unpatches.length){
  try{unpatches.pop()?.()}catch{}
 }
 cache.clear();
 pending.clear();
}

return {
 onLoad,
 onUnload,
 settings:Settings,
 __test:{
  protect,
  restore,
  translateText,
  deepTextPatch
 }
};

})(vendetta.metro,vendetta.metro.common,vendetta.patcher,vendetta.plugin,vendetta.logger,vendetta.ui,vendetta.utils);
