#!/usr/bin/env node
'use strict';

/**
 * PlaneKey:TMrFS + RootRabbit:Rgano v1.5.8
 * Dependency-free artifact memory index and structural matcher.
 *
 * This component powers PlaneKey's memory layer:
 * - TMrFS: persistent artifact memory indexes over archives/files.
 * - Rgano: structural/pattern scoring across routes, imports, ids, residue, and roles.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const VERSION = '1.5.8';
const TEXT_EXT = new Set(['.js','.mjs','.cjs','.json','.html','.htm','.css','.md','.txt','.yml','.yaml','.toml','.env','.sql','.ts','.tsx','.jsx','.rs','.py']);
const BINARY_EXT = new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.ttf','.eot','.pdf','.mp4','.mp3','.wav','.zip','.7z','.rar','.gz','.tar']);
// 'target' = Rust build output (can be gigabytes of compiled artifacts +
// vendored source copies); '.venv'/'venv'/'__pycache__' = Python; 'vendor'
// = Go/PHP vendored deps. None are first-party source, all were being
// walked and read. (node_modules/.git already here.)
const SKIP_DIRS = new Set(['node_modules','.git','__MACOSX','dist','build','.cache','coverage','.next','.vercel','target','.venv','venv','__pycache__','vendor','.mypy_cache','.pytest_cache','.gradle','.idea']);
const AGENT_DIRS = new Set(['.claude','.openai','.gemini','.huggingface','.aws','.azure','.ibm','agent-state','agents','mcp','llm-runtime','model-runtime']);

function nowIso(){ return new Date().toISOString(); }
function exists(p){ try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p){ try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p){ try { return fs.statSync(p).isFile(); } catch { return false; } }
function relUnix(root, file){ return path.relative(root, file).replace(/\\/g,'/'); }
function normPath(p){ return String(p || '').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+/, ''); }
function slug(s){ return String(s || 'memory').replace(/[^a-z0-9_.-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,120) || 'memory'; }
function sha256(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }
async function sha256File(file){ return sha256(await fsp.readFile(file)); }
function shortHash(h,n=12){ return String(h || '').slice(0,n); }
async function mkdirp(p){ await fsp.mkdir(p,{recursive:true}); }
async function writeJson(file,obj){ await mkdirp(path.dirname(file)); await fsp.writeFile(file, JSON.stringify(obj,null,2)+'\n'); }
async function writeText(file,text){ await mkdirp(path.dirname(file)); await fsp.writeFile(file, text); }
function readJson(file){ return JSON.parse(fs.readFileSync(file,'utf8')); }
function parseArgs(argv){
  const pos=[]; const flags={};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a.startsWith('--')){
      const k=a.slice(2);
      if(k.includes('=')){ const [kk,...rest]=k.split('='); flags[kk]=rest.join('='); }
      else if(argv[i+1] && !argv[i+1].startsWith('--')) flags[k]=argv[++i];
      else flags[k]=true;
    } else pos.push(a);
  }
  return {pos,flags};
}
function run(cmd,args,opts={}){
  return cp.spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024*100,stdio: opts.stdio || 'pipe',...opts});
}

async function walk(root, opts={}, dir=root, out=[]){
  let entries=[];
  try { entries = await fsp.readdir(dir,{withFileTypes:true}); } catch { return out; }
  for(const ent of entries){
    const full=path.join(dir, ent.name);
    const rel=normPath(path.relative(root, full));
    if(!rel) continue;
    const parts=rel.split('/');
    if(parts.some(p=>SKIP_DIRS.has(p))) continue;
    if(ent.isDirectory()) await walk(root, opts, full, out);
    else if(ent.isFile()) out.push({abs:full, rel});
  }
  return out;
}

async function readTextSafe(file, maxBytes=2*1024*1024){
  const st=await fsp.stat(file);
  if(st.size > maxBytes) return null;
  const buf=await fsp.readFile(file);
  return textFromBuf(buf, path.extname(file).toLowerCase(), maxBytes);
}

// Same size/binary gate as readTextSafe but on an ALREADY-READ buffer — so
// a caller that read the file for its hash doesn't read it a second time
// (buildMemory used to fsp.readFile AND readTextSafe the same file, i.e.
// two full reads + two stats per file; on a large tree that dominated
// wall-clock). Returns utf8 text, or null for oversized/binary content.
function textFromBuf(buf, ext, maxBytes=2*1024*1024){
  if(!buf || buf.length > maxBytes) return null;
  if(buf.includes(0)) return null;
  if(!TEXT_EXT.has(ext) && BINARY_EXT.has(ext)) return null;
  return buf.toString('utf8');
}

async function extractZip(zipPath, dest){
  await mkdirp(dest);
  // Prefer tar because modern Windows and Unix have it. Fallback to PowerShell Expand-Archive.
  let r = run('tar', ['-xf', zipPath, '-C', dest]);
  if(r.status === 0) return;
  if(process.platform === 'win32'){
    const ps = `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(dest)} -Force`;
    r = run('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps]);
    if(r.status === 0) return;
  }
  r = run('unzip', ['-oq', zipPath, '-d', dest]);
  if(r.status === 0) return;
  throw new Error(`Could not extract zip: ${zipPath}\n${r.stderr || r.stdout}`);
}

async function collectSources(input, tempRoot, opts={}){
  const abs=path.resolve(input);
  if(!exists(abs)) throw new Error(`Input not found: ${abs}`);
  const sources=[];
  const maxZips=Number(opts.maxZips || 1000);
  let zipCount=0;

  async function addZip(zipFile, label, originChain=[]){
    if(zipCount++ > maxZips) return;
    const safe=slug(label + '-' + zipCount);
    const dest=path.join(tempRoot,'zips',safe);
    await extractZip(zipFile,dest);
    sources.push({kind:'zip', label, root:dest, origin_chain:originChain});
    // recurse nested zips inside extracted content
    const files=await walk(dest);
    for(const f of files){
      if(f.rel.toLowerCase().endsWith('.zip')){
        await addZip(f.abs, `${label}::${f.rel}`, originChain.concat(label));
      }
    }
  }

  if(isFile(abs) && abs.toLowerCase().endsWith('.zip')){
    await addZip(abs, path.basename(abs));
  } else if(isDir(abs)){
    sources.push({kind:'folder', label:path.basename(abs) || abs, root:abs, origin_chain:[]});
    const files=await walk(abs);
    for(const f of files){
      if(f.rel.toLowerCase().endsWith('.zip')) await addZip(f.abs, f.rel, ['filesystem']);
    }
  } else {
    throw new Error('Input must be folder or zip');
  }
  return sources;
}

function roleForPath(rel){
  const p=normPath(rel).toLowerCase();
  const base=path.basename(p);
  if(p === '.env' || p.startsWith('.env.') || /secret|credential|token|private/.test(p)) return 'secret_or_credential';
  if(p.split('/').some(x=>AGENT_DIRS.has(x))) return 'agent_runtime';
  if(base === 'server.js' || p.endsWith('/server.js')) return 'server_app_entry';
  if(base === 'package.json') return 'package_manifest';
  if(p.includes('planekey')) return 'planekey_component';
  if(p.includes('rootrabbit') || p.includes('rabbit')) return 'rootrabbit_component';
  if(p.includes('rgano')) return 'rgano_component';
  if(p.includes('tmrfs')) return 'tmrfs_component';
  if(p.startsWith('admin/') || p.includes('/admin/')) return 'admin_ui';
  if(p.startsWith('public/') || p.includes('/public/')) return p.endsWith('.html') ? 'public_page' : 'public_asset';
  if(p.startsWith('tools/') || p.includes('/tools/')) return 'tooling';
  if(p.startsWith('migrations/') || p.includes('/migrations/')) return 'database_migration';
  if(p.endsWith('.html')) return 'html_page';
  if(p.endsWith('.js') || p.endsWith('.ts')) return 'code_module';
  if(p.endsWith('.rs')) return 'rust_module';
  if(p.endsWith('.py')) return 'python_module';
  if(p.endsWith('.md')) return 'documentation';
  if(p.endsWith('.json')) return 'json_config';
  return 'artifact';
}

function layerForSource(label, rel){
  const s=(label+' '+rel).toLowerCase();
  if(/full-export|polsia|debug|live|render/.test(s)) return 'builder_or_live_export';
  if(/canon|conversationchain\.zip|reference/.test(s)) return 'canon_candidate';
  if(/patch|rootrabbit|chainlinks|tiles/.test(s)) return 'patch_branch';
  return 'unknown';
}

function residueSignals(rel,text){
  const p=normPath(rel).toLowerCase();
  const signals=[];
  if(p.split('/').some(x=>AGENT_DIRS.has(x)) || /\.claude|\.openai|\.gemini|agent-state|llm-runtime|model-runtime|mcp\//i.test(text||'')) signals.push('agent_runtime_residue');
  if(/polsia\.app|polsia\.com|conversationchain\.polsia\.app/i.test(text||'')) signals.push('polsia_hosting_residue');
  if(/navigator\.sendBeacon|\/collect\?|\/pixel\?|tracking|analytics|gtag\(|posthog|plausible/i.test(text||'')) signals.push('tracking_or_analytics_surface');
  if(/type=["']email["']|email_capture|email-capture|mailchimp|hubspot|convertkit|sendgrid/i.test(text||'')) signals.push('email_capture_surface');
  if(/ignore (all )?(previous|prior) instructions|prompt injection|system prompt|jailbreak/i.test(text||'')) signals.push('prompt_injection_residue');
  if(/eval\s*\(|new Function\s*\(|document\.write\s*\(|\.innerHTML\s*=|insertAdjacentHTML\s*\(/i.test(text||'')) signals.push('dynamic_js_surface');
  if(p === '.env' || p.startsWith('.env.') || /secret|credential|private|\.pem$|\.key$/i.test(p)) signals.push('secret_or_private_material');
  return Array.from(new Set(signals));
}

// Marks which characters are real CODE (1) vs inside a comment, a fenced
// documentation block, or a string/template literal (0). Route/pattern
// extractors consult this so they stop hallucinating routes from examples
// that live in comments or docs — the #1 source of phantom route counts
// (a tool that documents `app.get('/x')` in a comment was "finding" it).
//
// Deliberately line-oriented so a stray regex literal (common in this very
// file) can only desync one line, never the whole scan. Cross-line state is
// tracked only for /* */ block comments and ``` fenced blocks.
function computeCodeMask(text, ext){
  const n = text.length;
  const mask = new Uint8Array(n); // 0 = non-code by default; 1 = code
  const hashComment = ext === '.py' || ext === '.rb' || ext === '.sh' ||
                      ext === '.yml' || ext === '.yaml' || ext === '.toml';
  let pos = 0, inBlock = false, inFence = false;
  const lines = text.split('\n');
  for(const line of lines){
    // A ``` fence line (optionally escaped as \`\`\` inside a template
    // literal, optionally with a language tag) toggles doc-example mode.
    if(/^\s*\\*`\\*`\\*`/.test(line)){ inFence = !inFence; pos += line.length + 1; continue; }
    if(inFence){ pos += line.length + 1; continue; }
    let j = 0, str = null;
    while(j < line.length){
      const c = line[j], c2 = line[j + 1];
      if(inBlock){ if(c === '*' && c2 === '/'){ inBlock = false; j += 2; continue; } j++; continue; }
      if(str){ if(c === '\\'){ j += 2; continue; } if(c === str){ str = null; j++; continue; } j++; continue; }
      if(c === '/' && c2 === '/') break;                 // line comment → rest non-code
      if(hashComment && c === '#') break;                // Python/shell comment
      if(c === '/' && c2 === '*'){ inBlock = true; j += 2; continue; }
      if(c === "'" || c === '"' || c === '`'){ str = c; j++; continue; }
      mask[pos + j] = 1;                                 // ordinary code char
      j++;
    }
    pos += line.length + 1; // account for the '\n' removed by split
  }
  return mask;
}

function extractStructure(rel,text){
  const out={imports:[],routes:[],functions:[],html_ids:[],forms:[],scripts:[],package_scripts:{},config_keys:[]};
  if(!text) return out;
  const add=(arr,v)=>{ if(v && !arr.includes(v)) arr.push(v); };
  let m;
  // Only accept a route whose ANCHOR token (app/router/@/#) is real code, not
  // an example inside a comment or a ``` doc fence. See computeCodeMask.
  const codeMask = computeCodeMask(text, path.extname(rel).toLowerCase());
  const anchorIsCode = (idx) => codeMask[idx] === 1;
  const importRx=/\b(?:require\(['"]([^'"]+)['"]\)|import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"])/g;
  while((m=importRx.exec(text))) add(out.imports,m[1]||m[2]);
  const routeRx=/\b(?:app|router)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
  while((m=routeRx.exec(text))){ if(anchorIsCode(m.index)) add(out.routes, `${m[1].toUpperCase()} ${m[2]}`); }
  // Rust / Actix attribute macros: #[get("/path")], #[post("/path")], etc.
  const rustRouteRx=/#\[\s*(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\s*\]/g;
  while((m=rustRouteRx.exec(text))){ if(anchorIsCode(m.index)) add(out.routes, `${m[1].toUpperCase()} ${m[2]}`); }
  // Python / Flask / FastAPI / Quart: @app.route("/path"), @router.get("/path"), etc.
  const pyRouteRx=/@(?:app|bp|router|api|blueprint)\.(route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  while((m=pyRouteRx.exec(text))){
    if(!anchorIsCode(m.index)) continue;
    const method = m[1] === 'route' ? 'GET' : m[1].toUpperCase();
    add(out.routes, `${method} ${m[2]}`);
  }
  const fnRx=/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
  while((m=fnRx.exec(text))) add(out.functions,m[1]||m[2]);
  const idRx=/\bid\s*=\s*['"]([^'"]+)['"]/g;
  while((m=idRx.exec(text))) add(out.html_ids,m[1]);
  const formRx=/<form\b[^>]*>/gi;
  while((m=formRx.exec(text))) add(out.forms,m[0].slice(0,200));
  const scriptRx=/<script\b[^>]*src\s*=\s*['"]([^'"]+)['"]/gi;
  while((m=scriptRx.exec(text))) add(out.scripts,m[1]);
  if(path.basename(rel).toLowerCase()==='package.json'){
    try{ const j=JSON.parse(text); out.package_scripts=j.scripts || {}; out.config_keys=Object.keys(j).sort(); } catch {}
  } else if(path.extname(rel).toLowerCase()==='.json'){
    try{ const j=JSON.parse(text); if(j && typeof j==='object' && !Array.isArray(j)) out.config_keys=Object.keys(j).sort(); } catch {}
  }
  for(const k of Object.keys(out)) if(Array.isArray(out[k])) out[k].sort();
  return out;
}

function structureScore(struct){
  return (struct.routes.length*5)+(struct.imports.length*2)+(struct.functions.length*1.5)+(struct.html_ids.length)+(struct.forms.length*3)+(struct.scripts.length*2)+Object.keys(struct.package_scripts||{}).length*2;
}

function rganoSignature(rel,text,struct,role){
  const parts=[role, path.basename(rel), path.extname(rel), ...struct.routes, ...struct.imports.slice(0,20), ...struct.functions.slice(0,20), ...struct.html_ids.slice(0,20), ...Object.keys(struct.package_scripts||{})];
  return sha256(Buffer.from(parts.join('\n')));
}

function trustFor(role, signals, struct, sourceLayer){
  let status='candidate'; let residue=0; let canon=0.5; let risk=0;
  if(role==='secret_or_credential'){ status='quarantine'; risk+=100; residue+=1; }
  if(role==='agent_runtime'){ status='forensic_only'; risk+=60; residue+=0.9; }
  for(const s of signals){
    if(/secret|prompt|dynamic/.test(s)) risk+=40;
    else if(/tracking|email|polsia/.test(s)) risk+=20;
    else risk+=10;
    residue += 0.15;
  }
  if(role.includes('planekey') || role.includes('rootrabbit') || role==='server_app_entry' || role==='package_manifest') canon += 0.2;
  if(sourceLayer==='canon_candidate') canon += 0.15;
  if(sourceLayer==='builder_or_live_export' && signals.length) canon -= 0.2;
  if(struct.routes.length) canon += 0.1;
  residue=Math.max(0,Math.min(1,residue)); canon=Math.max(0,Math.min(1,canon));
  if(risk>=80) status='block';
  else if(risk>=40 && status==='candidate') status='review';
  return {status, residue_score:Number(residue.toFixed(3)), canon_score:Number(canon.toFixed(3)), risk_score:risk};
}

async function buildMemory(input, opts={}){
  const tempRoot=path.join(os.tmpdir(),'pk-memory-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));
  await mkdirp(tempRoot);
  try{
    const sources=await collectSources(input,tempRoot,opts);
    const nodes=[];
    const contentIndex={}; const pathIndex={}; const sourceIndex={}; const structureIndex={}; const trustIndex={}; const signatureIndex={};
    let idCounter=0;
    // Content-addressed analysis cache. A fanout / multi-branch tree holds
    // the SAME file content dozens of times (each branch is a full checkout
    // — e.g. cosmicid/src/lib.rs appeared 29× in the cross-repo scan). The
    // structure parse + residue scan + rgano signature depend only on
    // (content, path-shape), so keying on the content hash + ext + basename
    // lets identical bytes be analyzed ONCE and reused everywhere they recur.
    //
    // This same content-hash map is the substrate for dependency-level
    // zero-day tracking: every dependency file becomes a content-addressed
    // point, so a vulnerability tagged on one hash lights up every place
    // that exact content appears across every repo/branch — see contentIndex
    // (the "same_hash_as" edges) which already threads identical content
    // together. Analysis-dedup here makes the first-run DB build cheap
    // enough to run that graph over a whole workspace.
    const analysisCache=new Map();
    for(const src of sources){
      const files=await walk(src.root);
      sourceIndex[src.label]={kind:src.kind, root:src.root, origin_chain:src.origin_chain, file_count:0, bytes:0, roles:{}};
      for(const f of files){
        if(f.rel.toLowerCase().endsWith('.zip')) continue;
        const buf=await fsp.readFile(f.abs);
        const hash=sha256(buf);
        const size=buf.length;                              // was a second fsp.stat — buf is the whole file
        const ext=path.extname(f.rel).toLowerCase();
        const text=textFromBuf(buf, ext);                    // was readTextSafe (a THIRD read of the same file)
        const role=roleForPath(f.rel);
        const sourceLayer=layerForSource(src.label,f.rel);
        // Reuse the expensive parse/scan/signature for identical content.
        // Key includes basename so path-shape-sensitive analysis stays
        // correct across a same-hash file that sits at a different path.
        const ckey=hash+'|'+ext+'|'+path.basename(f.rel);
        let cached=analysisCache.get(ckey);
        if(!cached){
          const struct=extractStructure(f.rel,text);
          const signals=residueSignals(f.rel,text || '');
          const sig=rganoSignature(f.rel,text || '',struct,role);
          cached={struct,signals,sig};
          analysisCache.set(ckey,cached);
        }
        const struct=cached.struct;
        const signals=cached.signals;
        const trust=trustFor(role,signals,struct,sourceLayer);
        const sig=cached.sig;
        const nodeId='tmrfs:file:'+shortHash(hash,16)+':'+(idCounter++);
        const node={
          node_id:nodeId,
          type:'file_version',
          path:f.rel,
          filename:path.basename(f.rel),
          ext:path.extname(f.rel).toLowerCase(),
          sha256: opts.private ? undefined : hash,
          hash_short:shortHash(hash,16),
          size:size,
          source_archive:src.label,
          origin_chain:src.origin_chain,
          role,
          layer:sourceLayer,
          status:trust.status,
          canon_score:trust.canon_score,
          residue_score:trust.residue_score,
          risk_score:trust.risk_score,
          route_impact:struct.routes.length>0,
          rgano_signature:sig,
          rgano_signature_short:shortHash(sig,16),
          structure_score:Number(structureScore(struct).toFixed(2)),
          residue_signals:signals,
          structure:struct
        };
        nodes.push(node);
        (contentIndex[hash] ||= []).push(nodeId);
        (pathIndex[f.rel] ||= []).push(nodeId);
        (signatureIndex[sig] ||= []).push(nodeId);
        structureIndex[nodeId]={path:f.rel, role, structure:struct, structure_score:node.structure_score, rgano_signature:sig};
        trustIndex[nodeId]={path:f.rel, role, layer:sourceLayer, ...trust, residue_signals:signals};
        sourceIndex[src.label].file_count++; sourceIndex[src.label].bytes += size;
        sourceIndex[src.label].roles[role]=(sourceIndex[src.label].roles[role]||0)+1;
      }
    }
    const edges=[];
    for(const [hash,ids] of Object.entries(contentIndex)) if(ids.length>1){ for(let i=1;i<ids.length;i++) edges.push({type:'same_hash_as', from:ids[0], to:ids[i], weight:1}); }
    for(const [p,ids] of Object.entries(pathIndex)) if(ids.length>1){ for(let i=1;i<ids.length;i++) edges.push({type:'same_path_as', path:p, from:ids[0], to:ids[i], weight:0.8}); }
    for(const [sig,ids] of Object.entries(signatureIndex)) if(ids.length>1){ for(let i=1;i<ids.length;i++) edges.push({type:'same_rgano_signature_as', from:ids[0], to:ids[i], weight:0.7}); }
    const canonCandidates=nodes.slice().sort((a,b)=> b.canon_score-a.canon_score || a.risk_score-b.risk_score || b.structure_score-a.structure_score).slice(0,200);
    const residueCandidates=nodes.filter(n=>n.residue_score>0 || n.risk_score>0 || n.status!=='candidate').sort((a,b)=>b.risk_score-a.risk_score || b.residue_score-a.residue_score).slice(0,300);
    const graph={schema:'planekey.tmrfs-memory-graph.v1', nodes:nodes.map(n=>({id:n.node_id,path:n.path,role:n.role,layer:n.layer,status:n.status,canon_score:n.canon_score,residue_score:n.residue_score,risk_score:n.risk_score,signature:n.rgano_signature_short})), edges};
    const memory={
      schema:'planekey.tmrfs-artifact-memory.v1',
      generated_at:nowIso(), version:VERSION, input:path.resolve(input), source_count:sources.length, node_count:nodes.length, edge_count:edges.length,
      summary:{
        unique_hashes:Object.keys(contentIndex).length,
        unique_paths:Object.keys(pathIndex).length,
        duplicate_hash_groups:Object.values(contentIndex).filter(v=>v.length>1).length,
        versioned_path_groups:Object.values(pathIndex).filter(v=>v.length>1).length,
        rgano_signature_groups:Object.values(signatureIndex).filter(v=>v.length>1).length,
        residue_candidates:residueCandidates.length,
        canon_candidates:canonCandidates.length
      },
      nodes
    };
    return {memory, contentIndex, pathIndex, sourceIndex, structureIndex, trustIndex, signatureIndex, graph, canonCandidates, residueCandidates};
  } finally {
    if(!opts.keepTemp) await fsp.rm(tempRoot,{recursive:true,force:true}).catch(()=>{});
  }
}

function memoryReportMd(bundle){
  const {memory, sourceIndex, canonCandidates, residueCandidates}=bundle;
  const lines=[];
  lines.push('# PlaneKey:TMrFS + RootRabbit:Rgano Memory Report');
  lines.push('');
  lines.push(`Generated: ${memory.generated_at}`);
  lines.push(`Input: ${memory.input}`);
  lines.push(`Nodes: ${memory.node_count}`);
  lines.push(`Edges: ${memory.edge_count}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  for(const [k,v] of Object.entries(memory.summary)) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## Sources');
  lines.push('');
  for(const [name,src] of Object.entries(sourceIndex).slice(0,80)) lines.push(`- ${name}: ${src.file_count} files, ${src.bytes} bytes`);
  lines.push('');
  lines.push('## Top canon candidates');
  lines.push('');
  for(const n of canonCandidates.slice(0,60)) lines.push(`- ${n.path} — ${n.role} — canon ${n.canon_score} risk ${n.risk_score} source ${n.source_archive}`);
  lines.push('');
  lines.push('## Top residue/risk candidates');
  lines.push('');
  for(const n of residueCandidates.slice(0,80)) lines.push(`- ${n.path} — ${n.status} — risk ${n.risk_score} residue ${n.residue_score} signals ${n.residue_signals.join(',') || 'none'} — ${n.source_archive}`);
  lines.push('');
  lines.push('## Meaning');
  lines.push('');
  lines.push('TMrFS stores the artifact memory. Rgano scores structure and overlap. PlaneKey uses the result to decide what belongs in canon, what needs review, and what stays forensic-only.');
  lines.push('');
  return lines.join('\n');
}

async function commandMemoryBuild(input,flags){
  if(!input) throw new Error('Usage: pk-memory memory build <folder-or-zip> [--name cc-memory] [--out ./reports]');
  const name=slug(flags.name || 'memory-'+Date.now());
  const outRoot=path.resolve(flags.out || './reports');
  const outDir=path.join(outRoot,'memory',name);
  const bundle=await buildMemory(input, flags);
  await mkdirp(outDir);
  await writeJson(path.join(outDir,'TMRFS_MEMORY_INDEX.json'), bundle.memory);
  await writeJson(path.join(outDir,'CONTENT_INDEX.json'), bundle.contentIndex);
  await writeJson(path.join(outDir,'PATH_INDEX.json'), bundle.pathIndex);
  await writeJson(path.join(outDir,'SOURCE_INDEX.json'), bundle.sourceIndex);
  await writeJson(path.join(outDir,'STRUCTURE_INDEX.json'), bundle.structureIndex);
  await writeJson(path.join(outDir,'TRUST_INDEX.json'), bundle.trustIndex);
  await writeJson(path.join(outDir,'RGANO_SIGNATURE_INDEX.json'), bundle.signatureIndex);
  await writeJson(path.join(outDir,'MEMORY_GRAPH.json'), bundle.graph);
  await writeJson(path.join(outDir,'CANON_CANDIDATES.json'), bundle.canonCandidates);
  await writeJson(path.join(outDir,'RESIDUE_CANDIDATES.json'), bundle.residueCandidates);
  await writeText(path.join(outDir,'MEMORY_REPORT.md'), memoryReportMd(bundle));
  console.log(`TMrFS memory built: ${outDir}`);
  console.log(`nodes=${bundle.memory.node_count} edges=${bundle.memory.edge_count} unique_paths=${bundle.memory.summary.unique_paths} residue=${bundle.memory.summary.residue_candidates}`);
}

function loadMemory(report){
  const dir=path.resolve(report);
  const file=isDir(dir)?path.join(dir,'TMRFS_MEMORY_INDEX.json'):dir;
  const memory=readJson(file);
  const base=isDir(dir)?dir:path.dirname(file);
  const load=(name,def)=> exists(path.join(base,name))?readJson(path.join(base,name)):def;
  return {base,memory, pathIndex:load('PATH_INDEX.json',{}), contentIndex:load('CONTENT_INDEX.json',{}), trustIndex:load('TRUST_INDEX.json',{}), structureIndex:load('STRUCTURE_INDEX.json',{}), graph:load('MEMORY_GRAPH.json',{nodes:[],edges:[]})};
}
function findNodes(mem,flags){
  let nodes=mem.memory.nodes || [];
  if(flags.path) nodes=nodes.filter(n=>n.path===normPath(flags.path));
  if(flags.filename) nodes=nodes.filter(n=>n.filename===flags.filename);
  if(flags.role) nodes=nodes.filter(n=>n.role===flags.role);
  if(flags.signal) nodes=nodes.filter(n=>(n.residue_signals||[]).includes(flags.signal));
  return nodes;
}
async function commandMemoryQuery(report,flags){
  if(!report) throw new Error('Usage: pk-memory memory query <report-dir> --path server.js');
  const mem=loadMemory(report);
  const nodes=findNodes(mem,flags).slice(0,Number(flags.limit||50));
  console.log(JSON.stringify({count:nodes.length,nodes},null,2));
}
async function commandMemoryLineage(report,flags){
  if(!report || !flags.path) throw new Error('Usage: pk-memory memory lineage <report-dir> --path server.js');
  const mem=loadMemory(report);
  const nodes=findNodes(mem,flags).sort((a,b)=>a.source_archive.localeCompare(b.source_archive));
  const hashes={}; for(const n of nodes) (hashes[n.hash_short] ||= []).push(n);
  console.log(`# Lineage for ${flags.path}\n`);
  console.log(`versions: ${nodes.length}`);
  console.log(`unique_hashes: ${Object.keys(hashes).length}\n`);
  for(const [h,arr] of Object.entries(hashes)){
    console.log(`## ${h} (${arr.length})`);
    for(const n of arr) console.log(`- ${n.source_archive} | ${n.role} | canon ${n.canon_score} | risk ${n.risk_score} | ${n.status}`);
    console.log('');
  }
}
async function commandMemoryCanonRank(report,flags){
  const mem=loadMemory(report);
  const nodes=(mem.memory.nodes||[]).sort((a,b)=>b.canon_score-a.canon_score || a.risk_score-b.risk_score || b.structure_score-a.structure_score).slice(0,Number(flags.limit||100));
  for(const n of nodes) console.log(`${n.canon_score.toFixed(3)} risk=${n.risk_score} ${n.role.padEnd(24)} ${n.path}  <${n.source_archive}>`);
}
async function commandMemoryResidue(report,flags){
  const mem=loadMemory(report);
  const nodes=(mem.memory.nodes||[]).filter(n=>n.risk_score>0 || n.residue_score>0 || n.status!=='candidate').sort((a,b)=>b.risk_score-a.risk_score || b.residue_score-a.residue_score).slice(0,Number(flags.limit||150));
  for(const n of nodes) console.log(`${String(n.risk_score).padStart(3)} residue=${n.residue_score} ${n.status.padEnd(14)} ${n.path} signals=${(n.residue_signals||[]).join(',')||'none'} <${n.source_archive}>`);
}
async function commandMemoryGraftPlan(report,flags){
  if(!report) throw new Error('Usage: pk-memory memory graft-plan <report-dir> [--out ./reports]');
  const mem=loadMemory(report);
  const nodes=mem.memory.nodes || [];
  const byPath={}; for(const n of nodes) (byPath[n.path] ||= []).push(n);
  const actions=[];
  for(const [p,arr] of Object.entries(byPath)){
    arr.sort((a,b)=>b.canon_score-a.canon_score || a.risk_score-b.risk_score || b.structure_score-a.structure_score);
    const best=arr[0];
    const hasBlock=arr.some(n=>n.status==='block' || n.status==='quarantine' || n.risk_score>=80);
    const action=hasBlock?'quarantine_review':best.canon_score>=0.75 && best.risk_score===0?'accept_best':'review_versions';
    actions.push({path:p, action, best_node:best.node_id, best_source:best.source_archive, versions:arr.length, best_role:best.role, best_canon_score:best.canon_score, best_risk_score:best.risk_score, residue_signals:Array.from(new Set(arr.flatMap(n=>n.residue_signals||[])))});
  }
  actions.sort((a,b)=> (a.action===b.action? a.path.localeCompare(b.path) : a.action.localeCompare(b.action)));
  const outDir=path.join(path.resolve(flags.out || mem.base),'graft-plan-'+Date.now());
  await mkdirp(outDir);
  await writeJson(path.join(outDir,'GRAFT_PLAN.json'), {schema:'planekey.tmrfs-graft-plan.v1', generated_at:nowIso(), actions});
  const md=['# TMrFS/Rgano Graft Plan',''];
  for(const a of actions.slice(0,300)) md.push(`- **${a.action}** ${a.path} — versions ${a.versions}, best ${a.best_source}, risk ${a.best_risk_score}, signals ${a.residue_signals.join(',')||'none'}`);
  await writeText(path.join(outDir,'GRAFT_PLAN.md'), md.join('\n')+'\n');
  console.log(`Graft plan written: ${outDir}`);
}
async function commandRganoScan(input,flags){
  if(!input) throw new Error('Usage: pk-memory rgano scan <folder-or-zip> [--name structure] [--out ./reports]');
  const name=slug(flags.name || 'rgano-'+Date.now());
  const outDir=path.join(path.resolve(flags.out || './reports'),'rgano',name);
  const bundle=await buildMemory(input, flags);
  const rows=bundle.memory.nodes.map(n=>({path:n.path, source:n.source_archive, role:n.role, signature:n.rgano_signature, signature_short:n.rgano_signature_short, structure_score:n.structure_score, routes:n.structure.routes.length, imports:n.structure.imports.length, functions:n.structure.functions.length, html_ids:n.structure.html_ids.length, risk_score:n.risk_score, residue_signals:n.residue_signals}));
  await writeJson(path.join(outDir,'RGANO_STRUCTURE_SCAN.json'), {schema:'rootrabbit.rgano-structure-scan.v1', generated_at:nowIso(), version:VERSION, rows});
  const md=['# RootRabbit:Rgano Structure Scan','','Rgano signatures group artifacts by structural behavior rather than exact hash.',''];
  for(const r of rows.sort((a,b)=>b.structure_score-a.structure_score).slice(0,120)) md.push(`- ${r.structure_score.toFixed(1)} ${r.role} ${r.path} routes=${r.routes} imports=${r.imports} sig=${r.signature_short}`);
  await writeText(path.join(outDir,'RGANO_STRUCTURE_SCAN.md'), md.join('\n')+'\n');
  console.log(`Rgano structure scan written: ${outDir}`);
}
// ──────────────────────────────────────────────────────────────────────────────
// memory timeline — canonical-heritage subcommand
// Walks files, hashes, extracts routes (JS/Rust/Python), and emits a
// time-ordered lineage (epochs, route definitions, canon picks) as a
// queryable SQLite + .sql + Markdown report. Output schema mirrors bridge
// migrations 003 + 009 + 015 so the rows can be ingested by the bridge's
// existing /memory routes without remodelling.
// ──────────────────────────────────────────────────────────────────────────────

// Release date table seeded from bridge/migrations/015_trust_layer.sql `releases`
const RELEASE_DATES = {
  '0.2.14': '2026-05-08T21:34:20Z',
  '0.2.15': '2026-05-08T22:33:00Z',
  '0.2.16': '2026-05-08T22:43:00Z',
  '0.2.17': '2026-05-08T23:06:00Z',
  '0.2.18': '2026-05-13T03:26:00Z',
  '0.2.19': '2026-05-13T06:48:00Z',
  '0.2.20': '2026-05-13T17:20:00Z',
};
const VERSION_RX = /v?0\.2\.(\d+)/;

function languageFor(ext){
  const e = String(ext || '').toLowerCase();
  if(e === '.js' || e === '.mjs' || e === '.cjs' || e === '.ts' || e === '.tsx' || e === '.jsx') return 'js';
  if(e === '.json') return 'json';
  if(e === '.rs') return 'rs';
  if(e === '.py') return 'py';
  if(e === '.sql') return 'sql';
  return null;
}

function sqlEscape(v){
  if(v === null || v === undefined) return 'NULL';
  if(typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if(typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function fileFirstSeenAt(absPath, relPath, text, fallbackMtimeMs){
  // 1) git log --diff-filter=A for first-add date
  try {
    const r = run('git', ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', absPath]);
    if(r.status === 0 && r.stdout){
      const lines = r.stdout.trim().split('\n').filter(Boolean);
      if(lines.length) return lines[lines.length - 1]; // earliest add
    }
  } catch {}
  // 2) version string from path or content header
  const pmatch = (relPath || '').match(VERSION_RX);
  if(pmatch && RELEASE_DATES['0.2.' + pmatch[1]]) return RELEASE_DATES['0.2.' + pmatch[1]];
  if(text){
    const cmatch = text.slice(0, 400).match(VERSION_RX);
    if(cmatch && RELEASE_DATES['0.2.' + cmatch[1]]) return RELEASE_DATES['0.2.' + cmatch[1]];
  }
  // 3) file mtime
  return new Date(fallbackMtimeMs || Date.now()).toISOString();
}

function detectEpochs(nodes){
  // Bucket each node's first_seen_at by language → month, then derive epochs.
  const byLangMonth = {};
  for(const n of nodes){
    if(!n.language) continue;
    const month = (n.first_seen_at || '').slice(0, 7); // YYYY-MM
    if(!month) continue;
    const k = n.language + '|' + month;
    byLangMonth[k] = (byLangMonth[k] || 0) + 1;
  }
  // Per language: first month seen → last month seen, total file_count
  const langSpan = {};
  for(const k of Object.keys(byLangMonth)){
    const [lang, month] = k.split('|');
    const v = byLangMonth[k];
    const s = langSpan[lang] || {language:lang, first:month, last:month, file_count:0};
    if(month < s.first) s.first = month;
    if(month > s.last) s.last = month;
    s.file_count += v;
    langSpan[lang] = s;
  }
  const epochs = [];
  if(langSpan.py) epochs.push({
    epoch_name:'python_era', started_at:langSpan.py.first, ended_at:langSpan.py.last,
    dominant_language:'py', file_count:langSpan.py.file_count
  });
  if(langSpan.js) epochs.push({
    epoch_name:'node_express_era', started_at:langSpan.js.first, ended_at:langSpan.js.last,
    dominant_language:'js', file_count:langSpan.js.file_count
  });
  if(langSpan.rs) epochs.push({
    epoch_name:'rust_actix_era', started_at:langSpan.rs.first, ended_at:langSpan.rs.last,
    dominant_language:'rs', file_count:langSpan.rs.file_count
  });
  if(langSpan.json) epochs.push({
    epoch_name:'json_config_era', started_at:langSpan.json.first, ended_at:langSpan.json.last,
    dominant_language:'json', file_count:langSpan.json.file_count
  });
  return epochs.sort((a,b)=> (a.started_at||'').localeCompare(b.started_at||''));
}

function buildTimelineRows(bundle){
  // Assign sequential integer IDs to each node and produce all rows
  const nodes = bundle.memory.nodes;
  const idByNodeId = {};
  const tmrfsRows = [];
  const routeRows = [];
  for(let i = 0; i < nodes.length; i++){
    const n = nodes[i];
    const id = i + 1;
    idByNodeId[n.node_id] = id;
    const lang = languageFor(n.ext);
    tmrfsRows.push({
      id,
      path: n.path,
      path_hash: sha256(Buffer.from(n.path)),
      content_hash: n.hash_short ? sha256(Buffer.from(n.node_id)).slice(0, 0) || (n.sha256 || ('hash:' + n.hash_short)) : (n.sha256 || ''),
      // The full content hash is in bundle.contentIndex keys; recover it via index of node_id
      rgano_signature_hash: n.rgano_signature,
      language: lang,
      node_kind: 'artifact_version',
      size_bytes: n.size,
      function_count: (n.structure && n.structure.functions ? n.structure.functions.length : 0),
      route_count: (n.structure && n.structure.routes ? n.structure.routes.length : 0),
      canon_score: n.canon_score,
      first_seen_at: n.first_seen_at,
      last_seen_at: n.last_seen_at,
      payload: JSON.stringify({source_archive:n.source_archive, role:n.role, layer:n.layer, status:n.status, risk_score:n.risk_score, residue_signals:n.residue_signals})
    });
    // route_definitions rows
    if(n.structure && n.structure.routes){
      for(const r of n.structure.routes){
        const sp = r.split(/\s+/, 2);
        routeRows.push({
          route: sp[1] || r,
          method: sp[0] || 'GET',
          node_id: id,
          source_language: lang,
          first_seen_at: n.first_seen_at,
          last_seen_at: n.last_seen_at
        });
      }
    }
  }
  // Recover real content_hash by inverting bundle.contentIndex (which maps hash → [nodeId])
  for(const [hash, nodeIds] of Object.entries(bundle.contentIndex || {})){
    for(const nid of nodeIds){
      const intId = idByNodeId[nid];
      if(intId) tmrfsRows[intId - 1].content_hash = hash;
    }
  }
  // tmrfs_edges
  const edgeRows = [];
  for(const e of (bundle.memory.edge_count ? [] : [])){ /* unused */ }
  // bundle.graph.edges has the from/to (string IDs) — convert to integer IDs
  for(const e of (bundle.graph && bundle.graph.edges) || []){
    const from = idByNodeId[e.from];
    const to = idByNodeId[e.to];
    if(from && to){
      edgeRows.push({from_node_id:from, to_node_id:to, edge_kind:e.type, hamming_distance:null});
    }
  }
  // rgano_signatures
  const sigCounts = {};
  for(const r of tmrfsRows){
    if(!r.rgano_signature_hash) continue;
    sigCounts[r.rgano_signature_hash] = sigCounts[r.rgano_signature_hash] || {member_count:0, rep:r.id};
    sigCounts[r.rgano_signature_hash].member_count++;
  }
  const sigRows = Object.entries(sigCounts).map(([sig, v])=>({
    signature_hash:sig, signature_kind:'code_module',
    representative_node_id:v.rep, member_count:v.member_count
  }));
  // canon_picks: pick highest canon_score per content_hash
  const byContent = {};
  for(const r of tmrfsRows){
    if(!r.content_hash) continue;
    if(!byContent[r.content_hash]) byContent[r.content_hash] = {nodes:[], best:r};
    byContent[r.content_hash].nodes.push(r);
    if(r.canon_score > byContent[r.content_hash].best.canon_score) byContent[r.content_hash].best = r;
  }
  const canonRows = Object.entries(byContent).map(([hash, v])=>({
    content_hash:hash, canonical_node_id:v.best.id,
    duplicate_count:v.nodes.length, canon_score:v.best.canon_score
  }));
  return {tmrfsRows, edgeRows, sigRows, routeRows, canonRows};
}

const TIMELINE_DDL = `
CREATE TABLE IF NOT EXISTS tmrfs_nodes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  path_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rgano_signature_hash TEXT,
  language TEXT,
  node_kind TEXT NOT NULL,
  size_bytes INTEGER,
  function_count INTEGER,
  route_count INTEGER,
  canon_score REAL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_tmrfs_nodes_content ON tmrfs_nodes(content_hash);
CREATE INDEX IF NOT EXISTS idx_tmrfs_nodes_path ON tmrfs_nodes(path_hash);
CREATE INDEX IF NOT EXISTS idx_tmrfs_nodes_first_seen ON tmrfs_nodes(first_seen_at);
CREATE TABLE IF NOT EXISTS tmrfs_edges (
  from_node_id INTEGER NOT NULL,
  to_node_id INTEGER NOT NULL,
  edge_kind TEXT NOT NULL,
  hamming_distance INTEGER,
  PRIMARY KEY (from_node_id, to_node_id, edge_kind)
);
CREATE TABLE IF NOT EXISTS rgano_signatures (
  signature_hash TEXT PRIMARY KEY,
  signature_kind TEXT,
  representative_node_id INTEGER,
  member_count INTEGER
);
CREATE TABLE IF NOT EXISTS route_definitions (
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  source_language TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (route, method, node_id)
);
CREATE INDEX IF NOT EXISTS idx_route_first_seen ON route_definitions(first_seen_at);
CREATE TABLE IF NOT EXISTS canon_picks (
  content_hash TEXT PRIMARY KEY,
  canonical_node_id INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  canon_score REAL
);
CREATE TABLE IF NOT EXISTS epoch_markers (
  epoch_name TEXT PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  dominant_language TEXT,
  file_count INTEGER
);
`.trim();

function writeTimelineSqlText(rows, epochs){
  const out = [TIMELINE_DDL, ''];
  out.push('BEGIN;');
  for(const r of rows.tmrfsRows){
    out.push(`INSERT INTO tmrfs_nodes (id,path,path_hash,content_hash,rgano_signature_hash,language,node_kind,size_bytes,function_count,route_count,canon_score,first_seen_at,last_seen_at,payload) VALUES (${[r.id,r.path,r.path_hash,r.content_hash,r.rgano_signature_hash,r.language,r.node_kind,r.size_bytes,r.function_count,r.route_count,r.canon_score,r.first_seen_at,r.last_seen_at,r.payload].map(sqlEscape).join(',')});`);
  }
  for(const e of rows.edgeRows){
    out.push(`INSERT OR IGNORE INTO tmrfs_edges (from_node_id,to_node_id,edge_kind,hamming_distance) VALUES (${[e.from_node_id,e.to_node_id,e.edge_kind,e.hamming_distance].map(sqlEscape).join(',')});`);
  }
  for(const s of rows.sigRows){
    out.push(`INSERT OR REPLACE INTO rgano_signatures (signature_hash,signature_kind,representative_node_id,member_count) VALUES (${[s.signature_hash,s.signature_kind,s.representative_node_id,s.member_count].map(sqlEscape).join(',')});`);
  }
  for(const r of rows.routeRows){
    out.push(`INSERT OR IGNORE INTO route_definitions (route,method,node_id,source_language,first_seen_at,last_seen_at) VALUES (${[r.route,r.method,r.node_id,r.source_language,r.first_seen_at,r.last_seen_at].map(sqlEscape).join(',')});`);
  }
  for(const c of rows.canonRows){
    out.push(`INSERT OR REPLACE INTO canon_picks (content_hash,canonical_node_id,duplicate_count,canon_score) VALUES (${[c.content_hash,c.canonical_node_id,c.duplicate_count,c.canon_score].map(sqlEscape).join(',')});`);
  }
  for(const e of epochs){
    out.push(`INSERT OR REPLACE INTO epoch_markers (epoch_name,started_at,ended_at,dominant_language,file_count) VALUES (${[e.epoch_name,e.started_at,e.ended_at,e.dominant_language,e.file_count].map(sqlEscape).join(',')});`);
  }
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}

function writeTimelineSqliteIfAvailable(rows, epochs, dbPath){
  let Database;
  try { Database = require('better-sqlite3'); } catch { return false; }
  try { fs.unlinkSync(dbPath); } catch {}
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(TIMELINE_DDL);
  const ins = {
    node: db.prepare(`INSERT INTO tmrfs_nodes (id,path,path_hash,content_hash,rgano_signature_hash,language,node_kind,size_bytes,function_count,route_count,canon_score,first_seen_at,last_seen_at,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    edge: db.prepare(`INSERT OR IGNORE INTO tmrfs_edges (from_node_id,to_node_id,edge_kind,hamming_distance) VALUES (?,?,?,?)`),
    sig: db.prepare(`INSERT OR REPLACE INTO rgano_signatures (signature_hash,signature_kind,representative_node_id,member_count) VALUES (?,?,?,?)`),
    route: db.prepare(`INSERT OR IGNORE INTO route_definitions (route,method,node_id,source_language,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)`),
    canon: db.prepare(`INSERT OR REPLACE INTO canon_picks (content_hash,canonical_node_id,duplicate_count,canon_score) VALUES (?,?,?,?)`),
    epoch: db.prepare(`INSERT OR REPLACE INTO epoch_markers (epoch_name,started_at,ended_at,dominant_language,file_count) VALUES (?,?,?,?,?)`)
  };
  const tx = db.transaction(() => {
    for(const r of rows.tmrfsRows) ins.node.run(r.id, r.path, r.path_hash, r.content_hash, r.rgano_signature_hash, r.language, r.node_kind, r.size_bytes, r.function_count, r.route_count, r.canon_score, r.first_seen_at, r.last_seen_at, r.payload);
    for(const e of rows.edgeRows) ins.edge.run(e.from_node_id, e.to_node_id, e.edge_kind, e.hamming_distance);
    for(const s of rows.sigRows) ins.sig.run(s.signature_hash, s.signature_kind, s.representative_node_id, s.member_count);
    for(const r of rows.routeRows) ins.route.run(r.route, r.method, r.node_id, r.source_language, r.first_seen_at, r.last_seen_at);
    for(const c of rows.canonRows) ins.canon.run(c.content_hash, c.canonical_node_id, c.duplicate_count, c.canon_score);
    for(const e of epochs) ins.epoch.run(e.epoch_name, e.started_at, e.ended_at, e.dominant_language, e.file_count);
  });
  tx();
  db.close();
  return true;
}

function writeTimelineMarkdown(rows, epochs){
  const lines = ['# PlaneKey Canonical-Heritage Timeline', '', `Generated: ${nowIso()}`,
    `Nodes: ${rows.tmrfsRows.length}  Edges: ${rows.edgeRows.length}  Routes: ${rows.routeRows.length}  Canon picks: ${rows.canonRows.length}  Epochs: ${epochs.length}`,
    ''];
  // Section 1 — language epochs
  lines.push('## 1. Language epochs', '');
  if(!epochs.length){
    lines.push('_No epochs detected — no recognised .js/.rs/.py/.json files with first-seen dates._', '');
  } else {
    lines.push('| Epoch | Language | First seen | Last seen | Files |');
    lines.push('|---|---|---|---|---|');
    for(const e of epochs) lines.push(`| ${e.epoch_name} | ${e.dominant_language} | ${e.started_at || '-'} | ${e.ended_at || '-'} | ${e.file_count} |`);
    lines.push('');
    const order = epochs.map(e=>e.epoch_name);
    if(order.length > 1){
      lines.push(`The codebase moved through ${order.length} language epochs in order: ${order.join(' → ')}. Each transition reflects the project's migration: ${order.includes('python_era') ? 'Python prototyping → ' : ''}Node/Express on Render → Rust/Actix.`, '');
    }
  }
  // Section 2 — route lineage
  lines.push('## 2. Route lineage', '');
  const routeCounts = {};
  for(const r of rows.routeRows){
    const k = `${r.method} ${r.route}`;
    routeCounts[k] = routeCounts[k] || {method:r.method, route:r.route, count:0, first:r.first_seen_at, langs:new Set(), node_ids:[]};
    routeCounts[k].count++;
    if(r.first_seen_at && (!routeCounts[k].first || r.first_seen_at < routeCounts[k].first)) routeCounts[k].first = r.first_seen_at;
    routeCounts[k].langs.add(r.source_language || '?');
    routeCounts[k].node_ids.push(r.node_id);
  }
  const topRoutes = Object.values(routeCounts).sort((a,b)=>b.count - a.count).slice(0, 50);
  if(!topRoutes.length){
    lines.push('_No HTTP routes found._', '');
  } else {
    lines.push('| Route | Count | First seen | Languages |');
    lines.push('|---|---|---|---|');
    for(const r of topRoutes){
      const langs = Array.from(r.langs).join(',');
      const xLang = r.langs.size > 1 ? ' 🔀' : '';
      lines.push(`| \`${r.method} ${r.route}\`${xLang} | ${r.count} | ${r.first || '-'} | ${langs} |`);
    }
    lines.push('', '_🔀 marks routes that crossed language boundaries._', '');
  }
  // Section 3 — canon picks (top duplicate clusters)
  lines.push('## 3. Canon picks (top duplicate clusters)', '');
  const topCanon = rows.canonRows.slice().sort((a,b)=>b.duplicate_count - a.duplicate_count).slice(0, 50);
  if(!topCanon.length){
    lines.push('_No canon picks produced._', '');
  } else {
    const nodeById = {};
    for(const n of rows.tmrfsRows) nodeById[n.id] = n;
    // Group duplicate paths per content_hash
    const dupsByContent = {};
    for(const n of rows.tmrfsRows){
      if(!n.content_hash) continue;
      (dupsByContent[n.content_hash] ||= []).push(n.path);
    }
    for(const c of topCanon){
      if(c.duplicate_count <= 1) continue;
      const canonical = nodeById[c.canonical_node_id];
      const all = dupsByContent[c.content_hash] || [];
      lines.push(`- **${c.duplicate_count}×** \`${canonical ? canonical.path : '?'}\` (canon_score ${c.canon_score})`);
      for(const p of all.slice(0, 8)) lines.push(`  - ${p}`);
      if(all.length > 8) lines.push(`  - …(+${all.length - 8} more)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function commandMemoryTimeline(input, flags){
  if(!input) throw new Error('Usage: pk-memory memory timeline <folder-or-zip> [--name label] [--out ./reports] [--include js,json,py,rs,sql] [--no-md]');
  const name = slug(flags.name || 'timeline-' + Date.now());
  const outRoot = path.resolve(flags.out || './reports');
  const outDir = path.join(outRoot, 'timeline', name);
  await mkdirp(outDir);

  console.log(`pk-memory: timeline build starting on ${path.resolve(input)} …`);
  const bundle = await buildMemory(input, flags);

  // Filter by include list if provided
  const include = (flags.include ? String(flags.include).split(',') : ['js','json','py','rs','sql']).map(s=>s.trim().toLowerCase());
  const filtered = bundle.memory.nodes.filter(n => include.includes(languageFor(n.ext)));

  // Resolve first_seen_at / last_seen_at per node
  for(const n of filtered){
    const abs = path.join(path.resolve(input), n.path);
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch {}
    let text = null;
    try { text = fs.readFileSync(abs, 'utf8').slice(0, 400); } catch {}
    n.first_seen_at = fileFirstSeenAt(abs, n.path, text, mtimeMs);
    n.last_seen_at = mtimeMs ? new Date(mtimeMs).toISOString() : n.first_seen_at;
    n.language = languageFor(n.ext);
  }
  // Replace bundle.memory.nodes with the filtered set so buildTimelineRows sees only those
  bundle.memory.nodes = filtered;

  const rows = buildTimelineRows(bundle);
  const epochs = detectEpochs(filtered);

  // SQL emit (always)
  const sqlText = writeTimelineSqlText(rows, epochs);
  await writeText(path.join(outDir, 'pk-timeline.sql'), sqlText);

  // SQLite emit (when better-sqlite3 is available)
  const dbPath = path.join(outDir, 'pk-timeline.sqlite');
  let dbOk = false;
  try { dbOk = writeTimelineSqliteIfAvailable(rows, epochs, dbPath); } catch(e) {
    console.error(`(sqlite emit failed: ${e.message} — .sql file is the authoritative output)`);
  }

  // Markdown emit (unless --no-md)
  if(!flags['no-md']){
    await writeText(path.join(outDir, 'pk-timeline.md'), writeTimelineMarkdown(rows, epochs));
  }

  console.log(`Timeline written: ${outDir}`);
  console.log(`  nodes=${rows.tmrfsRows.length} edges=${rows.edgeRows.length} routes=${rows.routeRows.length} canon_picks=${rows.canonRows.length} epochs=${epochs.length}`);
  console.log(`  sql=${path.join(outDir,'pk-timeline.sql')}`);
  if(dbOk) console.log(`  sqlite=${dbPath}`);
  else console.log(`  sqlite=(not emitted — install better-sqlite3 to enable, or pipe pk-timeline.sql into sqlite3)`);
  if(!flags['no-md']) console.log(`  md=${path.join(outDir,'pk-timeline.md')}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// memory rpg — Repository Planning Graph (symbol-level lineage)
// Sibling of `memory timeline` (file-level). Walks files, extracts symbols
// (Python def/class, JS function declarations, Rust fn/struct), infers
// modules from top-level path segments, infers capabilities from module
// names, and emits an SQLite + .sql + .md report whose schema matches
// bridge migration 016_rpg_layer.sql.
// ──────────────────────────────────────────────────────────────────────────────

// Strip a naive line-comment tail before brace-counting, so a `//` or `#`
// inside a comment (e.g. "// returns {") doesn't perturb depth tracking.
// Deliberately does not handle strings/regex containing brace chars — this
// stays a heuristic, not a lexer; it only needs to be right far more often
// than "always end_line === start_line" (the previous behavior).
function stripLineCommentTail(line, language){
  if(language === 'py') {
    const i = line.indexOf('#');
    return i === -1 ? line : line.slice(0, i);
  }
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
}

// Brace-depth scan from a declaration line (js/rs). Returns the 1-indexed
// end line once the first `{` closes back to depth 0. One-liners with no
// `{` at all (e.g. `const f = x => x + 1;`, a tuple struct ending in `;`)
// correctly fall back to end_line === start_line.
function computeBraceEndLine(lines, startIdx, language, maxScan){
  let depth = 0;
  let sawOpen = false;
  const limit = Math.min(lines.length, startIdx + (maxScan || 6000));
  for(let i = startIdx; i < limit; i++){
    const line = stripLineCommentTail(lines[i], language);
    for(const ch of line){
      if(ch === '{'){ depth++; sawOpen = true; }
      else if(ch === '}'){ depth--; }
    }
    if(sawOpen && depth <= 0) return i + 1;
  }
  return startIdx + 1;
}

// Indentation-based block end for Python: the block runs while subsequent
// non-blank lines stay indented deeper than the def/class line itself.
function computePyEndLine(lines, startIdx){
  const baseIndent = (lines[startIdx].match(/^(\s*)/) || ['',''])[1].length;
  let last = startIdx;
  for(let i = startIdx + 1; i < lines.length; i++){
    const line = lines[i];
    if(!line.trim()) continue;
    const indent = (line.match(/^(\s*)/) || ['',''])[1].length;
    if(indent <= baseIndent) break;
    last = i;
  }
  return last + 1;
}

function extractSymbolsFromText(rel, text, language){
  const out = [];
  if(!text) return out;
  const lines = text.split('\n');
  if(language === 'py'){
    // def / class at indentation 0 or 4 spaces (top-level + class methods)
    const rx = /^(\s*)(async\s+)?(def|class)\s+([A-Za-z_][\w]*)\s*[\(:]/;
    for(let i = 0; i < lines.length; i++){
      const m = lines[i].match(rx);
      if(m){
        out.push({
          symbol_type: m[3] === 'class' ? 'class' : 'function',
          symbol_name: m[4],
          start_line: i + 1,
          end_line: computePyEndLine(lines, i),
          signature: lines[i].trim()
        });
      }
    }
  } else if(language === 'js'){
    const fnDecl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
    const classDecl = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\s*[{<]/;
    const constArrow = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/;
    for(let i = 0; i < lines.length; i++){
      let m;
      if((m = lines[i].match(fnDecl))) out.push({symbol_type:'function', symbol_name:m[1], start_line:i+1, end_line:computeBraceEndLine(lines, i, 'js'), signature:lines[i].trim()});
      else if((m = lines[i].match(classDecl))) out.push({symbol_type:'class', symbol_name:m[1], start_line:i+1, end_line:computeBraceEndLine(lines, i, 'js'), signature:lines[i].trim()});
      else if((m = lines[i].match(constArrow))) out.push({symbol_type:'function', symbol_name:m[1], start_line:i+1, end_line:computeBraceEndLine(lines, i, 'js'), signature:lines[i].trim()});
    }
  } else if(language === 'rs'){
    const fnDecl = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/;
    const structDecl = /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)\s*[{<;]/;
    const routeAttr = /^\s*#\[\s*(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\s*\]/;
    let pendingRoute = null;
    for(let i = 0; i < lines.length; i++){
      const rm = lines[i].match(routeAttr);
      if(rm){ pendingRoute = `${rm[1].toUpperCase()} ${rm[2]}`; continue; }
      let m;
      if((m = lines[i].match(fnDecl))){
        const sym = {symbol_type:'function', symbol_name:m[1], start_line:i+1, end_line:computeBraceEndLine(lines, i, 'rs'), signature:lines[i].trim()};
        if(pendingRoute){ sym.symbol_type = 'route_handler'; sym.route = pendingRoute; pendingRoute = null; }
        out.push(sym);
      } else if((m = lines[i].match(structDecl))){
        out.push({symbol_type:lines[i].match(/\btrait\b/)?'trait':'struct', symbol_name:m[1], start_line:i+1, end_line:computeBraceEndLine(lines, i, 'rs'), signature:lines[i].trim()});
        pendingRoute = null;
      } else if(lines[i].trim() && !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('#[')){
        pendingRoute = null;
      }
    }
  }
  return out;
}

// ── Real call-edge extraction ────────────────────────────────────────────
// Replaces the v1 "co_located" placeholder (ported as-is from
// PKtools/rpg_extension_tools/build_dependency_graph.py, itself labeled
// "Minimal placeholder" — chaining adjacent symbols in a file was never a
// call graph, it was scaffolding that nobody came back to finish). Now that
// extractSymbolsFromText computes a real end_line, each symbol has an actual
// body range to scan: find identifier-call patterns in that body, resolve
// them against known symbol names (same-module first, then a global index
// for cross-module edges), and emit dependency_type='calls' /
// 'calls_cross_module' / 'calls_ambiguous' — never a fabricated edge.
const JS_CALL_KEYWORDS = new Set(['if','for','while','switch','catch','function','return','new','typeof','instanceof','do','else','try','finally','throw','class','const','let','var','async','await','yield','super','this','import','export','default','void','delete','in','of','case','with']);
const RS_CALL_KEYWORDS = new Set(['if','for','while','match','loop','fn','let','return','impl','struct','enum','trait','use','mod','pub','async','await','move','unsafe','where','as','dyn','Self','self','super','crate','ref','mut','type','const','static','extern','break','continue','else']);
const PY_CALL_KEYWORDS = new Set(['if','for','while','def','class','return','elif','else','try','except','finally','with','lambda','yield','async','await','import','from','as','pass','raise','assert','global','nonlocal','del','not','and','or','in','is','print']);

function keywordSetFor(language){
  if(language === 'js') return JS_CALL_KEYWORDS;
  if(language === 'rs') return RS_CALL_KEYWORDS;
  if(language === 'py') return PY_CALL_KEYWORDS;
  return new Set();
}

const CALL_RX = /\b([A-Za-z_$][\w$]*)\s*\(/g;

function extractCallsFromBody(bodyText, keywords){
  const out = new Set();
  let m;
  CALL_RX.lastIndex = 0;
  while((m = CALL_RX.exec(bodyText))){
    if(!keywords.has(m[1])) out.add(m[1]);
  }
  return out;
}

function moduleFromPath(rel){
  // Strip leading common prefixes (products/, src/) and take first segment.
  const norm = normPath(rel);
  const parts = norm.split('/').filter(p => p && p !== 'src' && p !== 'products');
  if(!parts.length) return 'root';
  // bridge/crates/<cratename>/... is a workspace of ~8 independent Rust
  // crates (cosmicid, harmonic, uknocked, uknocked-auth, uknocked-bean,
  // uknocked-mmx, uknocked-platform, uknocked-rootrabbit). The generic rule
  // below keys on parts[1] ("crates" — the literal directory, not a crate
  // name), which collapsed all eight into one "bridge/crates" module.
  // Same-module call resolution then blindly linked any two same-named
  // functions across totally unrelated crates (e.g. a `Sha256::new()` call
  // in one crate false-resolving to `Tripwire::new()` in another) — every
  // crate needs its own module bucket, same as bridge/src/*.rs files
  // already get one per file below.
  if(parts.length >= 3 && parts[0] === 'bridge' && parts[1] === 'crates'){
    return `bridge/crates/${parts[2]}`;
  }
  // For deeply-nested files, use the first two segments to disambiguate
  // bridge/src/foo.rs vs server-core/tools/foo.js etc.
  if(parts.length >= 2 && (parts[0] === 'bridge' || parts[0] === 'server-core' || parts[0] === 'pk-client' || parts[0] === 'enterprise-bridge' || parts[0] === 'vscode-extension' || parts[0] === 'mobile-app')){
    return `${parts[0]}/${parts[1]}`.replace(/\..+$/,'');
  }
  return parts[0].replace(/\..+$/, '');
}

function capabilityFromModule(modName){
  // Heuristic: split on / and _ and -, pick most-likely capability word
  const tokens = modName.split(/[\/_\-]+/).filter(Boolean);
  const known = {
    accounts:'Auth', auth:'Auth', login:'Auth', session:'Auth',
    billing:'Billing', payments:'Billing', payouts:'Billing', zoho:'Billing',
    bridge:'Bridge', mirror:'Bridge', rootrabbit:'RootRabbit',
    memory:'Memory', tmrfs:'Memory', rgano:'Memory', rpg:'RPG',
    install:'Installs', paired:'Installs', client:'Client',
    repo:'Repo', package:'Packaging', bundle:'Packaging',
    trust:'Trust', operator:'Operator', usage:'Usage', flight:'Flight',
    safetynet:'Safety', repoguard:'Safety', pixelguard:'Safety',
    mcp:'MCP', env:'Env', observer:'Env',
    nap:'Routing', edge:'Edge', cloudflare:'Edge',
    admin:'Admin', tools:'Tooling', schema:'Schema',
    api:'API', screen:'UI', services:'UI', ios:'Mobile', android:'Mobile'
  };
  for(const t of tokens) if(known[t.toLowerCase()]) return known[t.toLowerCase()];
  // Fall back to title-cased first token
  return tokens[0] ? (tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1).toLowerCase()) : 'Misc';
}

const RPG_DDL = `
CREATE TABLE IF NOT EXISTS rpg_modules (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  service_id TEXT
);
CREATE TABLE IF NOT EXISTS rpg_symbols (
  id INTEGER PRIMARY KEY,
  module_id INTEGER,
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_type TEXT,
  signature TEXT,
  language TEXT,
  start_line INTEGER,
  end_line INTEGER,
  body_hash TEXT,
  route TEXT
);
CREATE INDEX IF NOT EXISTS idx_rpg_symbols_module ON rpg_symbols(module_id);
CREATE INDEX IF NOT EXISTS idx_rpg_symbols_name ON rpg_symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_rpg_symbols_file ON rpg_symbols(file_path);
CREATE TABLE IF NOT EXISTS rpg_symbol_dependencies (
  caller_id INTEGER NOT NULL,
  callee_id INTEGER NOT NULL,
  dependency_type TEXT NOT NULL,
  PRIMARY KEY (caller_id, callee_id, dependency_type)
);
CREATE TABLE IF NOT EXISTS rpg_capabilities (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS rpg_capability_modules (
  capability_id INTEGER NOT NULL,
  module_id INTEGER NOT NULL,
  weight REAL,
  PRIMARY KEY (capability_id, module_id)
);
`.trim();

function buildRpgRows(bundle){
  // Build modules, symbols, dependencies, capabilities from the memory bundle's nodes.
  const modulesByName = {};
  let modIdCounter = 0;
  function moduleId(name){
    if(!modulesByName[name]) modulesByName[name] = {id: ++modIdCounter, name};
    return modulesByName[name].id;
  }
  const symbolsRows = [];
  let symIdCounter = 0;
  const fileLinesByPath = {};
  const fileLangByPath = {};
  for(const n of bundle.memory.nodes){
    const lang = languageFor(n.ext);
    if(!lang || !['js','py','rs'].includes(lang)) continue;
    const modName = moduleFromPath(n.path);
    const mid = moduleId(modName);
    let text = null;
    try {
      const abs = path.join(bundle.memory.input, n.path);
      text = fs.readFileSync(abs, 'utf8');
    } catch {}
    if(!text) continue;
    const lines = text.split('\n');
    fileLinesByPath[n.path] = lines;
    fileLangByPath[n.path] = lang;
    const symbols = extractSymbolsFromText(n.path, text, lang);
    for(const s of symbols){
      symIdCounter++;
      symbolsRows.push({
        id: symIdCounter,
        module_id: mid,
        file_path: n.path,
        symbol_name: s.symbol_name,
        symbol_type: s.symbol_type,
        signature: (s.signature || '').slice(0, 500),
        language: lang,
        start_line: s.start_line,
        end_line: s.end_line,
        body_hash: null, // filled in by full Python AST pass; placeholder for now
        route: s.route || null
      });
    }
  }
  // dependencies — real call-edge extraction. Each symbol now has an actual
  // end_line (see extractSymbolsFromText), so its body text can be scanned
  // for identifier-call patterns and resolved against known symbol names:
  // same-module first, then a global name index for cross-module edges.
  // Ambiguous common names (>3 same-named candidates elsewhere, e.g. "get"/
  // "run") are dropped rather than guessed — a missing edge is honest,
  // a wrong one poisons every reachability query downstream.
  const depRows = [];
  const seenEdges = new Set();
  function addEdge(callerId, calleeId, dependencyType){
    if(callerId === calleeId) return;
    const key = `${callerId}>${calleeId}>${dependencyType}`;
    if(seenEdges.has(key)) return;
    seenEdges.add(key);
    depRows.push({caller_id: callerId, callee_id: calleeId, dependency_type: dependencyType});
  }
  const byModuleName = new Map(); // `${module_id}::${name}` -> [symbolId,...]
  const byNameGlobal = new Map(); // name -> [{id, module_id}]
  for(const s of symbolsRows){
    const mkey = `${s.module_id}::${s.symbol_name}`;
    if(!byModuleName.has(mkey)) byModuleName.set(mkey, []);
    byModuleName.get(mkey).push(s.id);
    if(!byNameGlobal.has(s.symbol_name)) byNameGlobal.set(s.symbol_name, []);
    byNameGlobal.get(s.symbol_name).push({id: s.id, module_id: s.module_id});
  }
  for(const s of symbolsRows){
    const lines = fileLinesByPath[s.file_path];
    if(!lines) continue;
    const lang = fileLangByPath[s.file_path];
    const startIdx = Math.max(0, s.start_line - 1);
    const endIdx = Math.min(lines.length, s.end_line);
    const bodyText = lines.slice(startIdx, endIdx).join('\n');
    const calls = extractCallsFromBody(bodyText, keywordSetFor(lang));
    for(const name of calls){
      if(name === s.symbol_name) continue; // skip decl-line self-mentions (type name in its own ctor, etc.)
      const sameModule = byModuleName.get(`${s.module_id}::${name}`);
      if(sameModule && sameModule.length){
        // Same ambiguity cap as the cross-module branch below — a generic
        // name (new/get/decode) with several same-module hits is exactly
        // as unreliable as one with several cross-module hits. Blindly
        // linking every same-module match is what let `sha256_hex()`
        // false-resolve to an unrelated `Tripwire::new()` before
        // moduleFromPath gave each crate its own module bucket.
        if(sameModule.length <= 3){
          for(const calleeId of sameModule) addEdge(s.id, calleeId, 'calls');
        }
        continue;
      }
      const cross = (byNameGlobal.get(name) || []).filter(c => c.module_id !== s.module_id);
      if(!cross.length || cross.length > 3) continue; // 0 = unknown call (external lib); >3 = too ambiguous to trust
      const depType = cross.length === 1 ? 'calls_cross_module' : 'calls_ambiguous';
      for(const c of cross) addEdge(s.id, c.id, depType);
    }
  }
  // capabilities — infer per module
  const capabilitiesByName = {};
  let capIdCounter = 0;
  const capabilityModuleRows = [];
  for(const mod of Object.values(modulesByName)){
    const capName = capabilityFromModule(mod.name);
    if(!capabilitiesByName[capName]) capabilitiesByName[capName] = {id: ++capIdCounter, name: capName, status: 'inferred', description: null};
    capabilityModuleRows.push({capability_id: capabilitiesByName[capName].id, module_id: mod.id, weight: 1.0});
  }
  return {
    modulesRows: Object.values(modulesByName).map(m => ({id:m.id, name:m.name, description:null, service_id:'planekey'})),
    symbolsRows,
    depRows,
    capabilityRows: Object.values(capabilitiesByName),
    capabilityModuleRows
  };
}

function writeRpgSqlText(rows){
  const out = [RPG_DDL, '', 'BEGIN;'];
  for(const m of rows.modulesRows) out.push(`INSERT INTO rpg_modules (id,name,description,service_id) VALUES (${[m.id,m.name,m.description,m.service_id].map(sqlEscape).join(',')});`);
  for(const s of rows.symbolsRows) out.push(`INSERT INTO rpg_symbols (id,module_id,file_path,symbol_name,symbol_type,signature,language,start_line,end_line,body_hash,route) VALUES (${[s.id,s.module_id,s.file_path,s.symbol_name,s.symbol_type,s.signature,s.language,s.start_line,s.end_line,s.body_hash,s.route].map(sqlEscape).join(',')});`);
  for(const d of rows.depRows) out.push(`INSERT OR IGNORE INTO rpg_symbol_dependencies (caller_id,callee_id,dependency_type) VALUES (${[d.caller_id,d.callee_id,d.dependency_type].map(sqlEscape).join(',')});`);
  for(const c of rows.capabilityRows) out.push(`INSERT INTO rpg_capabilities (id,name,description,status) VALUES (${[c.id,c.name,c.description,c.status].map(sqlEscape).join(',')});`);
  for(const cm of rows.capabilityModuleRows) out.push(`INSERT OR IGNORE INTO rpg_capability_modules (capability_id,module_id,weight) VALUES (${[cm.capability_id,cm.module_id,cm.weight].map(sqlEscape).join(',')});`);
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}

function writeRpgSqliteIfAvailable(rows, dbPath){
  let Database;
  try { Database = require('better-sqlite3'); } catch { return false; }
  try { fs.unlinkSync(dbPath); } catch {}
  const db = new Database(dbPath);
  db.exec(RPG_DDL);
  const ins = {
    mod: db.prepare('INSERT INTO rpg_modules (id,name,description,service_id) VALUES (?,?,?,?)'),
    sym: db.prepare('INSERT INTO rpg_symbols (id,module_id,file_path,symbol_name,symbol_type,signature,language,start_line,end_line,body_hash,route) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    dep: db.prepare('INSERT OR IGNORE INTO rpg_symbol_dependencies (caller_id,callee_id,dependency_type) VALUES (?,?,?)'),
    cap: db.prepare('INSERT INTO rpg_capabilities (id,name,description,status) VALUES (?,?,?,?)'),
    capmod: db.prepare('INSERT OR IGNORE INTO rpg_capability_modules (capability_id,module_id,weight) VALUES (?,?,?)')
  };
  const tx = db.transaction(() => {
    for(const m of rows.modulesRows) ins.mod.run(m.id, m.name, m.description, m.service_id);
    for(const s of rows.symbolsRows) ins.sym.run(s.id, s.module_id, s.file_path, s.symbol_name, s.symbol_type, s.signature, s.language, s.start_line, s.end_line, s.body_hash, s.route);
    for(const d of rows.depRows) ins.dep.run(d.caller_id, d.callee_id, d.dependency_type);
    for(const c of rows.capabilityRows) ins.cap.run(c.id, c.name, c.description, c.status);
    for(const cm of rows.capabilityModuleRows) ins.capmod.run(cm.capability_id, cm.module_id, cm.weight);
  });
  tx();
  db.close();
  return true;
}

function writeRpgMarkdown(rows){
  const lines = ['# PlaneKey Repository Planning Graph (RPG)', '', `Generated: ${nowIso()}`,
    `Modules: ${rows.modulesRows.length}  Symbols: ${rows.symbolsRows.length}  Dependencies: ${rows.depRows.length}  Capabilities: ${rows.capabilityRows.length}`, ''];

  // Capabilities → module map
  lines.push('## Capabilities', '');
  const modById = {}; for(const m of rows.modulesRows) modById[m.id] = m;
  const capMods = {};
  for(const cm of rows.capabilityModuleRows){
    (capMods[cm.capability_id] ||= []).push(modById[cm.module_id].name);
  }
  for(const c of rows.capabilityRows){
    const mods = (capMods[c.id] || []).slice(0, 8);
    lines.push(`### ${c.name}  _${c.status}_`);
    lines.push(`Modules: ${mods.join(', ')}${(capMods[c.id]||[]).length > 8 ? ` (+${capMods[c.id].length - 8} more)` : ''}`);
    lines.push('');
  }

  // Top modules by symbol count
  lines.push('## Top modules by symbol count', '');
  const symsByMod = {};
  for(const s of rows.symbolsRows) symsByMod[s.module_id] = (symsByMod[s.module_id] || 0) + 1;
  const sortedMods = Object.entries(symsByMod).sort((a,b)=>b[1]-a[1]).slice(0, 20);
  lines.push('| Module | Symbols |');
  lines.push('|---|---|');
  for(const [mid, count] of sortedMods) lines.push(`| ${modById[mid].name} | ${count} |`);
  lines.push('');

  // Route handlers (Rust)
  const routeSymbols = rows.symbolsRows.filter(s => s.symbol_type === 'route_handler' && s.route);
  if(routeSymbols.length){
    lines.push('## Route handlers (Rust)', '');
    lines.push('| Route | Handler | Module |');
    lines.push('|---|---|---|');
    for(const s of routeSymbols.slice(0, 50)){
      lines.push(`| \`${s.route}\` | ${s.symbol_name} | ${modById[s.module_id].name} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function commandMemoryRpg(input, flags){
  if(!input) throw new Error('Usage: pk-memory memory rpg <folder-or-zip> [--name label] [--out ./reports]');
  const name = slug(flags.name || 'rpg-' + Date.now());
  const outRoot = path.resolve(flags.out || './reports');
  const outDir = path.join(outRoot, 'rpg', name);
  await mkdirp(outDir);

  console.log(`pk-memory: rpg build starting on ${path.resolve(input)} …`);
  const bundle = await buildMemory(input, flags);
  bundle.memory.input = path.resolve(input);

  const rows = buildRpgRows(bundle);

  // SQL emit (always)
  const sqlText = writeRpgSqlText(rows);
  await writeText(path.join(outDir, 'rpg.sql'), sqlText);

  // SQLite emit (when better-sqlite3 is available)
  const dbPath = path.join(outDir, 'rpg.sqlite');
  let dbOk = false;
  try { dbOk = writeRpgSqliteIfAvailable(rows, dbPath); } catch(e) {
    console.error(`(sqlite emit failed: ${e.message} — .sql file is the authoritative output)`);
  }

  if(!flags['no-md']){
    await writeText(path.join(outDir, 'rpg.md'), writeRpgMarkdown(rows));
  }

  console.log(`RPG written: ${outDir}`);
  console.log(`  modules=${rows.modulesRows.length} symbols=${rows.symbolsRows.length} dependencies=${rows.depRows.length} capabilities=${rows.capabilityRows.length}`);
  console.log(`  sql=${path.join(outDir,'rpg.sql')}`);
  if(dbOk) console.log(`  sqlite=${dbPath}`);
  else console.log(`  sqlite=(not emitted — install better-sqlite3 to enable, or pipe rpg.sql into sqlite3)`);
  if(!flags['no-md']) console.log(`  md=${path.join(outDir,'rpg.md')}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// memory matrix — hash-tensor overlap across snapshot layers (rgano style)
// Walks a folder of zips (or any folder containing layered subdirs), groups
// the resulting memory bundle by source_archive, and computes an N×N×4
// Jaccard tensor: content-hash, rgano-signature, path, and route overlap
// for every layer pair. The high-overlap diagonal is the project's
// "cloverleaf overpass" — assets carried forward through versions.
// ──────────────────────────────────────────────────────────────────────────────

function jaccard(setA, setB){
  if(!setA.size && !setB.size) return 0;
  let inter = 0;
  const small = setA.size < setB.size ? setA : setB;
  const big = setA.size < setB.size ? setB : setA;
  for(const v of small) if(big.has(v)) inter++;
  const uni = setA.size + setB.size - inter;
  return uni ? inter / uni : 0;
}

function buildMatrixLayers(bundle){
  // Group bundle nodes by source_archive → per-layer fingerprint sets
  const layers = {};
  for(const n of bundle.memory.nodes){
    const label = n.source_archive || 'unknown';
    if(!layers[label]){
      layers[label] = {
        label,
        nodes: [],
        content_hashes: new Set(),
        rgano_signatures: new Set(),
        paths: new Set(),
        routes: new Set()
      };
    }
    const L = layers[label];
    L.nodes.push(n);
    // node.sha256 is unset when opts.private; recover from contentIndex
    if(n.hash_short) L.content_hashes.add(n.hash_short);
    if(n.rgano_signature) L.rgano_signatures.add(n.rgano_signature);
    if(n.path) L.paths.add(n.path);
    if(n.structure && n.structure.routes){
      for(const r of n.structure.routes) L.routes.add(r);
    }
  }
  // Assign integer IDs, sort layers by label
  const sorted = Object.values(layers).sort((a,b)=>a.label.localeCompare(b.label));
  sorted.forEach((L, i) => L.id = i + 1);
  return sorted;
}

function computeOverlaps(layers){
  const overlaps = [];
  for(let i = 0; i < layers.length; i++){
    for(let j = i + 1; j < layers.length; j++){
      const A = layers[i], B = layers[j];
      const jc = jaccard(A.content_hashes, B.content_hashes);
      const jr = jaccard(A.rgano_signatures, B.rgano_signatures);
      const jp = jaccard(A.paths, B.paths);
      const jrt = jaccard(A.routes, B.routes);
      // Skip pairs with zero overlap to keep the tensor sparse
      if(jc + jr + jp + jrt === 0) continue;
      // Count shared elements (without re-iterating: use intersection size from jaccard)
      const sharedContent = countIntersection(A.content_hashes, B.content_hashes);
      const sharedRgano = countIntersection(A.rgano_signatures, B.rgano_signatures);
      const sharedPaths = countIntersection(A.paths, B.paths);
      const sharedRoutes = countIntersection(A.routes, B.routes);
      overlaps.push({
        layer_a_id: A.id, layer_b_id: B.id,
        layer_a_label: A.label, layer_b_label: B.label,
        jaccard_content: jc, jaccard_rgano: jr, jaccard_paths: jp, jaccard_routes: jrt,
        shared_content_hashes: sharedContent,
        shared_rgano_signatures: sharedRgano,
        shared_paths: sharedPaths,
        shared_routes: sharedRoutes
      });
    }
  }
  return overlaps;
}

function countIntersection(a, b){
  let n = 0;
  const small = a.size < b.size ? a : b;
  const big = a.size < b.size ? b : a;
  for(const v of small) if(big.has(v)) n++;
  return n;
}

function buildSharedAssets(layers, bundle){
  // For each content_hash that appears in >1 layer, emit a row per (hash, layer)
  // along with the path it took in that layer. This is the "cloverleaf overpass"
  // raw data: the assets that carried through.
  const hashToLayers = {};
  for(const L of layers){
    for(const n of L.nodes){
      if(!n.hash_short) continue;
      (hashToLayers[n.hash_short] ||= []).push({layer_id: L.id, layer_label: L.label, path: n.path, rgano_signature: n.rgano_signature});
    }
  }
  const rows = [];
  for(const [h, ls] of Object.entries(hashToLayers)){
    if(ls.length > 1){
      for(const l of ls){
        rows.push({content_hash: h, layer_id: l.layer_id, file_path: l.path, rgano_signature_hash: l.rgano_signature});
      }
    }
  }
  return rows;
}

const MATRIX_DDL = `
CREATE TABLE IF NOT EXISTS matrix_layers (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  file_count INTEGER,
  content_hash_count INTEGER,
  rgano_signature_count INTEGER,
  path_count INTEGER,
  route_count INTEGER
);
CREATE TABLE IF NOT EXISTS matrix_overlaps (
  layer_a_id INTEGER NOT NULL,
  layer_b_id INTEGER NOT NULL,
  jaccard_content REAL,
  jaccard_rgano REAL,
  jaccard_paths REAL,
  jaccard_routes REAL,
  shared_content_hashes INTEGER,
  shared_rgano_signatures INTEGER,
  shared_paths INTEGER,
  shared_routes INTEGER,
  PRIMARY KEY (layer_a_id, layer_b_id)
);
CREATE INDEX IF NOT EXISTS idx_overlaps_rgano ON matrix_overlaps(jaccard_rgano);
CREATE INDEX IF NOT EXISTS idx_overlaps_content ON matrix_overlaps(jaccard_content);
CREATE TABLE IF NOT EXISTS matrix_shared_assets (
  content_hash TEXT NOT NULL,
  layer_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  rgano_signature_hash TEXT,
  PRIMARY KEY (content_hash, layer_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_shared_assets_hash ON matrix_shared_assets(content_hash);
CREATE INDEX IF NOT EXISTS idx_shared_assets_layer ON matrix_shared_assets(layer_id);
`.trim();

function writeMatrixSqlText(layers, overlaps, sharedAssets){
  const out = [MATRIX_DDL, '', 'BEGIN;'];
  for(const L of layers){
    out.push(`INSERT INTO matrix_layers (id,label,file_count,content_hash_count,rgano_signature_count,path_count,route_count) VALUES (${[L.id, L.label, L.nodes.length, L.content_hashes.size, L.rgano_signatures.size, L.paths.size, L.routes.size].map(sqlEscape).join(',')});`);
  }
  for(const o of overlaps){
    out.push(`INSERT INTO matrix_overlaps (layer_a_id,layer_b_id,jaccard_content,jaccard_rgano,jaccard_paths,jaccard_routes,shared_content_hashes,shared_rgano_signatures,shared_paths,shared_routes) VALUES (${[o.layer_a_id,o.layer_b_id,o.jaccard_content.toFixed(6),o.jaccard_rgano.toFixed(6),o.jaccard_paths.toFixed(6),o.jaccard_routes.toFixed(6),o.shared_content_hashes,o.shared_rgano_signatures,o.shared_paths,o.shared_routes].map(sqlEscape).join(',')});`);
  }
  for(const s of sharedAssets){
    out.push(`INSERT OR IGNORE INTO matrix_shared_assets (content_hash,layer_id,file_path,rgano_signature_hash) VALUES (${[s.content_hash,s.layer_id,s.file_path,s.rgano_signature_hash].map(sqlEscape).join(',')});`);
  }
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}

function writeMatrixSqliteIfAvailable(layers, overlaps, sharedAssets, dbPath){
  let Database;
  try { Database = require('better-sqlite3'); } catch { return false; }
  try { fs.unlinkSync(dbPath); } catch {}
  const db = new Database(dbPath);
  db.exec(MATRIX_DDL);
  const ins = {
    layer: db.prepare('INSERT INTO matrix_layers (id,label,file_count,content_hash_count,rgano_signature_count,path_count,route_count) VALUES (?,?,?,?,?,?,?)'),
    overlap: db.prepare('INSERT INTO matrix_overlaps (layer_a_id,layer_b_id,jaccard_content,jaccard_rgano,jaccard_paths,jaccard_routes,shared_content_hashes,shared_rgano_signatures,shared_paths,shared_routes) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    shared: db.prepare('INSERT OR IGNORE INTO matrix_shared_assets (content_hash,layer_id,file_path,rgano_signature_hash) VALUES (?,?,?,?)')
  };
  const tx = db.transaction(() => {
    for(const L of layers) ins.layer.run(L.id, L.label, L.nodes.length, L.content_hashes.size, L.rgano_signatures.size, L.paths.size, L.routes.size);
    for(const o of overlaps) ins.overlap.run(o.layer_a_id, o.layer_b_id, o.jaccard_content, o.jaccard_rgano, o.jaccard_paths, o.jaccard_routes, o.shared_content_hashes, o.shared_rgano_signatures, o.shared_paths, o.shared_routes);
    for(const s of sharedAssets) ins.shared.run(s.content_hash, s.layer_id, s.file_path, s.rgano_signature_hash);
  });
  tx();
  db.close();
  return true;
}

function writeMatrixMarkdown(layers, overlaps, sharedAssets){
  const lines = ['# PlaneKey Hash-Tensor Overlap Matrix', '', `Generated: ${nowIso()}`,
    `Layers: ${layers.length}  Overlapping pairs: ${overlaps.length}  Cross-layer assets: ${new Set(sharedAssets.map(s=>s.content_hash)).size}`,
    '',
    'Each layer is a zip (or folder source). Four overlap dimensions per pair:',
    '`content` (exact sha256), `rgano` (structural signature — rgano style),',
    '`paths` (filename overlap), `routes` (HTTP route overlap).',
    ''];

  // Section 1 — layer inventory
  lines.push('## 1. Layer inventory', '');
  lines.push('| # | Layer | Files | Hashes | Rgano sigs | Paths | Routes |');
  lines.push('|---|---|---|---|---|---|---|');
  for(const L of layers.slice(0, 80)){
    const short = L.label.length > 60 ? L.label.slice(0,57)+'...' : L.label;
    lines.push(`| ${L.id} | ${short} | ${L.nodes.length} | ${L.content_hashes.size} | ${L.rgano_signatures.size} | ${L.paths.size} | ${L.routes.size} |`);
  }
  if(layers.length > 80) lines.push(`\n_(+${layers.length - 80} more layers)_`);
  lines.push('');

  // Section 2 — top overlapping pairs by rgano (structural)
  lines.push('## 2. Top overlapping pairs (rgano-structural)', '');
  const topRgano = overlaps.slice().sort((a,b)=>b.jaccard_rgano - a.jaccard_rgano).slice(0, 30);
  lines.push('| A | B | rgano | content | paths | routes | shared hashes |');
  lines.push('|---|---|---|---|---|---|---|');
  const shortLabel = s => s.length > 38 ? s.slice(0, 35) + '...' : s;
  for(const o of topRgano){
    lines.push(`| ${shortLabel(o.layer_a_label)} | ${shortLabel(o.layer_b_label)} | ${o.jaccard_rgano.toFixed(3)} | ${o.jaccard_content.toFixed(3)} | ${o.jaccard_paths.toFixed(3)} | ${o.jaccard_routes.toFixed(3)} | ${o.shared_content_hashes} |`);
  }
  lines.push('');

  // Section 3 — cross-layer hot assets (cloverleaf overpass points)
  lines.push('## 3. Cloverleaf overpass — assets crossing the most layers', '');
  const layerCountByHash = {};
  const pathByHash = {};
  for(const s of sharedAssets){
    layerCountByHash[s.content_hash] = (layerCountByHash[s.content_hash] || new Set());
    layerCountByHash[s.content_hash].add(s.layer_id);
    if(!pathByHash[s.content_hash]) pathByHash[s.content_hash] = s.file_path;
  }
  const sortedHotAssets = Object.entries(layerCountByHash)
    .map(([h, ls]) => ({hash:h, layers:ls.size, sample_path: pathByHash[h]}))
    .sort((a,b)=>b.layers - a.layers).slice(0, 40);
  lines.push('| Layers carrying | Asset (sample path) | content hash |');
  lines.push('|---|---|---|');
  for(const a of sortedHotAssets){
    const p = a.sample_path.length > 80 ? '…' + a.sample_path.slice(-77) : a.sample_path;
    lines.push(`| ${a.layers} | ${p} | \`${a.hash}\` |`);
  }
  lines.push('');

  // Section 4 — uniqueness diagonal (layers with assets nobody else has)
  lines.push('## 4. Uniqueness — layers with most layer-unique assets', '');
  const layerUniqueCount = {};
  for(const L of layers) layerUniqueCount[L.id] = 0;
  for(const [h, ls] of Object.entries(layerCountByHash)){
    if(ls.size === 1){
      const onlyLayer = ls.values().next().value;
      layerUniqueCount[onlyLayer] = (layerUniqueCount[onlyLayer] || 0) + 1;
    }
  }
  // But layerCountByHash only contains MULTI-layer hashes. So layer-unique means a hash that ONLY appears in 1 layer wasn't in sharedAssets at all.
  // Recompute by looking at each layer's content_hashes minus the multi-layer ones.
  const multiLayerHashes = new Set();
  for(const [h, ls] of Object.entries(layerCountByHash)) if(ls.size > 1) multiLayerHashes.add(h);
  const uniqueByLayer = {};
  for(const L of layers){
    let count = 0;
    for(const h of L.content_hashes) if(!multiLayerHashes.has(h)) count++;
    uniqueByLayer[L.id] = count;
  }
  const sortedUnique = Object.entries(uniqueByLayer).sort((a,b)=>b[1]-a[1]).slice(0, 15);
  lines.push('| Layer | Layer-unique files |');
  lines.push('|---|---|');
  const layerById = {}; for(const L of layers) layerById[L.id] = L;
  for(const [lid, n] of sortedUnique){
    const lbl = layerById[lid].label;
    lines.push(`| ${lbl.length > 70 ? lbl.slice(0,67)+'...' : lbl} | ${n} |`);
  }
  lines.push('');

  return lines.join('\n');
}

async function commandMemoryMatrix(input, flags){
  if(!input) throw new Error('Usage: pk-memory memory matrix <folder-with-zips-or-layered-dirs> [--name label] [--out ./reports]');
  const name = slug(flags.name || 'matrix-' + Date.now());
  const outRoot = path.resolve(flags.out || './reports');
  const outDir = path.join(outRoot, 'matrix', name);
  await mkdirp(outDir);

  console.log(`pk-memory: matrix build starting on ${path.resolve(input)} …`);
  const bundle = await buildMemory(input, flags);

  const layers = buildMatrixLayers(bundle);
  const overlaps = computeOverlaps(layers);
  const sharedAssets = buildSharedAssets(layers, bundle);

  const sqlText = writeMatrixSqlText(layers, overlaps, sharedAssets);
  await writeText(path.join(outDir, 'matrix.sql'), sqlText);

  const dbPath = path.join(outDir, 'matrix.sqlite');
  let dbOk = false;
  try { dbOk = writeMatrixSqliteIfAvailable(layers, overlaps, sharedAssets, dbPath); } catch(e) {
    console.error(`(sqlite emit failed: ${e.message})`);
  }

  if(!flags['no-md']){
    await writeText(path.join(outDir, 'matrix.md'), writeMatrixMarkdown(layers, overlaps, sharedAssets));
  }

  console.log(`Matrix written: ${outDir}`);
  console.log(`  layers=${layers.length} overlapping_pairs=${overlaps.length} cross_layer_assets=${new Set(sharedAssets.map(s=>s.content_hash)).size}`);
  console.log(`  sql=${path.join(outDir,'matrix.sql')}`);
  if(dbOk) console.log(`  sqlite=${dbPath}`);
  else console.log(`  sqlite=(install better-sqlite3 or pipe matrix.sql into sqlite3)`);
  if(!flags['no-md']) console.log(`  md=${path.join(outDir,'matrix.md')}`);
}

function help(){
  console.log(`PlaneKey:TMrFS + RootRabbit:Rgano v${VERSION}\n\nUsage:\n  pk-memory memory build <folder-or-zip> [--name cc-memory] [--out ./reports]\n  pk-memory memory query <report-dir> --path server.js [--limit 50]\n  pk-memory memory lineage <report-dir> --path server.js\n  pk-memory memory canon-rank <report-dir> [--limit 100]\n  pk-memory memory residue <report-dir> [--limit 150]\n  pk-memory memory graft-plan <report-dir> [--out ./reports]\n  pk-memory memory timeline <folder-or-zip> [--name label] [--out ./reports] [--include js,json,py,rs,sql] [--no-md]\n  pk-memory memory rpg <folder-or-zip> [--name label] [--out ./reports] [--no-md]\n  pk-memory memory matrix <folder-with-zips-or-layered-dirs> [--name label] [--out ./reports] [--no-md]\n  pk-memory rgano scan <folder-or-zip> [--name structure] [--out ./reports]\n\nExamples:\n  pk-memory memory build C:\\DEV\\cc-master\\conversationchain_master\\_all_zips --name cc-memory\n  pk-memory memory query ./reports/memory/cc-memory --path server.js\n  pk-memory memory lineage ./reports/memory/cc-memory --path server.js\n  pk-memory memory graft-plan ./reports/memory/cc-memory\n  pk-memory memory timeline ./products --name products-canon\n  pk-memory memory rpg ./products --name products-rpg\n  pk-memory memory matrix /tmp/all-zips --name canon-cloverleaf\n`);
}
async function main(){
  const {pos,flags}=parseArgs(process.argv.slice(2));
  const [cmd,sub,arg]=pos;
  if(!cmd || cmd==='--help' || cmd==='help' || flags.help){ help(); return; }
  if(cmd==='memory' && sub==='build') return commandMemoryBuild(arg,flags);
  if(cmd==='memory' && sub==='query') return commandMemoryQuery(arg,flags);
  if(cmd==='memory' && sub==='lineage') return commandMemoryLineage(arg,flags);
  if(cmd==='memory' && sub==='canon-rank') return commandMemoryCanonRank(arg,flags);
  if(cmd==='memory' && sub==='residue') return commandMemoryResidue(arg,flags);
  if(cmd==='memory' && sub==='graft-plan') return commandMemoryGraftPlan(arg,flags);
  if(cmd==='memory' && sub==='timeline') return commandMemoryTimeline(arg,flags);
  if(cmd==='memory' && sub==='rpg') return commandMemoryRpg(arg,flags);
  if(cmd==='memory' && sub==='matrix') return commandMemoryMatrix(arg,flags);
  if(cmd==='rgano' && sub==='scan') return commandRganoScan(arg,flags);
  throw new Error('Unknown command. Use --help.');
}
main().catch(e=>{ console.error('ERROR:',e.message); process.exit(1); });
