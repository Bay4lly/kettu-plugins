const fs=require("fs"),vm=require("vm"),assert=require("assert"),{TextEncoder,TextDecoder}=require("util"),{webcrypto}=require("crypto");
function makeEnv(extra={}){
 const storage=extra.storage||{}; const modules=[]; const stores={}; const names={};
 function add(m){modules.push(m);return m} function store(n,v){stores[n]=v;return v} function named(n,v){names[n]=v;return v}
 const patcher={
  before(name,obj,cb){const orig=obj[name];obj[name]=function(...args){cb(args);return orig.apply(this,args)};return()=>{obj[name]=orig}},
  after(name,obj,cb){const orig=obj[name];obj[name]=function(...args){const r=orig.apply(this,args);const n=cb(args,r);return n===undefined?r:n};return()=>{obj[name]=orig}},
  instead(name,obj,cb){const orig=obj[name];obj[name]=function(...args){const self=this;const call=(...a)=>orig.apply(self,a.length?a:args);return cb.call(self,args,call)};return()=>{obj[name]=orig}}
 };
 const React={createElement:(type,props,...children)=>({type,props:{...(props||{}),children:children.length<=1?children[0]:children}}),Fragment:"Fragment"};
 const RN={View:function View(){},Text:function Text(){},ScrollView:function ScrollView(){},Switch:function Switch(){},Pressable:function Pressable(){},TouchableOpacity:function TouchableOpacity(){},TextInput:function TextInput(){},Image:function Image(){},Vibration:{calls:[],vibrate(x){this.calls.push(x)}},Linking:{opened:[],async openURL(u){this.opened.push(u);return true}},processColor:x=>x,StyleSheet:{flatten:a=>a}};
 const common={React,ReactNative:RN};
 const metro={common,findByProps:(...ps)=>modules.find(m=>m&&ps.every(p=>p in m)),findByStoreName:n=>stores[n],findByName:n=>names[n]};
 const vendetta={metro,patcher,plugin:{storage},logger:{log(){},error(){}},ui:{toasts:[],showToast(s){this.toasts.push(String(s))},components:{}},utils:{}};
 const ctx={vendetta,console,TextEncoder,TextDecoder,crypto:webcrypto,btoa:s=>Buffer.from(s,"binary").toString("base64"),atob:s=>Buffer.from(s,"base64").toString("binary"),fetch:extra.fetch||global.fetch,setTimeout:(fn)=>{fn();return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){},Date,Map,Set,WeakMap,WeakSet,Array,Object,String,Number,Math,JSON,RegExp,Promise,Uint8Array,Error};ctx.globalThis=ctx;
 return {ctx,storage,modules,stores,names,add,store,named,patcher,RN,vendetta};
}
function load(env){const code=fs.readFileSync(require("path").join(__dirname,"index.js"),"utf8");return vm.runInNewContext(code,env.ctx,{filename:"index.js"});}

(()=>{const env=makeEnv();const users={u1:{id:"u1",username:"Ali"},u2:{id:"u2",username:"Veli"},me:{id:"me",username:"Me"}};env.store("UserStore",{getCurrentUser:()=>users.me,getUser:id=>users[id]});env.store("SelectedChannelStore",{getChannelId:()=>"c"});env.store("TypingStore",{emitChange(){}});const flux=env.add({subscribe(){},dispatch(a){return a}});let sent=0;const ta=env.add({startTyping(){sent++;return "ok"},stopTyping(){}});env.add({useTypingText(){return "orig"}});const p=load(env);p.onLoad();p.__test.add("c","u1",Date.now()-3200);p.__test.add("c","u2",Date.now()-1200);const s=p.__test.format("c");assert(s.includes("Ali")&&s.includes("Veli")&&s.includes("saniyedir"));env.storage.hideOwnTyping=true;assert.strictEqual(ta.startTyping("c"),undefined);assert.strictEqual(sent,0);env.storage.hideOwnTyping=false;assert.strictEqual(ta.startTyping("c"),"ok");assert.strictEqual(sent,1);flux.dispatch({type:"TYPING_START",channelId:"c",userId:"u1"});p.onUnload();console.log("PASS BetterTyping");})();
