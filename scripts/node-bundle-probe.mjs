import fs from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const root=process.argv[2];
const admission=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
if(admission.repoDir!=='/testbed'||admission.pythonPrefix!=='/opt/miniconda3/envs/testbed'||admission.node.path!=='/opt/agent/node/bin/node'||!admission.env.PATH)throw Error('Actual official environment receipt required');
const runtime=admission.pythonPrefix;
fs.mkdirSync(root);
fs.mkdirSync(root+'/workspace');
fs.writeFileSync(root+'/workspace/executable','before',{mode:0o755,flag:'wx'});
fs.mkdirSync(root+'/external');
const requests=[];let failure,processRef,proof=false;
const actions=[
 {name:'write',input:{path:'executable',content:'after'}},
 {name:'exec',input:{command:runtime+'/bin/python',args:['-c',`import os,sys,pathlib; assert sys.prefix==${JSON.stringify(runtime)}; assert os.stat('executable').st_mode&0o777==0o755; p=pathlib.Path('/tmp/remaining63-cross-workspace'); p.write_text('ok'); assert p.read_text()=='ok'; p.unlink(); print('EXEC_VENV_MODE_CROSS_WORKSPACE_OK')`]}},
 {name:'write',input:{path:root+'/external/file',content:'probe needle'}},
 {name:'read',input:{path:root+'/external/file'}},
 {name:'stat',input:{path:root+'/external/file'}},
 {name:'list',input:{path:root+'/external'}},
 {name:'search',input:{path:root+'/external',query:'needle'}},
 {name:'edit',input:{path:root+'/external/file',oldText:'probe',newText:'verified',expectedOccurrences:1}},
 {name:'process-start',input:{argv:['python3','-c',`import sys; assert sys.prefix==${JSON.stringify(runtime)}; print('PROCESS_VENV_OK')`],cwd:'.',lifetimeMs:60000}},
];
const provider=createServer((req,res)=>{void receive(req,res).catch(error=>{failure=String(error);res.writeHead(500);res.end(failure);});});
async function receive(req,res){
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
 if(requests.length>20)throw Error('Scripted probe exceeded read bound');
 let call;
 if(requests.length===1)call=actions[0];
 else{
  const result=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);
  if(requests.length<=actions.length){
   if(result.kind!=='known'||result.status!=='succeeded')throw Error(JSON.stringify(result));
   if(requests.length===3&&!JSON.stringify(result).includes('EXEC_VENV_MODE_CROSS_WORKSPACE_OK'))throw Error('Missing exec proof');
   if(requests.length===5&&result.payload.content!=='probe needle')throw Error('Missing structured external read proof');
   if(requests.length===7&&result.payload.entries[0].name!=='file')throw Error('Missing external list proof');
   if(requests.length===8&&result.payload.matches[0].path!==root+'/external/file')throw Error('External search logical identity differs');
   call=actions[requests.length-1];
  }else if(requests.length===actions.length+1){
   if(result.kind!=='known'||result.status!=='accepted')throw Error(JSON.stringify(result));
   if(fs.readFileSync(root+'/external/file','utf8')!=='verified needle')throw Error('Missing external edit proof');
   processRef=result.payload.processRef;call={name:'process-read',input:{processRef,waitMs:5000,maxBytes:65536}};
  }else{
   if(result.kind!=='known'||result.status!=='succeeded')throw Error(JSON.stringify(result));
   if(result.payload.status==='exited'){
    if(result.payload.exitCode!==0||!result.payload.stdout.includes('PROCESS_VENV_OK'))throw Error(JSON.stringify(result));proof=true;
   }else call={name:'process-read',input:{processRef,waitMs:5000,maxBytes:65536}};
  }
 }
 const message=call?{role:'assistant',content:'',tool_calls:[{id:'probe-'+requests.length,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content:'preflight complete'};
 const common={id:'probe-'+requests.length,created:1,model:'scripted-preflight'};const finish_reason=call?'tool_calls':'stop';
 if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});const delta=call?{...message,tool_calls:message.tool_calls.map(c=>({...c,index:0}))}:message;res.end([{...common,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},{...common,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason}]}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n');}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...common,object:'chat.completion',choices:[{index:0,message,finish_reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
}
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const out=fs.openSync(root+'/stdout.txt','wx'),err=fs.openSync(root+'/stderr.txt','wx');
const child=spawn(admission.node.path,['/opt/agent/best-agent.cjs','run','--no-base-instructions','--workspace',root+'/workspace','--workspace-backend','plain','--workspace-authorization','unrestricted','--command-policy','path','--process-isolation','host','--workspace-grant','read','--workspace-grant','write','--workspace-grant','exec','--max-model-cycles','2251799813685247','--attempt-evidence',root+'/evidence.jsonl','Environment probe only. No task model is called.'],{cwd:root+'/workspace',env:{...admission.env,HOME:root+'/home',BEST_AGENT_PROVIDER_KIND:'openai',BEST_AGENT_PROVIDER_MODEL:'scripted-preflight',BEST_AGENT_PROVIDER_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,BEST_AGENT_PROVIDER_API_KEY:'local-probe-only',BEST_AGENT_PROVIDER_COMPATIBILITY_MODE:'compatible',BEST_AGENT_PROVIDER_CONFIG:root+'/no-provider.json',BEST_AGENT_STORAGE_ROOT:root+'/storage',BEST_AGENT_PROVIDER_TIMEOUT_MS:'15000'},stdio:['ignore',out,err],detached:true});
let timedOut=false;const timer=setTimeout(()=>{timedOut=true;process.kill(-child.pid,'SIGKILL');},90000);
const result=await new Promise(r=>{child.once('error',e=>r({error:String(e)}));child.once('close',(status,signal)=>r({status,signal}));});
clearTimeout(timer);provider.closeAllConnections();await new Promise(r=>provider.close(r));fs.closeSync(out);fs.closeSync(err);
fs.writeFileSync(root+'/requests.json',JSON.stringify(requests),{flag:'wx'});
const sqliteFiles=[];
function inspectStorage(directory){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const filename=directory+'/'+entry.name;
  if(entry.isDirectory())inspectStorage(filename);
  else if(entry.isFile()){
   const fd=fs.openSync(filename,'r'),header=Buffer.alloc(16);let bytes;
   try{bytes=fs.readSync(fd,header,0,16,0);}finally{fs.closeSync(fd);}
   if(bytes===16&&header.toString('binary')==='SQLite format 3\0'){
    const database=new DatabaseSync(filename,{readOnly:true});
    try{const check=database.prepare('PRAGMA quick_check').all();if(check.length!==1||Object.values(check[0])[0]!=='ok')throw Error('SQLite quick_check failed: '+filename);sqliteFiles.push({path:filename,tables:database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),quickCheck:check});}finally{database.close();}
   }
  }
 }
}
try{inspectStorage(root+'/storage');if(sqliteFiles.length===0)throw Error('CLI did not persist a SQLite database');}catch(error){failure=failure??String(error);}
const receipt={...result,timedOut,failure,proof,requests:requests.length,realProvider:false,sqliteFiles};fs.writeFileSync(root+'/result.json',JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify(receipt));if(result.status!==0||timedOut||failure||!proof)process.exitCode=1;
