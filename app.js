const folderInput = document.querySelector('#folderInput');
const workspace = document.querySelector('#workspace');
const actionBar = document.querySelector('#actionBar');
const folderList = document.querySelector('#folderList');
const detail = document.querySelector('#detail');
const identifyButton = document.querySelector('#identify');
const apiKeyInput = document.querySelector('#apiKey');
const runStatus = document.querySelector('#runStatus');
let groups = new Map();
let selectedKey = null;
let vehicleRows = [];
let catalogLoading = false;
let currentCategory = null;
let generatedForSelectedFolder = false;

apiKeyInput.value = sessionStorage.getItem('geminiApiKey') || '';
if (apiKeyInput.value) runStatus.textContent = 'Clave lista · elegí una carpeta y generá la ficha';
apiKeyInput.addEventListener('input', () => {
  sessionStorage.setItem('geminiApiKey', apiKeyInput.value.trim());
  runStatus.textContent = apiKeyInput.value.trim() ? 'Clave lista · elegí una carpeta y generá la ficha' : 'Primero pegá una clave de Gemini gratuita';
  updateGenerateButton();
});
async function loadVehicleBook(file) {
  catalogLoading=true; updateGenerateButton();
  runStatus.textContent=`Leyendo ${file.name}…`;
  try {
    if(!window.XLSX) throw new Error('No se cargó el lector de Excel. Revisá la conexión y recargá la app.');
    const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true});
    vehicleRows=[];
    for(const name of wb.SheetNames) {
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:'',raw:false});
      for(const row of rows) {
        const cells=new Map(Object.entries(row).map(([k,v])=>[normalize(k),String(v??'').trim()]));
        const pick=(...keys)=>{for(const k of keys){const v=cells.get(normalize(k));if(v)return v;}return '';};
        const id=pick('producto_id','producto id','product_id','id','vehicle id','vehicle_id','catalog product id','catalog_product_id','product id','id product','auto id','id modelo','id vehículo');
        const make=pick('marca','marca auto','marca vehículo','marca del vehículo','brand','make','vehicle make','automaker');
        const model=pick('modelo','modelo auto','modelo vehículo','modelo del vehículo','model','vehicle model','car model','name');
        const engine=pick('cilindrada','cilindraje','cilindrada del motor','engine','displacement','motor','engine size');
        const version=pick('versión','version','vehicle version','trim','variant');
        const year=pick('año','ano','año modelo','ano modelo','year','years','model year');
        const from=pick('año desde','year from','year start','start year'), to=pick('año hasta','year to','year end','end year');
        if(id && (make||model)) vehicleRows.push({id,make,model,version,engine,years:year||(from&&to?`${from}-${to}`:from||to)});
      }
    }
    runStatus.textContent=vehicleRows.length?`Excel listo · ${vehicleRows.length.toLocaleString()} vehículos cargados`:'No encontré filas con columnas ID, marca y modelo.';
  } catch(error) { vehicleRows=[]; runStatus.textContent=error.message; }
  finally { catalogLoading=false; updateGenerateButton(); }
}
async function loadAppCatalog() {
  try {
    const response=await fetch('/api/vehicle-catalog');
    if(!response.ok) return;
    const name=decodeURIComponent(response.headers.get('x-catalog-name')||'vehiculos.xlsx');
    await loadVehicleBook(new File([await response.blob()],name));
  } catch { /* A workbook at the selected root will be found when that folder is chosen. */ }
}
loadAppCatalog();
function normalize(value) { return String(value??'').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function shortYears(value) {
  const raw=String(value||'');
  const matches=[...raw.matchAll(/\b(?:19|20)\d{2}\b/g)].map(m=>Number(m[0]));
  if(matches.length>=2) {
    const values=[...new Set(matches)].sort((a,b)=>a-b);
    if(values.every((v,i)=>i===0||v===values[i-1]+1)) return `${String(values[0]).slice(-2)}-${String(values.at(-1)).slice(-2)}`;
    return values.map(v=>String(v).slice(-2)).join(',');
  }
  return raw.replace(/\b(?:19|20)(\d{2})\b/g,'$1');
}
function isImage(file) { return file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(file.name); }
function isVideo(file) { return file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi)$/i.test(file.name); }
function esc(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function groupFiles(files) {
  const map = new Map();
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    if (parts.length < 2) continue;
    if (!isImage(file) && !isVideo(file)) continue;
    if (!map.has(parts[1])) map.set(parts[1], []);
    map.get(parts[1]).push(file);
  }
  return new Map([...map.entries()].sort(([a],[b]) => a.localeCompare(b, 'es', {numeric:true, sensitivity:'base'})));
}
folderInput.addEventListener('change', () => {
  const selectedFiles=[...folderInput.files];
  groups = groupFiles(selectedFiles);
  const workbook=selectedFiles.find(file=>file.webkitRelativePath?.split('/').length===2 && /\.(xlsx|xls|csv)$/i.test(file.name));
  if(workbook) loadVehicleBook(workbook);
  else if(!vehicleRows.length) runStatus.textContent='No encontré Excel en la carpeta del programa ni en la raíz seleccionada.';
  document.querySelector('#folderCount').textContent = `${groups.size} ${groups.size === 1 ? 'carpeta' : 'carpetas'}`;
  workspace.classList.toggle('hidden', groups.size === 0);
  actionBar.classList.toggle('hidden', groups.size === 0);
  renderList();
  const first = groups.keys().next().value;
  if (first) selectFolder(first);
});
function renderList() {
  folderList.innerHTML = [...groups].map(([name,files]) => `<div class="folder-item ${name===selectedKey?'active':''}" data-key="${esc(name)}"><span class="folder-name">${esc(name)}</span><span class="folder-meta">${files.filter(isImage).length} fotos · ${files.filter(isVideo).length} videos</span></div>`).join('');
  folderList.querySelectorAll('.folder-item').forEach(el => el.addEventListener('click', () => selectFolder(el.dataset.key)));
}
function selectFolder(key) {
  selectedKey = key;
  generatedForSelectedFolder = false;
  currentCategory = null;
  document.querySelector('#activeFolderLabel').textContent = `Carpeta ${key}`;
  renderList(); renderDetail(); updateGenerateButton();
}
function updateGenerateButton() {
  identifyButton.disabled = catalogLoading || !selectedKey || !apiKeyInput.value.trim() || !(groups.get(selectedKey)||[]).some(isImage);
}
function renderDetail() {
  const files=groups.get(selectedKey)||[];
  const media=files.filter(f=>isImage(f)||isVideo(f));
  const imgs=files.filter(isImage);
  detail.innerHTML=`<div class="detail-head"><div><h2>Carpeta ${esc(selectedKey)}</h2><p>${imgs.length} imágenes · ${files.filter(isVideo).length} videos · ${files.length} archivos en total</p></div><div class="detail-actions"><span class="badge">Ficha editable</span><button id="openPublish" type="button" class="button publish-open">Vista previa y publicar</button></div></div>
  <div class="media-grid">${media.map(f=>`<article class="media-card"><div class="media-preview">${isImage(f)?`<img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}">`:`<video src="${URL.createObjectURL(f)}" controls preload="metadata"></video>`}</div><div class="media-name" title="${esc(f.name)}">${esc(f.name)}</div></article>`).join('')}</div>
  <div class="form-grid">
    <div class="field wide"><label for="title">Título sugerido · máximo 60 caracteres</label><input id="title" maxlength="60" placeholder="Se completa al generar la ficha"></div>
    <div class="field wide"><label for="description">Descripción sugerida</label><textarea id="description" placeholder="Se completa al generar la ficha"></textarea></div>
    <div class="field"><label for="partName">Tipo de repuesto</label><input id="partName" placeholder=""></div>
    <div class="field"><label for="partCode">Código / referencia</label><input id="partCode" placeholder=""></div>
    <div class="field"><label for="brand">Marca</label><input id="brand" placeholder=""></div>
    <div class="field"><label for="category">Categoría sugerida</label><input id="category" placeholder=""></div>
    <div class="field"><label for="stock">Stock leído en la imagen</label><input id="stock" placeholder="Sin confirmar"></div>
    <div class="field"><label for="condition">Condición</label><select id="condition"><option>Usado</option><option>Nuevo</option><option>Reacondicionado</option></select></div>
    <div class="field"><label for="price">Precio de venta</label><input id="price" placeholder="Definir precio propio"></div>
    <div class="field"><label for="priceReference">Precio de referencia web</label><input id="priceReference" placeholder="Sin fuente verificable"></div>
    <div class="field"><label for="packageDimensions">Medidas del paquete</label><input id="packageDimensions" placeholder="Completar con medición real"></div>
    <div class="field"><label for="packageWeight">Peso del paquete</label><input id="packageWeight" placeholder="Completar con balanza"></div>
    <div class="field"><label for="confidence">Confianza del análisis</label><input id="confidence" readonly></div>
    <div class="field wide"><label for="technicalSpecs">Ficha técnica sugerida</label><textarea id="technicalSpecs" placeholder="Solo datos visibles o respaldados por una fuente"></textarea></div>
    <div class="field wide"><label for="compatibilities">Compatibilidades respaldadas por fuentes</label><textarea id="compatibilities" placeholder="Se dejan vacías si no hay evidencia"></textarea></div>
    <div class="field wide"><label for="notes">Coincidencias y datos por confirmar</label><textarea id="notes" placeholder=""></textarea></div>
  </div>
  <section class="required-box" id="requiredAttributes"><p class="footer-note">Los atributos obligatorios se cargarán al sugerir una categoría de Mercado Libre.</p></section>
  <section class="ocr-box"><div class="ocr-top"><h3>Fuentes encontradas</h3><span id="resultStatus">Esperando generación automática</span></div><div id="sources" class="source-list"><p class="footer-note">Con la clave de Gemini cargada, el botón analiza las imágenes y busca coincidencias web.</p></div></section>`;
}
function jpegBase64(file) {
  return new Promise(async (resolve,reject) => {
    try {
      const bitmap=await createImageBitmap(file);
      const scale=Math.min(1,1100/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
      canvas.toBlob(blob=>{
        if(!blob) return reject(new Error(`No pude preparar ${file.name}.`));
        const reader=new FileReader(); reader.onload=()=>resolve({name:file.name,mimeType:'image/jpeg',data:String(reader.result).split(',')[1]}); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(blob);
      },'image/jpeg',0.72);
    } catch(e) { reject(new Error(`No pude abrir ${file.name}: ${e.message}`)); }
  });
}
function setField(id,value) { const el=document.querySelector(`#${id}`); if(el && value != null) el.value=Array.isArray(value)?value.join('\n'):String(value); }
function renderRequiredAttributes(category, values={}) {
  const host=document.querySelector('#requiredAttributes'); if(!host)return;
  const required=category?.requiredAttributes||[];
  if(!required.length) { host.innerHTML='<p class="footer-note">No se pudo recuperar la lista de atributos obligatorios de la categoría.</p>'; return; }
  host.innerHTML=`<h3>Campos requeridos por Mercado Libre · ${esc(category.id)}</h3><div class="required-grid">${required.map(a=>{const safe=`required_${String(a.id).replace(/[^a-z0-9_-]/gi,'_')}`; const options=(a.values||[]).map((v,i)=>`<option value="${esc(v.name||v.value_name||v.id||v)}" id="${safe}_opt${i}"></option>`).join('');const raw=values[a.id];const value=raw&&typeof raw==='object'?(raw.value_name||raw.value||raw.name||''):raw;return `<div class="field"><label for="${safe}">${esc(a.name)} <span class="required-mark">Obligatorio</span></label><input id="${safe}" data-attribute-id="${esc(a.id)}" list="${safe}_list" value="${esc(value??'')}"><datalist id="${safe}_list">${options}</datalist></div>`;}).join('')}</div>`;
}
const publishModal=document.querySelector('#publishModal');
let mlAppClientId='';
function categoryIdForPublish(){return document.querySelector('#category')?.value.match(/MLA\d+/)?.[0]||currentCategory?.id||'';}
function parseDimensions(value){const matches=String(value||'').replace(',','.').match(/\d+(?:\.\d+)?/g)||[];return matches.length>=3?matches.slice(0,3).map(Number):['','',''];}
function parseMeasurement(value,weight=false){const raw=String(value||'').replace(',','.');const m=raw.match(/\d+(?:\.\d+)?/g)||[];if(!m.length)return '';let n=Number(m.at(-1));if(weight&&/kg/i.test(raw))n*=1000;return Math.round(n)||'';}
function setPublishNotice(message){const box=document.querySelector('#publishMissing');box.textContent=message;box.classList.toggle('hidden',!message);}
function requiredAttributeValues(){return [...document.querySelectorAll('#requiredAttributes [data-attribute-id]')].map(input=>({id:input.dataset.attributeId,value:input.value.trim()}));}
function missingTechnicalFields(){
  const missing=[];
  if(!generatedForSelectedFolder)missing.push('Generá primero la ficha automática de esta carpeta.');
  if(!document.querySelector('#title')?.value.trim())missing.push('Título');
  if(!document.querySelector('#description')?.value.trim())missing.push('Descripción');
  if(!document.querySelector('#technicalSpecs')?.value.trim())missing.push('Ficha técnica');
  if(!categoryIdForPublish())missing.push('Categoría válida de Mercado Libre');
  const required=currentCategory?.requiredAttributes||[];
  for(const attr of required){if(/^(ITEM_)?CONDITION$/i.test(attr.id))continue;const input=[...document.querySelectorAll('#requiredAttributes [data-attribute-id]')].find(el=>el.dataset.attributeId===attr.id);if(!input?.value.trim())missing.push(attr.name||attr.id);}
  return missing;
}
function renderPublishAttributes(){
  const target=document.querySelector('#publishAttributes'),definitions=currentCategory?.requiredAttributes||[];
  if(!definitions.length){target.innerHTML='<p class="hint">No se detectaron atributos obligatorios para esta categoría.</p>';return;}
  target.innerHTML=definitions.filter(a=>!/^ITEM_CONDITION$/i.test(a.id)).map(a=>{const main=[...document.querySelectorAll('#requiredAttributes [data-attribute-id]')].find(el=>el.dataset.attributeId===a.id);const safe=`pub_${String(a.id).replace(/[^a-z0-9_-]/gi,'_')}`;return `<div class="field"><label for="${safe}">${esc(a.name)}</label><input id="${safe}" data-publish-attribute="${esc(a.id)}" value="${esc(main?.value||'')}" list="${safe}_list"><datalist id="${safe}_list">${(a.values||[]).map(v=>`<option value="${esc(v.name||v)}"></option>`).join('')}</datalist></div>`;}).join('');
}
function openPublicationPreview(){
  const missing=missingTechnicalFields();
  if(missing.length){const msg=`Completá la ficha técnica antes de preparar la publicación: ${missing.join(' · ')}.`;runStatus.textContent=msg;const box=document.querySelector('#publishMissing');box.textContent=msg;box.classList.remove('hidden');const emptyRequired=[...document.querySelectorAll('#requiredAttributes [data-attribute-id]')].find(el=>!el.value.trim());(emptyRequired||document.querySelector('#technicalSpecs')||document.querySelector('#requiredAttributes'))?.scrollIntoView({behavior:'smooth',block:'center'});return;}
  setPublishNotice('');
  setField('publishTitleInput',document.querySelector('#title').value);document.querySelector('#publishTitleInput').maxLength=document.querySelector('#title').maxLength;setField('publishDescription',document.querySelector('#description').value);
  setField('publishCategory',`${document.querySelector('#category').value} · ${categoryIdForPublish()}`);setField('publishSku',document.querySelector('#partCode').value);
  const stockText=document.querySelector('#stock').value.match(/\d+/)?.[0]||'';setField('publishStock',stockText);setField('publishPrice',document.querySelector('#price').value);
  setField('publishCondition',document.querySelector('#condition').value);const dimensions=parseDimensions(document.querySelector('#packageDimensions').value);setField('publishWidth',dimensions[0]);setField('publishHeight',dimensions[1]);setField('publishLength',dimensions[2]);setField('publishWeight',parseMeasurement(document.querySelector('#packageWeight').value,true));
  setField('publishCompatibility',document.querySelector('#compatibilities').value);
  const photos=(groups.get(selectedKey)||[]).filter(isImage).slice(0,10);document.querySelector('#publishImageCount').textContent=`Se subirán ${photos.length} fotos de la carpeta ${selectedKey}. Los videos no se incluyen en esta primera versión.`;
  renderPublishAttributes();publishModal.showModal();checkMercadoLibreConnection();
}
detail.addEventListener('click',event=>{if(event.target.closest('#openPublish'))openPublicationPreview();});
document.querySelector('#closePublish').addEventListener('click',()=>publishModal.close());
document.querySelector('#connectMercadoLibre').addEventListener('click',async()=>{
  const popup=window.open('about:blank','mercadolibre-oauth');if(!popup){document.querySelector('#mlConnectionStatus').textContent='El navegador bloqueó la ventana de autorización.';return;}
  const status=document.querySelector('#mlConnectionStatus');status.textContent='Preparando la autorización…';
  try {
    const clientId=document.querySelector('#mlClientId').value.trim(),clientSecret=document.querySelector('#mlClientSecret').value.trim(),redirectUri=document.querySelector('#mlRedirectUri').value.trim(),pkce=document.querySelector('#mlPkce').checked;
    const response=await fetch('/api/ml/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId,clientSecret,redirectUri,pkce})}),data=await response.json();if(!response.ok)throw new Error(data.error||'No pude iniciar la autorización.');
    document.querySelector('#mlRedirectUri').value=data.redirectUri;popup.location=data.url;status.textContent='Autorizá en la pestaña nueva. Después copiá la URL de retorno completa y pegala aquí.';
  } catch(error){if(!popup.closed)popup.close();status.textContent=error.message;}
});
document.querySelector('#finishMercadoLibre').addEventListener('click',async()=>{
  const status=document.querySelector('#mlConnectionStatus'),returnUrl=document.querySelector('#mlAuthorizationReturn').value.trim();status.textContent='Validando autorización…';
  try{const response=await fetch('/api/ml/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnUrl})}),data=await response.json();if(!response.ok)throw new Error(data.error||'No pude completar la conexión.');document.querySelector('#mlClientSecret').value='';document.querySelector('#mlConnectionBadge').textContent='Conectada';document.querySelector('#mlConnectionBadge').classList.add('connected');status.textContent=`Conectada · cuenta ${data.userId}`;await loadAvailableListingTypes();}
  catch(error){status.textContent=error.message;}
});
async function checkMercadoLibreConnection(){try{const data=await fetch('/api/ml/status').then(r=>r.json());if(data.connected){document.querySelector('#mlConnectionStatus').textContent=`Conectada · cuenta ${data.userId}`;document.querySelector('#mlConnectionBadge').textContent='Conectada';document.querySelector('#mlConnectionBadge').classList.add('connected');await loadAvailableListingTypes();}else{document.querySelector('#mlConnectionStatus').textContent='Aún no conectada';document.querySelector('#mlConnectionBadge').textContent='Desconectada';}}catch{}}
async function loadAvailableListingTypes(){
  const select=document.querySelector('#publishListingType'),category=categoryIdForPublish();if(!category)return;
  select.innerHTML='<option value="">Consultando opciones…</option>';
  try{const response=await fetch(`/api/ml/listing-types?category=${encodeURIComponent(category)}`),data=await response.json();if(!response.ok)throw new Error(data.error);select.innerHTML='<option value="">Elegí el tipo de publicación</option>'+data.types.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(t.id)}</option>`).join('');}
  catch(error){select.innerHTML='<option value="">No se pudieron consultar opciones</option>';document.querySelector('#mlConnectionStatus').textContent=error.message;}
}
document.querySelector('#submitPublish').addEventListener('click',async()=>{
  const status=document.querySelector('#publishStatus'),button=document.querySelector('#submitPublish');
  const field=id=>document.querySelector(`#${id}`).value.trim();
  const draft={title:field('publishTitleInput'),description:field('publishDescription'),categoryId:categoryIdForPublish(),price:field('publishPrice'),stock:field('publishStock'),listingType:field('publishListingType'),condition:field('publishCondition'),sku:field('publishSku'),shippingMode:field('publishShippingMode'),freeShipping:document.querySelector('#publishFreeShipping').checked,width:field('publishWidth'),height:field('publishHeight'),length:field('publishLength'),weight:field('publishWeight'),attributes:[...document.querySelectorAll('[data-publish-attribute]')].map(el=>({id:el.dataset.publishAttribute,value:el.value.trim()})),attributeDefinitions:currentCategory?.requiredAttributes||[]};
  const missing=[];for(const key of ['title','description','categoryId','price','stock','listingType','width','height','length','weight'])if(!draft[key])missing.push(key);
  for(const attr of currentCategory?.requiredAttributes||[]){if(/^(ITEM_)?CONDITION$/i.test(attr.id))continue;if(!draft.attributes.find(a=>a.id===attr.id&&a.value))missing.push(attr.name||attr.id);}
  if(missing.length){const labels={title:'Título',description:'Descripción',categoryId:'Categoría',price:'Precio',stock:'Stock',listingType:'Tipo de publicación',width:'Ancho del paquete',height:'Alto del paquete',length:'Largo del paquete',weight:'Peso del paquete'};status.textContent=`Faltan completar: ${missing.map(x=>labels[x]||x).join(', ')}.`;return;}
  const photos=(groups.get(selectedKey)||[]).filter(isImage).slice(0,10);button.disabled=true;let published=false;status.textContent='Subiendo fotos y creando la publicación…';
  try {
    const images=await Promise.all(photos.map(jpegBase64));
    const response=await fetch('/api/ml/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft,images})});
    const data=await response.json();
    if(data.error){const cause=(data.cause||[]).map(c=>c.message||c.code).filter(Boolean).join(' · ');const partial=data.itemId?`Creada parcialmente: ${data.itemId}`:'';throw new Error([data.error,cause,partial].filter(Boolean).join(' — '));}
    if(!response.ok)throw new Error(`Mercado Libre respondió ${response.status}.`);
    published=true;button.textContent='Publicación creada';status.innerHTML=`Publicación creada: <a href="${esc(data.url||`https://articulo.mercadolibre.com.ar/${data.id}`)}" target="_blank" rel="noopener">${esc(data.id)}</a>${data.warning?`<br>${esc(data.warning)}`:''}`;
  } catch(error){status.textContent=error.message;}
  finally{if(!published)button.disabled=false;}
});
identifyButton.addEventListener('click', async () => {
  const files=(groups.get(selectedKey)||[]).filter(isImage).slice(0,10);
  if(!files.length) return;
  identifyButton.disabled=true;
  const status=document.querySelector('#resultStatus'), sourcesNode=document.querySelector('#sources');
  status.textContent='Preparando fotos…';
  sourcesNode.innerHTML='<div class="progress"><span id="generationProgress"></span></div><p class="footer-note">Las fotos se mandarán a Gemini para analizarlas. Luego se buscará el código o la pieza en la web.</p>';
  try {
    const images=await Promise.all(files.map(jpegBase64));
    status.textContent='Analizando imágenes, leyendo texto y códigos…';
    const response=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json','x-gemini-api-key':apiKeyInput.value.trim()},body:JSON.stringify({images,vehicleRows})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||`Error ${response.status}`);
    const x=data.listing||{};
    setField('title',x.title); setField('description',x.description); setField('partName',x.product_type); setField('partCode',x.part_number);
    document.querySelector('#title').maxLength = Math.min(60, Number(data.titleLimit)||60);
    setField('brand',x.brand); setField('category',x.suggested_category); setField('stock',x.stock_estimate); setField('confidence',x.confidence);
    setField('condition','Usado');
    setField('priceReference',x.price_reference); setField('packageDimensions',x.package_dimensions); setField('packageWeight',x.package_weight); setField('technicalSpecs',x.technical_specs);
    const compatibilityLines=[];
    for(const v of x.vehicle_compatibilities||[]) {
      const rows=v.matched_catalog_rows||[];
      if(rows.length) for(const row of rows) compatibilityLines.push(`${row.id} | ${[row.make,row.model,row.years,row.version,row.engine].filter(Boolean).join(' ')}`);
      else if(v.marketplace_vehicle_ids?.length) for(const id of v.marketplace_vehicle_ids) compatibilityLines.push(`${id} | ${[v.make,v.model,v.years,v.version,v.engine].filter(Boolean).join(' ')}`);
      else compatibilityLines.push(`Sin ID coincidente | ${[v.make,v.model,v.years,v.version,v.engine].filter(Boolean).join(' ')}`);
    }
    setField('compatibilities',[...new Set(compatibilityLines)]);
    setField('notes',[x.match_summary,x.visual_clues,x.missing_or_uncertain].filter(Boolean).join('\n\n'));
    currentCategory=data.category||null;
    generatedForSelectedFolder=true;
    const requiredValues={...(x.required_category_attributes||{})};
    for(const attribute of data.category?.requiredAttributes||[]) if(/^(ITEM_)?CONDITION$/i.test(attribute.id)) requiredValues[attribute.id]='Usado';
    renderRequiredAttributes(data.category,requiredValues);
    status.textContent=`Ficha generada · ${x.confidence||'confianza no informada'} · ${data.sources.length} fuentes`;
    sourcesNode.innerHTML=`${data.searched?.length?`<p class="footer-note">Búsquedas: ${esc(data.searched.join(' · '))}</p>`:''}${data.sources.length?data.sources.map(s=>`<article class="source-item"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title||s.url)}</a><p>${esc(s.snippet||'Sin fragmento de texto')}</p></article>`).join(''):'<p class="footer-note">No aparecieron resultados web para contrastar. La ficha se basa solo en las imágenes y conviene confirmar el código.</p>'}`;
  } catch(error) {
    status.textContent='No se pudo completar la ficha';
    sourcesNode.innerHTML=`<p class="error-box">${esc(error.message)}<br>Revisá que la clave sea válida, haya conexión y no se haya agotado la cuota gratuita.</p>`;
  } finally { updateGenerateButton(); }
});
