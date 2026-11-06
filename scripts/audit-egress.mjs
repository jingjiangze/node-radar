#!/usr/bin/env node
// Audit endpoint infrastructure and the actual proxy egress observed by Cloudflare.
// Reports classifications as evidence, never infer "Cloudflare exit" from a Cloudflare colo alone.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = new URL('../', import.meta.url);
const DIST = new URL('../dist/', import.meta.url);
const API = 'http://127.0.0.1:9090';
const PORT = 7890;
const SAMPLE = Math.max(1, Math.min(24, Number(process.env.EGRESS_SAMPLE || 12)));
const TIMEOUT = 12;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v, n=160) => String(v ?? '').replace(/[\r\n\t]/g, ' ').slice(0,n);
const unique = xs => [...new Set(xs.filter(Boolean))];

function isPublicIp(ip) {
  if (net.isIP(ip) === 4) {
    const a = ip.split('.').map(Number);
    if (a.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    const [x,y] = a;
    return !(x===0 || x===10 || x===127 || x>=224 || (x===169&&y===254) ||
      (x===172&&y>=16&&y<=31) || (x===192&&y===168) || (x===100&&y>=64&&y<=127) ||
      (x===192&&y===0) || (x===198&&(y===18||y===19)) || (x===203&&y===0));
  }
  if (net.isIP(ip) === 6) {
    const s=ip.toLowerCase();
    return !(s==='::1'||s==='::'||s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb')||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('ff')||s.startsWith('2001:db8:'));
  }
  return false;
}

async function resolvePublic(host) {
  if (net.isIP(host)) return isPublicIp(host) ? [host] : [];
  try {
    const rows = await dns.lookup(host, { all: true, verbatim: true });
    return unique(rows.map(x => x.address).filter(isPublicIp)).slice(0,4);
  } catch { return []; }
}

async function lookupIps(ips) {
  const out = new Map();
  for (let i=0;i<ips.length;i+=100) {
    const batch=ips.slice(i,i+100);
    try {
      const r=await fetch('http://ip-api.com/batch?fields=status,message,query,countryCode,regionName,city,isp,org,as,hosting,proxy,mobile', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(batch.map(query=>({query,fields:'status,message,query,countryCode,regionName,city,isp,org,as,hosting,proxy,mobile'}))),
        signal:AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error('ip-api HTTP '+r.status);
      const data=await r.json();
      for (const row of data) if (row.query) out.set(row.query,row);
    } catch(e) { console.warn('[ip-lookup]',safe(e.message)); }
  }
  return out;
}

function classifyNetwork(meta={}) {
  const asn=String(meta.as||'').match(/AS(\d+)/i)?.[1] || '';
  const owner=[meta.org,meta.isp,meta.as].join(' ').toLowerCase();
  const cloudflare = asn==='13335' || /cloudflare/.test(owner);
  const hosting = meta.hosting===true || /hosting|datacenter|data center|cloud|vps|server|colo|compute|cloud provider/i.test(owner);
  return { asn:asn?Number(asn):null, networkOwner:safe(meta.org||meta.isp||''), isp:safe(meta.isp||''), cloudflareNetwork:cloudflare, hostingSignal:hosting, hostingProviderFlag:meta.hosting===true, proxyFlag:meta.proxy===true, mobileFlag:meta.mobile===true };
}

async function cfTrace() {
  const raw=execFileSync('curl',['-fsS','-x',`http://127.0.0.1:${PORT}`,'--max-time',String(TIMEOUT),'https://www.cloudflare.com/cdn-cgi/trace'],{encoding:'utf8',timeout:(TIMEOUT+3)*1000});
  const fields=Object.fromEntries(raw.trim().split(/\r?\n/).map(x=>{const i=x.indexOf('=');return i>0?[x.slice(0,i),x.slice(i+1)]:['',''];}).filter(x=>x[0]));
  if (!fields.ip || !fields.colo) throw new Error('CF trace missing ip/colo');
  return { ip:fields.ip, colo:fields.colo, country:fields.loc||null, warp:fields.warp||null, gateway:fields.gateway||null, httpProtocol:fields.http||null };
}

function pickNodes(proxies) {
  const byType=new Map();
  for (const p of proxies) { const k=p.type||'unknown'; if(!byType.has(k))byType.set(k,[]); byType.get(k).push(p); }
  const out=[];
  for (const list of byType.values()) {
    const shuffled=list.slice().sort(()=>Math.random()-.5);
    out.push(...shuffled.slice(0,Math.max(2,Math.ceil(SAMPLE/byType.size))));
  }
  return out.slice(0,SAMPLE);
}

let doc;
try { doc=yaml.load(fs.readFileSync(new URL('../dist/clash.yaml',import.meta.url),'utf8')); }
catch(e) { console.error('Missing dist/clash.yaml:',e.message); process.exit(1); }
const proxies=(doc.proxies||[]).filter(p=>p&&p.server&&p.port&&p.type);
if (!proxies.length) { console.error('No proxies available for egress audit'); process.exit(1); }
const sample=pickNodes(proxies);
const names=sample.map((p,i)=>`egress-${i}-${String(p.name||p.server).replace(/[^\w.-]/g,'_').slice(0,24)}`);
const config={
  'mixed-port':PORT,'allow-lan':false,mode:'rule','log-level':'error','external-controller':'127.0.0.1:9090',
  proxies:sample.map((p,i)=>({...p,name:names[i]})),
  'proxy-groups':[{name:'AUDIT',type:'select',proxies:names}],rules:['MATCH,AUDIT']
};
fs.writeFileSync('egress-audit-config.yaml',yaml.dump(config,{lineWidth:4096}));
const bin=process.env.MIHOMO_BIN||'./mihomo';
const proc=spawn(bin,['-d','.','-f','egress-audit-config.yaml'],{stdio:['ignore','pipe','pipe']});
let logs='';
proc.stdout.on('data',d=>logs+=d.toString()); proc.stderr.on('data',d=>logs+=d.toString());
let ready=false;
for(let i=0;i<30;i++){await sleep(1000);try{const r=await fetch(API+'/version');if(r.ok){ready=true;break;}}catch{}}
if(!ready){proc.kill('SIGKILL');console.error('Mihomo API unavailable',logs.slice(-500));process.exit(1);}

const rows=[];
for(let i=0;i<sample.length;i++){
  const p=sample[i], name=names[i];
  let result={name:safe(p.name||name),type:p.type,endpoint:safe(p.server),port:Number(p.port),endpointIps:[],endpointNetwork:[],egress:null,status:'failed',error:null};
  try{
    result.endpointIps=await resolvePublic(String(p.server));
    const sw=await fetch(API+'/proxies/AUDIT',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
    if(!sw.ok)throw new Error('proxy selection '+sw.status);
    await sleep(350);
    result.egress=await cfTrace();
    result.status='proxy-egress-confirmed';
  }catch(e){result.error=safe(e.message,180);}
  rows.push(result);
  console.log(result.status,result.name,result.egress?.ip||result.error);
}
try{proc.kill('SIGKILL');}catch{}

const ips=unique(rows.flatMap(r=>[...r.endpointIps,...(r.egress?.ip?[r.egress.ip]:[])]).filter(isPublicIp));
const meta=await lookupIps(ips);
for(const row of rows){
  row.endpointNetwork=row.endpointIps.map(ip=>({ip,...classifyNetwork(meta.get(ip)||{})}));
  if(row.egress){
    const m=meta.get(row.egress.ip)||{};
    row.egress={...row.egress,...classifyNetwork(m),countryCode:m.countryCode||row.egress.country||null,region:safe(m.regionName||''),city:safe(m.city||''),hostingFlag:m.is_datacenter===true||classifyNetwork(m).hostingSignal,proxyFlag:m.is_proxy===true};
    row.egress.classification = row.egress.warp==='on' ? 'cloudflare-warp-egress' :
      row.egress.cloudflareNetwork ? 'cloudflare-owned-egress-ip' :
      row.egress.colo ? 'cloudflare-edge-observed-egress-owner-unconfirmed' : 'other-or-unclassified-egress';
  }
}
const report={
  generatedAt:new Date().toISOString(),vantage:'GitHub Actions runner (US; not representative of all client regions)',
  method:'Mihomo proxy selection -> HTTPS Cloudflare /cdn-cgi/trace -> IP ASN/hosting metadata lookup',
  sample:rows.length,confirmed:rows.filter(r=>r.status==='proxy-egress-confirmed').length,
  cfWarp:rows.filter(r=>r.egress?.classification==='cloudflare-warp-egress').length,
  cfOwnedExit:rows.filter(r=>r.egress?.classification==='cloudflare-owned-egress-ip').length,
  cfEdgeObserved:rows.filter(r=>r.egress?.colo).length,rows
};
fs.mkdirSync(DIST,{recursive:true});
fs.writeFileSync(new URL('egress-audit.json',DIST),JSON.stringify(report,null,2)+'\n');
const cf=rows.filter(r=>r.egress?.classification==='cloudflare-warp-egress'||r.egress?.classification==='cloudflare-owned-egress-ip');
fs.writeFileSync(new URL('cf-egress.json',DIST),JSON.stringify({generatedAt:report.generatedAt,count:cf.length,nodes:cf},null,2)+'\n');
const dc=rows.filter(r=>r.egress?.hostingFlag||r.endpointNetwork.some(x=>x.hostingSignal));
fs.writeFileSync(new URL('datacenter-audit.json',DIST),JSON.stringify({generatedAt:report.generatedAt,count:dc.length,nodes:dc},null,2)+'\n');
console.log(JSON.stringify({sample:report.sample,confirmed:report.confirmed,cfWarp:report.cfWarp,cfOwnedExit:report.cfOwnedExit,cfEdgeObserved:report.cfEdgeObserved,datacenterSignals:dc.length}));
if(report.confirmed<Math.min(3,Math.ceil(sample.length/4))) process.exitCode=1;
