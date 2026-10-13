const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
let mercadoLibreCredentials = null;
let mercadoLibreToken = null;
const pendingOAuth = new Map();
const appPassword = process.env.APP_PASSWORD || '';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (appPassword) {
    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (supplied !== appPassword) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Repuestos", charset="UTF-8"', 'Cache-Control': 'no-store' }); return res.end('Ingresá la clave de acceso configurada para esta app.'); }
  }
  if (pathname === '/api/generate' && req.method === 'POST') return generateListing(req, res);
  if (pathname === '/api/vehicle-catalog' && req.method === 'GET') return serveVehicleCatalog(res);
  if (pathname === '/api/ml/connect' && req.method === 'POST') return beginMercadoLibreOAuth(req, res);
  if (pathname === '/api/ml/exchange' && req.method === 'POST') return exchangeMercadoLibreCode(req, res);
  if (pathname === '/api/ml/status' && req.method === 'GET') return mercadoLibreStatus(res);
  if (pathname === '/api/ml/listing-types' && req.method === 'GET') return getListingTypes(req, res);
  if (pathname === '/api/ml/publish' && req.method === 'POST') return publishOnMercadoLibre(req, res);
  if (pathname === '/oauth/callback' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end('<!doctype html><meta charset="utf-8"><title>Autorización recibida</title><p>Mercado Libre devolvió la autorización. Copiá la URL completa de esta página y pegala en el modal de Repuestos para terminar la conexión.</p>');
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const redirectUri = process.env.ML_REDIRECT_URI || 'https://localhost.com/redirect';
async function beginMercadoLibreOAuth(req,res) {
  try {
    const {clientId,clientSecret,redirectUri:requestedRedirect=redirectUri,pkce=false}=await readJson(req,64*1024);
    if(!/^\d+$/.test(String(clientId||''))||!String(clientSecret||'').trim())return sendJson(res,400,{error:'Ingresá el Client ID y Client Secret de tu aplicación de Mercado Libre.'});
    let redirect;try{redirect=new URL(requestedRedirect);}catch{return sendJson(res,400,{error:'La URL de retorno no es válida.'});}
    if(redirect.protocol!=='https:'||redirect.search||redirect.hash)return sendJson(res,400,{error:'La URL de retorno debe ser HTTPS, fija y sin parámetros ni fragmentos.'});
    mercadoLibreCredentials={clientId:String(clientId).trim(),clientSecret:String(clientSecret).trim()};
    const state=crypto.randomBytes(24).toString('hex'),verifier=crypto.randomBytes(32).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const flow={createdAt:Date.now(),verifier,redirectUri:String(requestedRedirect).trim(),pkce:Boolean(pkce)};pendingOAuth.set(state,flow);
    for(const [key,value] of pendingOAuth)if(Date.now()-value.createdAt>10*60*1000)pendingOAuth.delete(key);
    const url=new URL('https://auth.mercadolibre.com.ar/authorization');
    url.searchParams.set('response_type','code');url.searchParams.set('client_id',mercadoLibreCredentials.clientId);url.searchParams.set('redirect_uri',flow.redirectUri);url.searchParams.set('state',state);
    if(flow.pkce){url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');}
    sendJson(res,200,{url:url.href,redirectUri:flow.redirectUri});
  } catch(error) { sendJson(res,400,{error:error.message||'No pude iniciar la autorización de Mercado Libre.'}); }
}
async function exchangeMercadoLibreCode(req,res) {
  try {
    const body=await readJson(req,64*1024);let code=String(body.code||''),state=String(body.state||'');
    if(body.returnUrl){try{const returned=new URL(body.returnUrl);code=returned.searchParams.get('code')||code;state=returned.searchParams.get('state')||state;}catch{return sendJson(res,400,{error:'Pegá la URL completa que aparece después de autorizar en Mercado Libre.'});}}
    const authorization=pendingOAuth.get(state);
    if(!code||!authorization)return sendJson(res,400,{error:'No encuentro un código vigente en esa URL. Iniciá de nuevo la autorización y pegá la URL completa.'});
    const fields={grant_type:'authorization_code',client_id:mercadoLibreCredentials.clientId,client_secret:mercadoLibreCredentials.clientSecret,code,redirect_uri:authorization.redirectUri,...(authorization.pkce?{code_verifier:authorization.verifier}:{})};
    const token=await requestMercadoLibreToken(fields);pendingOAuth.delete(state);mercadoLibreToken={...token,expires_at:Date.now()+Number(token.expires_in||0)*1000};
    sendJson(res,200,{connected:true,userId:token.user_id});
  } catch(error) { sendJson(res,400,{error:error.message||'No pude intercambiar el código por un token.'}); }
}
function mercadoLibreStatus(res) { sendJson(res,200,{connected:Boolean(mercadoLibreToken?.access_token),userId:mercadoLibreToken?.user_id||null,redirectUri}); }
async function requestMercadoLibreToken(fields) {
  const response=await fetch('https://api.mercadolibre.com/oauth/token',{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||data.error_description||data.error||`Mercado Libre respondió ${response.status}`);
  return data;
}
async function getMercadoLibreToken() {
  if(!mercadoLibreToken?.access_token||!mercadoLibreCredentials)throw new Error('Conectá tu cuenta de Mercado Libre desde el modal antes de publicar.');
  if(mercadoLibreToken.expires_at<Date.now()+60000) {
    const refreshed=await requestMercadoLibreToken({grant_type:'refresh_token',client_id:mercadoLibreCredentials.clientId,client_secret:mercadoLibreCredentials.clientSecret,refresh_token:mercadoLibreToken.refresh_token});
    mercadoLibreToken={...refreshed,expires_at:Date.now()+Number(refreshed.expires_in||0)*1000};
  }
  return mercadoLibreToken.access_token;
}
async function getListingTypes(req,res) {
  try {
    const token=await getMercadoLibreToken(),category=new URL(req.url,'http://localhost').searchParams.get('category');
    if(!/^MLA\d+$/.test(category||''))return sendJson(res,400,{error:'Seleccioná una categoría válida de Argentina.'});
    const me=await fetch('https://api.mercadolibre.com/users/me',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)}),user=await me.json().catch(()=>({}));
    if(!me.ok)throw new Error(user.message||'No pude consultar tu cuenta.');
    const response=await fetch(`https://api.mercadolibre.com/users/${user.id}/available_listing_types?category_id=${encodeURIComponent(category)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)}),result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.message||'No pude cargar los tipos de publicación.');
    sendJson(res,200,{types:result.available||[]});
  } catch(error) { sendJson(res,400,{error:error.message||'No pude obtener los tipos de publicación.'}); }
}
async function publishOnMercadoLibre(req,res) {
  let itemId='';
  try {
    const token=await getMercadoLibreToken(),body=await readJson(req,40*1024*1024),draft=body.draft||{};
    const required=['title','description','categoryId','price','stock','listingType','condition','width','height','length','weight'];
    const missing=required.filter(k=>draft[k]===undefined||draft[k]===null||String(draft[k]).trim()==='');
    if(missing.length)return sendJson(res,400,{error:`Faltan campos para publicar: ${missing.join(', ')}.`});
    for(const k of ['price','stock','width','height','length','weight'])if(!Number.isFinite(Number(draft[k]))||Number(draft[k])<0)return sendJson(res,400,{error:`El campo ${k} debe ser un número válido.`});
    for(const k of ['price','width','height','length','weight'])if(Number(draft[k])<=0)return sendJson(res,400,{error:`El campo ${k} debe ser mayor que cero.`});
    if(!Number.isInteger(Number(draft.stock)))return sendJson(res,400,{error:'El stock debe ser un número entero.'});
    if(!/^MLA\d+$/.test(String(draft.categoryId)))return sendJson(res,400,{error:'La categoría no es válida para Mercado Libre Argentina.'});
    const images=Array.isArray(body.images)?body.images.slice(0,10):[];if(!images.length)return sendJson(res,400,{error:'La carpeta no tiene imágenes para subir.'});
    const pictures=[];
    for(const image of images) {
      const buffer=Buffer.from(String(image.data||''),'base64');if(!buffer.length)continue;
      const form=new FormData();form.append('file',new Blob([buffer],{type:image.mimeType||'image/jpeg'}),String(image.name||'repuesto.jpg'));
      const upload=await fetch('https://api.mercadolibre.com/pictures',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(45000)}),uploaded=await upload.json().catch(()=>({}));
      if(!upload.ok)throw new Error(`No pude subir ${image.name||'una foto'}: ${uploaded.message||upload.status}`);pictures.push({id:uploaded.id});
    }
    const attributes=[];
    for(const a of Array.isArray(draft.attributes)?draft.attributes:[]) {
      const id=String(a.id||'').trim(),value=String(a.value||'').trim();if(!id||!value)continue;
      const definition=(draft.attributeDefinitions||[]).find(x=>x.id===id),option=(definition?.values||[]).find(v=>String(v.name||v)===value);
      attributes.push({id,...(option?.id?{value_id:option.id}:{value_name:value})});
    }
    const conditionValue=String(draft.condition).toLowerCase()==='usado'?'used':String(draft.condition).toLowerCase()==='nuevo'?'new':'refurbished';
    const putAttr=(id,value)=>{const entry=attributes.find(x=>x.id===id);if(entry)entry.value_name=value;else attributes.push({id,value_name:value});};
    const conditionAttr=attributes.find(x=>x.id==='ITEM_CONDITION'),conditionDefinition=(draft.attributeDefinitions||[]).find(x=>x.id==='ITEM_CONDITION'),conditionOption=(conditionDefinition?.values||[]).find(v=>String(v.name||v).toLowerCase()===String(draft.condition).toLowerCase());
    if(conditionAttr){delete conditionAttr.value_name;conditionAttr.value_id=conditionOption?.id||({'usado':'2230581','nuevo':'2230284','reacondicionado':'2230582'}[String(draft.condition).toLowerCase()]||'2230581');}else attributes.push({id:'ITEM_CONDITION',value_id:conditionOption?.id||({'usado':'2230581','nuevo':'2230284','reacondicionado':'2230582'}[String(draft.condition).toLowerCase()]||'2230581')});
    for(const [id,key] of [['SELLER_PACKAGE_WIDTH','width'],['SELLER_PACKAGE_HEIGHT','height'],['SELLER_PACKAGE_LENGTH','length'],['SELLER_PACKAGE_WEIGHT','weight']])putAttr(id,String(Math.round(Number(draft[key]))));
    if(draft.sku)putAttr('SELLER_SKU',String(draft.sku));
    const payload={title:String(draft.title).trim(),category_id:String(draft.categoryId),price:Number(draft.price),currency_id:'ARS',available_quantity:Math.floor(Number(draft.stock)),buying_mode:'buy_it_now',listing_type_id:String(draft.listingType),condition:conditionValue,attributes,pictures,shipping:{mode:String(draft.shippingMode||'me2'),free_shipping:Boolean(draft.freeShipping),local_pick_up:false,...(draft.shippingMode==='me1'?{dimensions:`${Math.round(Number(draft.length))}x${Math.round(Number(draft.height))}x${Math.round(Number(draft.width))},${Math.round(Number(draft.weight))}`}:{})},...(draft.sku?{seller_custom_field:String(draft.sku)}:{})};
    const create=await fetch('https://api.mercadolibre.com/items',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)}),item=await create.json().catch(()=>({}));
    if(!create.ok)return sendJson(res,400,{error:item.message||`Mercado Libre rechazó la publicación (${create.status}).`,cause:item.cause||[],details:item});
    itemId=item.id;
    const description=await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({plain_text:String(draft.description).trim()}),signal:AbortSignal.timeout(30000)}),descriptionResult=await description.json().catch(()=>({}));
    sendJson(res,description.ok?201:207,{id:itemId,status:item.status,url:item.permalink,descriptionAdded:description.ok,warning:description.ok?'':descriptionResult.message||'La publicación se creó, pero no se pudo guardar la descripción.'});
  } catch(error) { sendJson(res,itemId?207:400,{error:itemId?`La publicación ${itemId} se creó, pero hubo un error posterior: ${error.message}`:error.message||'Falló la publicación.',itemId:itemId||undefined}); }
}
async function serveVehicleCatalog(res) {
  const dirs=[root,path.resolve(root,'..')];
  for (const dir of dirs) {
    try {
      const names=(await fs.promises.readdir(dir)).filter(n=>/\.(xlsx|xls|csv)$/i.test(n)&&!n.startsWith('~$')).sort((a,b)=>{
        const priority=name=>/(veh[ií]c|auto|compat|catalog|producto)/i.test(name)?0:1;
        return priority(a)-priority(b)||a.localeCompare(b,'es');
      });
      if (!names.length) continue;
      const file=path.join(dir,names[0]);
      res.writeHead(200,{'Content-Type':'application/octet-stream','X-Catalog-Name':encodeURIComponent(names[0]),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(names[0])}`,'Cache-Control':'no-store'});
      return fs.createReadStream(file).pipe(res);
    } catch { /* The selected image folder can supply the workbook through its directory picker. */ }
  }
  sendJson(res,404,{error:'No encontré un Excel junto a la app. Si está en la carpeta de fotos, lo voy a leer al seleccionarla.'});
}
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req, limit = 32 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Las fotos superan el límite del análisis. Probá con menos imágenes.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function gemini(key, parts, json = true) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}) }),
    signal: AbortSignal.timeout(90000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Gemini respondió ${response.status}.`;
    const error = new Error(message); error.status = response.status; throw error;
  }
  const output = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!output) throw new Error('El modelo no devolvió una ficha.');
  if (!json) return output;
  try { return JSON.parse(output); }
  catch { return JSON.parse(output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
}
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, '').trim();
}
function realSearchUrl(raw) {
  let value = decodeHtml(raw);
  if (value.startsWith('//')) value = `https:${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.searchParams.has('uddg')) return parsed.searchParams.get('uddg');
    return parsed.href;
  } catch { return ''; }
}
async function mercadoLibreCategory(query) {
  try {
    const url = `https://api.mercadolibre.com/sites/MLA/domain_discovery/search?limit=3&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'RepuestosLocal/0.1' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? data[0] || null : null;
  } catch { return null; }
}
function extractRequiredAttributes(attributes, inputSpec) {
  const found = new Map();
  const add = a => {
    if (!a || !a.id) return;
    const tags = Array.isArray(a.tags) ? a.tags : Object.entries(a.tags || {}).filter(([,v]) => v).map(([k]) => k);
    if (a.required === true || tags.includes('required')) found.set(a.id, { id: a.id, name: a.name || a.id, value_type: a.value_type || 'string', values: (a.values || []).slice(0,100).map(v => ({ id: v.id || '', name: v.name || v.value_name || v.id || '' })).filter(v => v.name) });
  };
  if (Array.isArray(attributes)) attributes.forEach(add);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.id && (value.name || value.value_type || value.tags)) add(value);
    for (const [key, child] of Object.entries(value)) if (key !== 'attributes') visit(child);
    if (Array.isArray(value.attributes)) value.attributes.forEach(add);
  };
  visit(inputSpec);
  return [...found.values()];
}
async function getMercadoLibreCategoryDetails(candidate) {
  if (!candidate?.category_id) return null;
  try {
    const base = 'https://api.mercadolibre.com/categories/' + encodeURIComponent(candidate.category_id);
    const [catRes, attrsRes, specRes] = await Promise.all([
      fetch(base, { signal: AbortSignal.timeout(10000) }),
      fetch(`${base}/attributes`, { signal: AbortSignal.timeout(10000) }),
      fetch(`${base}/technical_specs/input`, { signal: AbortSignal.timeout(10000) })
    ]);
    const [category, attrs, specs] = await Promise.all([catRes.ok?catRes.json():{},attrsRes.ok?attrsRes.json():[],specRes.ok?specRes.json():{}]);
    return { id: candidate.category_id, name: candidate.category_name || category.name, path: (category.path_from_root || []).map(x=>x.name).join(' > '), maxTitleLength: Number(category.settings?.max_title_length)||60, requiredAttributes: extractRequiredAttributes(attrs,specs) };
  } catch { return { id: candidate.category_id, name: candidate.category_name, maxTitleLength: 60, requiredAttributes: [] }; }
}
function fitmentLabel(v) {
  if (typeof v === 'string') return v;
  return [v.make || v.brand, v.model, v.years, v.version, v.engine].filter(Boolean).join(' ');
}
function fitmentObjects(values) {
  if (!Array.isArray(values)) return [];
  return values.map(v => typeof v === 'string' ? { make: '', model: v, years: '', version: '', engine: '', position: '', source: '' } : {
    make: String(v.make || v.brand || ''), model: String(v.model || ''), years: String(v.years || v.year || ''), version: String(v.version || v.trim || ''), engine: String(v.engine || v.displacement || ''), position: String(v.position || v.side || ''), source: String(v.source || '')
  }).filter(v => v.make || v.model);
}
function matchVehicleIds(fitments, rows) {
  if (!Array.isArray(rows)) return fitments;
  const catalog = rows.slice(0,20000).filter(r=>r && r.id && (r.make||r.model));
  const norm = s => String(s||'').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  return fitments.map(f => {
    const make=norm(f.make), model=norm(f.model);
    if (!model) return { ...f, marketplace_vehicle_ids: [] };
    const yearNumbers=value=>[...String(value||'').matchAll(/\b(?:19|20)\d{2}\b|\b\d{2}\b/g)].map(m=>{const n=Number(m[0]);return m[0].length===2?(n<50?2000+n:1900+n):n;});
    const yearMatches=(a,b)=>{
      if(!a||!b)return true;
      const aa=yearNumbers(a),bb=yearNumbers(b); if(!aa.length||!bb.length)return true;
      const lo=Math.min(...aa),hi=Math.max(...aa);
      return Math.max(lo,Math.min(...bb))<=Math.min(hi,Math.max(...bb));
    };
    const textMatches=(a,b)=>{const x=norm(a),y=norm(b);return !x||!y||x===y||x.includes(y)||y.includes(x);};
    const matches=catalog.filter(row=>{
      const rm=norm(row.make), rmodel=norm(row.model);
      const makeMatches=!make || (!!rm && (rm===make || rm.includes(make) || make.includes(rm)));
      const modelMatches=rmodel===model || rmodel.includes(model) || model.includes(rmodel);
      return makeMatches && modelMatches && yearMatches(f.years,row.years) && textMatches(f.engine,row.engine) && textMatches(f.version,row.version);
    });
    const engines=[...new Set(matches.map(r=>r.engine).filter(Boolean))];
    const years=[...new Set(matches.map(r=>r.years).filter(Boolean))];
    return { ...f, make:f.make||matches[0]?.make||'', model:f.model||matches[0]?.model||'', version:f.version||(new Set(matches.map(r=>r.version).filter(Boolean)).size===1?matches[0]?.version||'':''), engine:f.engine||(engines.length===1?engines[0]:''), years:f.years||(years.length?years.join(', '):''), marketplace_vehicle_ids: [...new Set(matches.map(row=>row.id))].slice(0,500), matched_catalog_rows: matches.slice(0,500) };
  });
}
function shortYears(value) {
  const raw=String(value||'');
  const matches=[...raw.matchAll(/\b(?:19|20)\d{2}\b|\b\d{2}\b/g)].map(m=>{const v=Number(m[0]);return m[0].length===2?(v<50?2000+v:1900+v):v;});
  if(matches.length>=2) {
    const years=[...new Set(matches)].sort((a,b)=>a-b);
    return `${String(years[0]).slice(-2)}-${String(years.at(-1)).slice(-2)}`;
  }
  return raw.replace(/\b(?:19|20)(\d{2})\b/g,'$1');
}
function positionAbbreviation(value) {
  const s=String(value||'').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const front=/\b(del|delanter[oa]|front)\b/.test(s), rear=/\b(tras|traser[oa]|rear)\b/.test(s);
  const left=/\b(izq|izquierd[oa]|left)\b/.test(s), right=/\b(der|derech[oa]|right)\b/.test(s);
  return `${front?'del':rear?'tras':''}${left?' izq':right?' der':''}`.trim();
}
function makeListingTitle(data, maxLength) {
  const part = String(data.product_type || data.title || 'Repuesto').replace(/\busad(?:o|a|os|as)?\b/gi,'').replace(/\busad\b/gi,'').replace(/\b(delanter[oa]|traser[oa]|izquierd[oa]|derech[oa])\b/gi,'').trim();
  const fits = fitmentObjects(data.vehicle_compatibilities);
  const engines = [...new Set(fits.map(x=>x.engine).filter(Boolean))];
  const motorRelevant = /\b(caja|radiador|aceite|reten(?:es)?|ret[eé]n(?:es)?|motor|transmisi[oó]n|filtro)\b/i.test(part);
  const engine = motorRelevant && engines.length === 1 ? engines[0] : '';
  const models = [...new Set(fits.map(x=>[x.make,x.model].filter(Boolean).join(' ')))];
  const allYears = shortYears(fits.map(x=>x.years).filter(Boolean).join(' '));
  const position = positionAbbreviation(data.position || fits.map(f=>f.position).find(Boolean));
  const original = data.is_original === true ? 'original' : '';
  const limit=Math.max(1,Number(maxLength)||60), reserved=`${original?' '+original:''} USAD`;
  const connectors=new Set(['a','al','con','contra','de','del','desde','durante','e','el','en','entre','hacia','hasta','la','las','lo','los','o','para','por','que','sin','sobre','tras','un','una','unos','unas','y']);
  const partWords=part.replace(/\s+/g,' ').trim().split(' ').filter(word=>{
    const normalized=word.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    return normalized && !connectors.has(normalized);
  });
  if(!partWords.length) partWords.push('Repuesto');
  let title='';
  for(const word of partWords){const candidate=`${title} ${word}`.trim();if(candidate.length+reserved.length>limit)break;title=candidate;}
  if(!title) title=part.slice(0,Math.max(1,limit-reserved.length)).trimEnd();
  const append = value => {
    if (!value) return;
    const candidate = `${title} ${value}`.replace(/\s+/g,' ').trim();
    if (candidate.length + reserved.length <= limit) title = candidate;
  };
  append(position);
  for (const model of models) append(model);
  append(engine);
  append(allYears);
  if (title.length + reserved.length > limit && original) return `${title} USAD`.slice(0,limit).trimEnd();
  return `${title}${reserved}`.slice(0,limit).trimEnd();
}
async function webSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RepuestosLocal/0.1)' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return [];
    const html = await response.text();
    const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi)].slice(0, 4);
    return matches.map(m => ({ url: realSearchUrl(m[1]), title: decodeHtml(m[2]), snippet: decodeHtml(m[3] || '') })).filter(x => /^https?:\/\//i.test(x.url));
  } catch { return []; }
}
async function generateListing(req, res) {
  try {
    const key = String(req.headers['x-gemini-api-key'] || '').trim();
    if (!key) return sendJson(res, 401, { error: 'Pegá tu clave gratuita de Gemini AI Studio para empezar.' });
    const body = await readJson(req);
    const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
    const vehicleRows = Array.isArray(body.vehicleRows) ? body.vehicleRows.slice(0,20000) : [];
    if (!images.length || images.some(i => !i.data || typeof i.data !== 'string' || i.data.length > 9 * 1024 * 1024)) return sendJson(res, 400, { error: 'No hay fotos válidas para analizar.' });
    const prompt = `Sos especialista en identificación de autopartes y redacción de publicaciones de Mercado Libre Argentina. Analizá todas las imágenes y leé texto/códigos visibles con OCR visual. Diferenciá el código de pieza de números de stock en rojo o verde. No inventes. Devolvé JSON válido con title, description, brand, part_number, product_type, suggested_category, stock_estimate, package_dimensions, package_weight, price_reference, technical_specs (lista), vehicle_compatibilities (lista de objetos con make, model, version, engine, years, source), position (lado/posición del repuesto, si se puede determinar), is_original (boolean), confidence (baja/media/alta), visual_clues, missing_or_uncertain, search_queries (hasta 3). La descripción debe incluir todos los datos de compatibilidad respaldados por evidencia y señalar los no confirmados. No deduzcas precio, peso ni medidas por apariencia. El título lo compone la app con este orden: nombre de pieza, posición en minúscula (del izq/del der/tras izq/tras der), vehículo, motor/cilindrada solo en repuestos como caja, radiador, aceite o retenes, años cortos unidos con guion, y al final original si corresponde y USAD. No afirmes compatibilidades sin pruebas.`;
    const firstParts = [{ text: prompt }, ...images.map(i => ({ inline_data: { mime_type: i.mimeType || 'image/jpeg', data: i.data } }))];
    const initial = await gemini(key, firstParts);
    const categoryCandidate = await mercadoLibreCategory(`${initial.product_type || initial.title || 'repuesto'} ${initial.suggested_category || ''}`.trim());
    const categoryDetails = await getMercadoLibreCategoryDetails(categoryCandidate);
    const queries = [...new Set((Array.isArray(initial.search_queries) ? initial.search_queries : []).filter(x => typeof x === 'string').slice(0, 3))];
    const resultGroups = await Promise.all(queries.map(webSearch));
    const sources = resultGroups.flat().filter((x, i, arr) => arr.findIndex(y => y.url === x.url) === i).slice(0, 8);
    let finalData = initial;
    if (sources.length || categoryDetails?.requiredAttributes?.length) {
      const reconcile = `Confrontá la identificación inicial con estos resultados web. Prioriza coincidencia exacta de código y marca; los títulos de página no bastan. Actualiza las compatibilidades SOLO con evidencia y devuélvelas como objetos {make,model,version,engine,years,source}. Genera una descripción completa, útil para que el comprador compare marca/modelo/años/motor; diferencia originalidad y condición y no inventes. No deduzcas medidas, peso ni precio de venta. Devolvé JSON válido con title, description, brand, part_number, product_type, suggested_category, stock_estimate, package_dimensions, package_weight, price_reference, technical_specs (lista), position, confidence (baja/media/alta), visual_clues, match_summary, missing_or_uncertain, vehicle_compatibilities (lista), required_category_attributes (objeto con attribute_id como clave y valor sugerido; deja vacío si no hay evidencia). Categoría Mercado Libre: ${JSON.stringify(categoryDetails || {})}. Atributos que Mercado Libre marca como requeridos: ${JSON.stringify(categoryDetails?.requiredAttributes || [])}. Resultados web: ${JSON.stringify(sources)}`;
      try { finalData = { ...initial, ...await gemini(key, [{ text: reconcile }]) }; }
      catch { finalData = { ...initial, match_summary: 'Se encontraron páginas coincidentes; revisá las fuentes antes de confiar en la identificación.' }; }
    } else {
      finalData.match_summary = 'No se encontraron resultados web utilizables para contrastar la identificación.';
    }
    finalData.vehicle_compatibilities = matchVehicleIds(fitmentObjects(finalData.vehicle_compatibilities), vehicleRows);
    const fitmentLines = finalData.vehicle_compatibilities.map(f=>fitmentLabel(f)).filter(Boolean);
    let description = String(finalData.description || '').trim();
    if (!/\busad[oa]s?\b/i.test(description)) description += `${description?'\n\n':''}Condición: repuesto usado. Revisá las fotos y los datos de compatibilidad antes de comprar.`;
    if (fitmentLines.length && !fitmentLines.every(line=>description.toLowerCase().includes(line.toLowerCase()))) description += `\n\nCompatibilidades encontradas para verificar: ${fitmentLines.join('; ')}.`;
    finalData.description = description;
    finalData.title = makeListingTitle(finalData, Math.min(60, categoryDetails?.maxTitleLength || 60));
    if (categoryDetails) finalData.suggested_category = `${categoryDetails.name || finalData.suggested_category} (${categoryDetails.id})`;
    sendJson(res, 200, { listing: finalData, sources, searched: queries, category: categoryDetails, titleLimit: Math.min(60, categoryDetails?.maxTitleLength || 60) });
  } catch (error) {
    const status = error.status === 429 ? 429 : error.status === 403 || error.status === 400 ? error.status : 500;
    sendJson(res, status, { error: error.message || 'Falló la generación. Revisá tu conexión y volvé a intentar.' });
  }
}
const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => console.log(`Repuestos listo en el puerto ${port}`));
