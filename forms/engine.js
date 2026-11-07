/* Build & Cover phone forms – shared engine
   Each form page defines window.FORM and calls BC.start(FORM).
   Entries save on the phone as you go (text in localStorage, photos in IndexedDB).
   "Finish & send" checks for gaps, builds a PDF (with photos and signatures) and
   opens the phone's email app to send it to the office. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad=n=>String(n).padStart(2,"0");
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseIso=s=>{if(!s)return null;const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const uk=s=>{const d=parseIso(s);return d?`${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`:""};
const dash=s=>{const d=parseIso(s);return d?`${pad(d.getDate())}-${pad(d.getMonth()+1)}-${String(d.getFullYear()).slice(2)}`:""};
const mondayOf=d=>{const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-((x.getDay()+6)%7));return x};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const daysTo=s=>{const d=parseIso(s);if(!d)return null;const t=new Date();t.setHours(0,0,0,0);return Math.round((d-t)/864e5)};
const DAYS=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const params=new URLSearchParams(location.search);

/* ---------- photo store (IndexedDB) ---------- */
let dbp=null;
function db(){if(dbp)return dbp;dbp=new Promise((res,rej)=>{const r=indexedDB.open("bcforms",1);
  r.onupgradeneeded=()=>r.result.createObjectStore("p");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});return dbp}
async function pPut(id,val){const d=await db();return new Promise((res,rej)=>{const t=d.transaction("p","readwrite");t.objectStore("p").put(val,id);t.oncomplete=res;t.onerror=()=>rej(t.error)})}
async function pGet(id){const d=await db();return new Promise((res)=>{const t=d.transaction("p");const q=t.objectStore("p").get(id);q.onsuccess=()=>res(q.result||null);q.onerror=()=>res(null)})}
async function pDel(id){try{const d=await db();d.transaction("p","readwrite").objectStore("p").delete(id)}catch(e){}}
function shrink(file,max=1100,q=0.62){return new Promise((res,rej)=>{const url=URL.createObjectURL(file);const im=new Image();
  im.onload=()=>{let w=im.naturalWidth,h=im.naturalHeight;const k=Math.min(1,max/Math.max(w,h));w=Math.round(w*k);h=Math.round(h*k);
    const c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(im,0,0,w,h);URL.revokeObjectURL(url);
    res({src:c.toDataURL("image/jpeg",q),w,h})};im.onerror=()=>{URL.revokeObjectURL(url);rej(new Error("Could not read that photo"))};im.src=url})}

/* ---------- state ---------- */
let F,S,KEY,thumbCache={};
function blank(){return {v:{},chk:{},na:{},photos:{},sig:{},eq:{items:[],day:(new Date().getDay()+6)%7},iss:{},meta:{created:new Date().toISOString()}}}
function load(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}
function store(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){return false}}
let saveT=null;
function save(){clearTimeout(saveT);saveT=setTimeout(()=>{const ok=store(KEY,S);
  $("savedTxt").textContent=ok?"Saved on this phone "+new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}):"Phone storage full – send this form now";
  progress()},250)}
const val=id=>(S.v[id]==null?"":String(S.v[id]));

/* ---------- render ---------- */
function fieldHtml(f){
  const v=esc(val(f.id)),req=f.req?" *":"";
  const lab=`${esc(f.label)}${req}`;
  if(f.kind==="select")return `<label class="f">${lab}<select data-f="${f.id}"><option value="">– choose –</option>${f.options.map(o=>{const ov=typeof o==="string"?o:o.v,ol=typeof o==="string"?o:o.l;return `<option value="${esc(ov)}"${val(f.id)===ov?" selected":""}>${esc(ol)}</option>`}).join("")}</select>${f.help?`<span class="note">${esc(f.help)}</span>`:""}</label>`;
  if(f.kind==="textarea")return `<label class="f">${lab}<textarea data-f="${f.id}" placeholder="${esc(f.placeholder||"")}">${v}</textarea>${f.help?`<span class="note">${esc(f.help)}</span>`:""}</label>`;
  if(f.kind==="check")return `<label class="chk"><input type="checkbox" data-f="${f.id}"${val(f.id)==="Yes"?" checked":""}><span>${lab}</span></label>`;
  const type={date:"date",time:"time",number:"number",email:"email"}[f.kind]||"text";
  return `<label class="f">${lab}<input type="${type}" data-f="${f.id}" value="${v}" placeholder="${esc(f.placeholder||"")}"${f.inputmode?` inputmode="${f.inputmode}"`:""}>${f.help?`<span class="note">${esc(f.help)}</span>`:""}<span class="note" id="hint_${f.id}"></span></label>`;
}
function photoTools(key,label){
  return `<div class="tools"><label class="btn small" style="position:relative;overflow:hidden">📷 ${esc(label||"Add photo")}<input type="file" accept="image/*" capture="environment" data-photo="${key}" style="position:absolute;inset:0;opacity:0"></label><div class="thumbs" id="th_${key}"></div></div>`;
}
function checkItemHtml(b,it,i){
  const a=(S.chk[it.id]||{}).a||"",c=(S.chk[it.id]||{}).c||"",d=(S.chk[it.id]||{}).d||"";
  const labels=b.labels||{Y:"Yes",N:"No",NA:"N/A"};
  const opts=(b.answers||["Y","N","NA"]);
  const bad=isBad(it,a);
  return `<div class="item${bad?" no":""}" id="it_${it.id}">
    <div class="q">${esc(it.num||"")}${it.num?" ":""}${esc(it.q)}</div>
    <div class="seg" role="group">${opts.map(o=>`<button type="button" data-ans="${it.id}" data-v="${o}" class="${o==="Y"?"y":o==="N"?"n":"x"}${(it.bad||"N")===o&&o!=="NA"?" n":""}" aria-pressed="${a===o}">${esc(labels[o]||o)}</button>`).join("")}</div>
    ${bad?`<div class="act">${esc(it.no||b.no||"Take action")} – say what was done below</div>`:""}
    <label class="f" ${bad||c?"":"hidden"} id="cw_${it.id}">Comment / action taken<textarea data-c="${it.id}">${esc(c)}</textarea></label>
    ${b.actioned&&bad?`<label class="f">Date actioned<input type="date" data-d="${it.id}" value="${esc(d)}"></label>`:""}
    <div class="tools">${bad||c?"":`<button type="button" class="btn small" data-addc="${it.id}">Add comment</button>`}${photoTools("c_"+it.id,"Photo")}</div>
  </div>`;
}
function isBad(it,a){if(!a||a==="NA")return false;return a===(it.bad||"N")}
function blockHtml(b,n){
  const head=t=>`<h2><span class="n">${n}</span> ${esc(t)}${b.na?`<label class="na"><input type="checkbox" data-na="${b.id}"${S.na[b.id]?" checked":""}> N/A</label>`:""}</h2>`;
  const naOn=b.na&&S.na[b.id];
  switch(b.type){
  case "info":return `<section>${b.title?head(b.title):""}<div class="intro">${b.html}</div></section>`;
  case "fields":return `<section>${head(b.title)}${b.intro?`<p class="note">${esc(b.intro)}</p>`:""}<div class="row">${b.fields.map(fieldHtml).join("")}</div>${b.photos?photoTools("b_"+b.id,b.photos):""}</section>`;
  case "checks":{
    let last=null;const items=b.items.map((it,i)=>{let g="";if(it.group&&it.group!==last){g=`<div class="sub">${esc(it.group)}</div>`;last=it.group}return g+checkItemHtml(b,it,i)}).join("");
    return `<section id="sec_${b.id}">${head(b.title)}${b.intro?`<p class="note">${esc(b.intro)}</p>`:""}
      ${naOn?`<p class="note">Marked not applicable.</p>`:`${b.allYes?`<div class="tools"><button type="button" class="btn small" data-allyes="${b.id}">Mark all unanswered “${esc((b.labels||{}).Y||"Yes")}”</button></div>`:""}${items}`}
      ${naOn?"":`<label class="f">Additional comments, observations or actions<textarea data-f="${b.id}_notes">${esc(val(b.id+"_notes"))}</textarea></label>${photoTools("s_"+b.id,"Photo for this section")}`}</section>`}
  case "text":return `<section>${head(b.title)}${b.intro?`<p class="note">${esc(b.intro)}</p>`:""}<textarea data-f="${b.id}" style="min-height:120px" placeholder="${esc(b.placeholder||"")}">${esc(val(b.id))}</textarea>${photoTools("t_"+b.id,"Add photo")}</section>`;
  case "photos":return `<section>${head(b.title)}<p class="note">${esc(b.intro||"Add as many photos as you need. They go into the PDF.")}</p>${photoTools("g_"+b.id,"Take / add photo")}</section>`;
  case "sigs":return `<section>${head(b.title)}${b.decl?`<p class="intro">${esc(b.decl)}</p>`:""}${b.sigs.map(s=>`<div class="item"><div class="q">${esc(s.label)}</div><div class="row">${fieldHtml({id:s.id+"_name",label:"Name",req:!s.optional})}${s.noPos?"":fieldHtml({id:s.id+"_pos",label:"Position"})}${fieldHtml({id:s.id+"_date",label:"Date",kind:"date"})}</div>
      <div class="sigbox"><canvas data-sig="${s.id}"></canvas><span class="sighint" id="sh_${s.id}">Sign here with your finger</span></div><div><button class="btn small" type="button" data-sigclr="${s.id}">Clear signature</button></div>${s.comments?`<label class="f">${esc(s.comments)}<textarea data-f="${s.id}_comments">${esc(val(s.id+"_comments"))}</textarea></label>`:""}</div>`).join("")}</section>`;
  case "equip":return equipHtml(b,n);
  case "issue":return issueHtml(b,n);
  }
  return "";
}
/* equipment: pick items, tick each condition per day (Mon–Sun) */
function equipHtml(b,n){
  const E=S.eq,d=E.day;
  const ws=parseIso(val(b.weekField))||mondayOf(new Date());
  const dayBtns=DAYS.map((x,i)=>{const done=E.items.length&&E.items.every(it=>b.checks.every(c=>(it.r[c.id]||{})[i]));return `<button type="button" data-day="${i}" class="${i===d?"on":""}${done?" done":""}">${x}<br><span style="font:400 11px var(--body)">${pad(addDays(ws,i).getDate())}/${pad(addDays(ws,i).getMonth()+1)}</span></button>`}).join("");
  const opts=b.catalogue.map(c=>`<option value="${esc(c.id)}">${esc(c.id+" – "+c.desc)}</option>`).join("");
  const items=E.items.map((it,k)=>`<div class="equip"><div class="eh"><span>${esc(it.desc)}<br><span class="note">ID: ${esc(it.eid||"–")}</span></span>${b.fixed?"":`<button type="button" class="btn small" data-eqdel="${k}">Remove</button>`}</div>
     <div class="tools"><button type="button" class="btn small gold" data-eqall="${k}">All OK for ${DAYS[d]}</button></div>
     ${b.checks.map(c=>{const r=(it.r[c.id]||{})[d]||"";return `<div class="item${r==="X"?" no":""}"><div class="q">${esc(c.q)}</div><div class="seg"><button type="button" class="y" data-eq="${k}|${c.id}" data-v="OK" aria-pressed="${r==="OK"}">✓ OK</button><button type="button" class="n" data-eq="${k}|${c.id}" data-v="X" aria-pressed="${r==="X"}">✗ Fault</button><button type="button" class="x" data-eq="${k}|${c.id}" data-v="NA" aria-pressed="${r==="NA"}">N/A</button></div>${r==="X"?`<div class="act">Take it out of use and tell the manager/supervisor straight away. Describe the fault in the comments below.</div>`:""}</div>`}).join("")}
     <label class="f">Initials for ${DAYS[d]}<input type="text" data-eqi="${k}" value="${esc((it.ini||{})[d]||"")}" maxlength="6"></label>
     <label class="f">Comments / faults for this item<textarea data-eqc="${k}">${esc(it.c||"")}</textarea></label>${photoTools("e_"+it.uid,"Photo of fault / item")}</div>`).join("");
  return `<section>${`<h2><span class="n">${n}</span> ${esc(b.title)}</h2>`}${b.intro?`<p class="note">${esc(b.intro)}</p>`:""}
    <div class="days">${dayBtns}</div>
    ${b.fixed?"":`<div class="item"><label class="f">Add equipment from the register<select id="eqpick"><option value="">– pick an item –</option>${opts}</select></label>
      ${b.allowOther?`<div class="row"><label class="f">…or other equipment (description)<input type="text" id="eqOd"></label><label class="f">ID number<input type="text" id="eqOi"></label></div>`:""}
      <button type="button" class="btn small primary" id="eqAdd">Add to this week’s sheet</button></div>`}
    ${items||`<p class="note">No equipment added yet.</p>`}</section>`;
}
/* issue table (PPE issue) */
function issueHtml(b,n){
  const rows=b.rows.map((r,i)=>{const x=S.iss[i]||{};return `<tr><td style="width:36px"><input type="checkbox" data-iss="${i}|on" ${x.on?"checked":""} style="width:24px;height:24px;accent-color:var(--navy)"></td><td>${r.other?`<input type="text" data-iss="${i}|name" value="${esc(x.name||"")}" placeholder="Other PPE (state)">`:`<b>${esc(r.l)}</b>${r.note?`<div class="note">${esc(r.note)}</div>`:""}`}
    ${x.on?`<div class="row" style="margin-top:6px"><label class="f">Qty / size / make & model<input type="text" data-iss="${i}|q" value="${esc(x.q||"")}"></label><label class="f">Date issued<input type="date" data-iss="${i}|d" value="${esc(x.d||"")}"></label><label class="f">New or replacement<select data-iss="${i}|t"><option${x.t==="New"?" selected":""}>New</option><option${x.t==="Replacement"?" selected":""}>Replacement</option></select></label>${x.t==="Replacement"?`<label class="f">Reason for replacement<input type="text" data-iss="${i}|why" value="${esc(x.why||"")}"></label>`:""}${r.trace?`<label class="f">Unique ID / serial no.<input type="text" data-iss="${i}|id" value="${esc(x.id||"")}"></label><label class="f">Inspection / face-fit record ref<input type="text" data-iss="${i}|ref" value="${esc(x.ref||"")}"></label><label class="f">Next inspection / filter change due<input type="date" data-iss="${i}|due" value="${esc(x.due||"")}"></label>`:""}</div>`:""}</td></tr>`}).join("");
  return `<section><h2><span class="n">${n}</span> ${esc(b.title)}</h2>${b.intro?`<p class="note">${esc(b.intro)}</p>`:""}<table class="iss">${rows}</table></section>`;
}
function render(){
  let n=0;
  $("main").innerHTML=`<div id="bnr" style="display:grid;gap:12px">${F.banner?F.banner(S):""}</div>`+F.blocks.map(b=>{if(b.type!=="info")n++;return blockHtml(b,b.type==="info"?"":n)}).join("")+
    `<div class="foot">${esc(F.title)} · ${esc(F.ref)} ${esc(F.ver)} · Build &amp; Cover Ltd<br>Entries stay on this phone until you send them.</div>`;
  document.querySelectorAll("[data-photo]").forEach(i=>showThumbs(i.dataset.photo));
  document.querySelectorAll("canvas[data-sig]").forEach(setupSig);
  if(F.after)F.after(S,api);
  progress();
}
async function showThumbs(key){
  const box=$("th_"+key);if(!box)return;const ids=S.photos[key]||[];
  const html=[];for(const id of ids){let src=thumbCache[id];if(!src){const p=await pGet(id);src=p?p.src:"";thumbCache[id]=src}
    if(src)html.push(`<figure><img src="${src}" alt="photo"><button type="button" data-pdel="${key}|${id}" aria-label="Remove photo">×</button></figure>`)}
  box.innerHTML=html.join("");
}

/* ---------- signatures ---------- */
function setupSig(cv){
  const id=cv.dataset.sig,ctx=cv.getContext("2d");let drawing=false,last=null;
  function size(){const r=cv.getBoundingClientRect(),dpr=window.devicePixelRatio||1;cv.width=Math.round(r.width*dpr);cv.height=Math.round(r.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);draw()}
  function draw(){ctx.clearRect(0,0,cv.width,cv.height);$("sh_"+id).hidden=!!S.sig[id];if(S.sig[id]){const im=new Image();im.onload=()=>{const r=cv.getBoundingClientRect();ctx.drawImage(im,0,0,r.width,r.height)};im.src=S.sig[id]}}
  const pt=e=>{const r=cv.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top}};
  cv.addEventListener("pointerdown",e=>{drawing=true;last=pt(e);cv.setPointerCapture(e.pointerId);$("sh_"+id).hidden=true});
  cv.addEventListener("pointermove",e=>{if(!drawing)return;const p=pt(e);ctx.strokeStyle="#0b1630";ctx.lineWidth=2.4;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p});
  const end=()=>{if(!drawing)return;drawing=false;S.sig[id]=cv.toDataURL("image/png");
    if(!val(id+"_date")){S.v[id+"_date"]=iso(new Date());const dt=document.querySelector(`[data-f="${id}_date"]`);if(dt)dt.value=S.v[id+"_date"]}save()};
  cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
  requestAnimationFrame(size);
}

/* ---------- events ---------- */
function onInput(e){
  const t=e.target;
  if(t.dataset.f){S.v[t.dataset.f]=t.type==="checkbox"?(t.checked?"Yes":""):t.value;save();if(F.onField){F.onField(t.dataset.f,S,api)}return}
  if(t.dataset.c){(S.chk[t.dataset.c]=S.chk[t.dataset.c]||{}).c=t.value;save();return}
  if(t.dataset.d){(S.chk[t.dataset.d]=S.chk[t.dataset.d]||{}).d=t.value;save();return}
  if(t.dataset.eqc!=null){S.eq.items[+t.dataset.eqc].c=t.value;save();return}
  if(t.dataset.eqi!=null){const it=S.eq.items[+t.dataset.eqi];(it.ini=it.ini||{})[S.eq.day]=t.value;save();return}
  if(t.dataset.iss){const [i,k]=t.dataset.iss.split("|");const x=(S.iss[i]=S.iss[i]||{});
    if(k==="on"){x.on=t.checked;if(t.checked&&!x.d){x.d=iso(new Date());x.t="New"}save();render();return}
    x[k]=t.value;save();if(k==="t")render();return}
}
document.addEventListener("input",onInput);
document.addEventListener("change",async e=>{
  const t=e.target;
  if(t.dataset.na){S.na[t.dataset.na]=t.checked;save();render();return}
  if(t.dataset.f&&t.tagName==="SELECT"){render();return}
  if(t.dataset.photo&&t.files&&t.files.length){
    const key=t.dataset.photo;const files=[...t.files];t.value="";
    for(const f of files){try{const p=await shrink(f);const id=uid();await pPut(id,p);thumbCache[id]=p.src;(S.photos[key]=S.photos[key]||[]).push(id)}catch(err){alert("That photo could not be added: "+err.message)}}
    save();showThumbs(key);return}
});
document.addEventListener("click",e=>{
  const t=e.target.closest("button,[data-close]");if(!t)return;
  if(t.hasAttribute("data-close")){hidePanel();return}
  const d=t.dataset;
  if(d.ans){const x=(S.chk[d.ans]=S.chk[d.ans]||{});x.a=x.a===d.v?"":d.v;save();rerenderItem(d.ans);return}
  if(d.addc){$("cw_"+d.addc).hidden=false;t.remove();return}
  if(d.allyes){const b=F.blocks.find(x=>x.id===d.allyes);b.items.forEach(it=>{const x=(S.chk[it.id]=S.chk[it.id]||{});if(!x.a)x.a=it.bad==="Y"?"N":"Y"});save();render();return}
  if(d.pdel){const [key,id]=d.pdel.split("|");S.photos[key]=(S.photos[key]||[]).filter(x=>x!==id);pDel(id);save();showThumbs(key);return}
  if(d.sigclr){delete S.sig[d.sigclr];save();render();return}
  if(d.day!=null){S.eq.day=+d.day;save();render();return}
  if(d.eq){const [k,c]=d.eq.split("|");const it=S.eq.items[+k];const r=(it.r[c]=it.r[c]||{});r[S.eq.day]=r[S.eq.day]===d.v?"":d.v;save();render();return}
  if(d.eqall!=null){const b=F.blocks.find(x=>x.type==="equip");const it=S.eq.items[+d.eqall];b.checks.forEach(c=>{const r=(it.r[c.id]=it.r[c.id]||{});if(!r[S.eq.day])r[S.eq.day]="OK"});save();render();return}
  if(d.eqdel!=null){if(confirm("Remove this item from the sheet?")){S.eq.items.splice(+d.eqdel,1);save();render()}return}
  if(t.id==="eqAdd"){const b=F.blocks.find(x=>x.type==="equip");const pick=$("eqpick").value;let desc,eid;
    if(pick){const c=b.catalogue.find(x=>x.id===pick);desc=c.desc;eid=c.id}else if($("eqOd")&&$("eqOd").value.trim()){desc=$("eqOd").value.trim();eid=($("eqOi").value||"").trim()}
    if(!desc){alert("Pick an item from the list, or type the description of other equipment.");return}
    S.eq.items.push({uid:uid(),desc,eid,r:{},ini:{},c:""});save();render();return}
  if(t.id==="sendFinal"){send(false);return}
  if(t.id==="sendPart"){send(true);return}
});
function rerenderItem(id){
  for(const b of F.blocks){if(b.type!=="checks")continue;const it=b.items.find(x=>x.id===id);if(!it)continue;
    const el=$("it_"+id);if(!el)return;const g=document.createElement("div");g.innerHTML=checkItemHtml(b,it);el.replaceWith(g.firstElementChild);showThumbs("c_"+id);progress();return}
}

/* ---------- progress & validation ---------- */
function countChecks(){let tot=0,done=0;for(const b of F.blocks){if(b.type!=="checks"||(b.na&&S.na[b.id]))continue;for(const it of b.items){tot++;if((S.chk[it.id]||{}).a)done++}}return {tot,done}}
function progress(){const p=$("prog");if(!p)return;const c=countChecks();p.innerHTML=c.tot?`<span>${c.done} of ${c.tot} checks answered</span><span>${F.ref}</span>`:`<span>${esc(F.title)}</span><span>${F.ref}</span>`}
function problems(partial){
  const p=[];let n=0;
  for(const b of F.blocks){if(b.type!=="info")n++;
    if(b.type==="fields")b.fields.forEach(f=>{if(f.req&&!val(f.id).trim())p.push(`Section ${n}: fill in “${f.label}”.`)});
    if(partial)continue;
    if(b.type==="checks"&&!(b.na&&S.na[b.id])){let miss=0;b.items.forEach(it=>{const x=S.chk[it.id]||{};if(!x.a)miss++;else if(isBad(it,x.a)&&!(x.c||"").trim())p.push(`Section ${n}: say what was done about “${it.q}”.`)});if(miss)p.push(`Section ${n} (${b.title}): ${miss} check${miss>1?"s":""} not answered${b.na?" – or tick N/A for the whole section":""}.`)}
    if(b.type==="sigs")b.sigs.forEach(s=>{if(!s.optional){if(!S.sig[s.id])p.push(`Section ${n}: ${s.label} – sign in the box.`);if(!val(s.id+"_name").trim())p.push(`Section ${n}: ${s.label} – enter the name.`)}});
    if(b.type==="equip"){if(!S.eq.items.length)p.push(`Section ${n}: add at least one item of equipment.`);S.eq.items.forEach(it=>{const anyX=b.checks.some(c=>Object.values(it.r[c.id]||{}).includes("X"));if(anyX&&!(it.c||"").trim())p.push(`Section ${n}: ${it.desc} – describe the fault and action in its comments.`)})}
    if(b.type==="issue"){const on=Object.values(S.iss).filter(x=>x&&x.on);if(!on.length)p.push(`Section ${n}: tick at least one item issued.`)}
  }
  if(F.validate)F.validate(S,p,partial);
  return p;
}

/* ---------- PDF ---------- */
async function buildPdf(partial){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:"mm",format:"a4"});
  const NAVY=[20,35,63],GOLD=[184,146,58],RED=[179,38,30],GREEN=[31,122,77],W=210,M=14;
  let y=0;
  const space=h=>{if(y+h>282){doc.addPage();y=16}};
  const heading=t=>{space(14);doc.setFont("helvetica","bold");doc.setFontSize(11);doc.setTextColor(...NAVY);doc.text(t,M,y);doc.setDrawColor(...GOLD);doc.setLineWidth(0.5);doc.line(M,y+1.5,W-M,y+1.5);y+=6;doc.setTextColor(20,20,20)};
  const para=(t,size=8.5,style="normal")=>{doc.setFont("helvetica",style);doc.setFontSize(size);const lines=doc.splitTextToSize(String(t),W-2*M);space(lines.length*size*0.42+2);doc.text(lines,M,y);y+=lines.length*size*0.42+2};
  const tbl={theme:"grid",styles:{fontSize:8.3,cellPadding:1.6,lineColor:[200,204,214],textColor:[20,20,20],overflow:"linebreak"},headStyles:{fillColor:NAVY,textColor:255,fontStyle:"bold"},margin:{left:M,right:M,top:16}};
  const after=()=>{y=doc.lastAutoTable.finalY+5};
  const photoList=[];const pref=(key,cap)=>{const ids=S.photos[key]||[];if(!ids.length)return "";const nums=ids.map(id=>{photoList.push({id,cap});return photoList.length});return " [Photo "+nums.join(", ")+"]"};

  doc.setFillColor(...NAVY);doc.rect(0,0,W,22,"F");doc.setFillColor(...GOLD);doc.rect(0,22,W,1.2,"F");
  doc.setTextColor(255);doc.setFont("helvetica","bold");doc.setFontSize(14);doc.text(F.title.toUpperCase(),M,11);
  doc.setFont("helvetica","normal");doc.setFontSize(9);doc.text("Build & Cover Ltd | Document Reference: "+F.ref+(F.refNote?" ("+F.refNote+")":""),M,17);
  y=28;
  doc.autoTable({...tbl,startY:y,head:[["Reference","Version","Issue Date","Review Date","Approved By","Status"]],body:[[F.ref,F.ver,F.issue||"",F.review||"",F.by||"G. Alcock, Director",F.status||"Draft – online form"]]});after();
  if(F.pdfIntro)para(F.pdfIntro,8);
  if(partial){doc.setTextColor(...RED);para("PART-COMPLETED COPY sent "+new Date().toLocaleString("en-GB",{dateStyle:"short",timeStyle:"short"})+" – a back-up of the entries so far, not the final signed record.",9,"bold");doc.setTextColor(20,20,20)}
  if(F.pdfKey)para(F.pdfKey,7.5,"italic");
  let n=0;
  for(const b of F.blocks){
    if(b.type==="info"){if(b.pdf)para(b.pdf,8);continue}
    n++;
    const title=`${n}. ${b.title}`;
    if(b.type==="fields"){heading(title);
      doc.autoTable({...tbl,startY:y,columnStyles:{0:{fontStyle:"bold",cellWidth:62,fillColor:[243,244,247]}},body:b.fields.map(f=>[f.label,(f.kind==="date"?uk(val(f.id)):(f.kind==="check"?(val(f.id)||"No"):val(f.id)))+(F.fieldNote?F.fieldNote(f.id,S):"")])});after();
      if(b.photos){const r=pref("b_"+b.id,b.title);if(r)para("Photographs:"+r,8)}
      continue}
    if(b.type==="checks"){heading(title+(b.na&&S.na[b.id]?" – NOT APPLICABLE":""));
      if(b.na&&S.na[b.id])continue;
      if(b.pdfIntro||b.intro)para(b.pdfIntro||b.intro,7.5,"italic");
      const labels=b.labels||{Y:"Yes",N:"No",NA:"N/A"};
      const head=b.actioned?[["No.","Check","Answer","Comment / action taken","Date actioned"]]:[["No.","Check","Answer","Comment / action taken"]];
      const body=b.items.map((it,i)=>{const x=S.chk[it.id]||{};const ans=x.a?labels[x.a]||x.a:"–";const bad=isBad(it,x.a);
        const cm=(x.c||"")+(bad&&!x.c?"":"")+pref("c_"+it.id,`${it.num||i+1} ${it.q}`);
        const row=[it.num||String(i+1),(it.group?it.group+": ":"")+it.q,ans,cm.trim()+(bad?`  (${it.no||b.no||"Take action"})`:"")];
        if(b.actioned)row.push(uk(x.d||""));return row});
      doc.autoTable({...tbl,startY:y,head,body,columnStyles:{0:{cellWidth:11},2:{cellWidth:16,fontStyle:"bold"},...(b.actioned?{4:{cellWidth:20}}:{})},
        didParseCell:c=>{if(c.section==="body"&&c.column.index===2){const it=b.items[c.row.index];const x=S.chk[it.id]||{};if(isBad(it,x.a))c.cell.styles.textColor=RED;else if(x.a&&x.a!=="NA")c.cell.styles.textColor=GREEN}}});after();
      const nt=val(b.id+"_notes"),sp=pref("s_"+b.id,b.title);if(nt||sp)para("Additional comments: "+nt+sp,8);
      continue}
    if(b.type==="text"){heading(title);para(val(b.id)||"(none)",8.5);const r=pref("t_"+b.id,b.title);if(r)para("Photographs:"+r,8);continue}
    if(b.type==="photos"){heading(title);const r=pref("g_"+b.id,b.title);para(r?"See"+r:"No photographs added.",8.5);continue}
    if(b.type==="equip"){heading(title);
      const ws=parseIso(val(b.weekField))||mondayOf(new Date());
      if(!S.eq.items.length)para("No equipment recorded.",8.5);
      for(const it of S.eq.items){space(20);para(`${it.desc} – Equipment ID: ${it.eid||"–"}`,9,"bold");
        const head=[["Condition of –",...DAYS.map((d,i)=>d+" "+pad(addDays(ws,i).getDate())),"Notes"]];
        const sym={OK:"✓",X:"✗",NA:"n/a"};
        const body=b.checks.map(c=>[c.q,...DAYS.map((d,i)=>{const v=(it.r[c.id]||{})[i];return v==="OK"?"OK":v==="X"?"FAULT":v==="NA"?"n/a":""}),""]);
        body.push(["Checked by (initials)",...DAYS.map((d,i)=>(it.ini||{})[i]||""),""]);
        doc.autoTable({...tbl,startY:y,head,body,styles:{...tbl.styles,fontSize:7.2,cellPadding:1.1},columnStyles:{0:{cellWidth:62},8:{cellWidth:12}},
          didParseCell:c=>{if(c.section==="body"&&c.column.index>0&&c.column.index<8){if(c.cell.raw==="FAULT"){c.cell.styles.textColor=RED;c.cell.styles.fontStyle="bold"}else if(c.cell.raw==="OK")c.cell.styles.textColor=GREEN}}});after();
        const r=pref("e_"+it.uid,it.desc);if(it.c||r)para("Operator comments: "+(it.c||"")+r,8)}
      continue}
    if(b.type==="issue"){heading(title);
      const body=b.rows.map((r,i)=>{const x=S.iss[i]||{};if(!x.on)return null;return [r.other?(x.name||"Other PPE"):r.l,x.q||"",uk(x.d||""),(x.t||"New")+(x.t==="Replacement"&&x.why?" – "+x.why:""),r.trace?[x.id&&("ID "+x.id),x.ref&&("Rec. "+x.ref),x.due&&("Due "+uk(x.due))].filter(Boolean).join("; "):""]}).filter(Boolean);
      doc.autoTable({...tbl,startY:y,head:[["Item issued","Qty / size / make & model","Date issued","New / replacement (reason)","Traceable item details"]],body:body.length?body:[["None ticked","","","",""]]});after();continue}
    if(b.type==="sigs"){heading(title);if(b.decl)para(b.decl,8);space(30);
      doc.autoTable({...tbl,startY:y,head:[["","Name","Position","Signature","Date"]],body:b.sigs.map(s=>[s.label,val(s.id+"_name"),val(s.id+"_pos"),"",uk(val(s.id+"_date"))]),
        columnStyles:{0:{cellWidth:38,fontStyle:"bold"},3:{cellWidth:52}},bodyStyles:{minCellHeight:16},
        didDrawCell:c=>{if(c.section==="body"&&c.column.index===3){const s=b.sigs[c.row.index];if(S.sig[s.id]){try{doc.addImage(S.sig[s.id],"PNG",c.cell.x+1,c.cell.y+1,c.cell.width-2,c.cell.height-2)}catch(e){}}}}});after();
      b.sigs.forEach(s=>{if(s.comments&&val(s.id+"_comments"))para(s.comments+": "+val(s.id+"_comments"),8.5)});continue}
  }
  if(F.pdfEnd)para(F.pdfEnd,7.5);
  /* photo appendix */
  if(photoList.length){doc.addPage();y=16;heading("Photographs");
    const colW=(W-2*M-6)/2;let col=0,rowH=0;
    for(let i=0;i<photoList.length;i++){const p=await pGet(photoList[i].id);if(!p)continue;
      const h=Math.min(colW*p.h/p.w,95),w=h*p.w/p.h;
      if(col===0){space(h+10);rowH=0}
      const x=M+col*(colW+6);
      try{doc.addImage(p.src,"JPEG",x,y,w,h)}catch(e){}
      doc.setFontSize(7.5);doc.setFont("helvetica","normal");doc.text(doc.splitTextToSize(`Photo ${i+1}: ${photoList[i].cap}`,colW),x,y+h+3.5);
      rowH=Math.max(rowH,h+9);
      if(col===1){y+=rowH;col=0}else col=1}
  }
  const pages=doc.getNumberOfPages();
  for(let p=1;p<=pages;p++){doc.setPage(p);doc.setFontSize(7.5);doc.setTextColor(110);doc.setFont("helvetica","normal");
    doc.text(`${F.title} • ${F.ref} ${F.ver} • Build & Cover Ltd • completed on the B&C phone form`,M,291);doc.text(`Page ${p} of ${pages}`,W-M,291,{align:"right"})}
  return doc;
}

/* ---------- send ---------- */
function showPanel(html){$("sheet").innerHTML=html;$("panel").hidden=false}
function hidePanel(){$("panel").hidden=true}
function fileName(partial){
  const parts=[F.ref,F.short||F.title,F.nameSuffix?F.nameSuffix(S):"",dash(val(F.dateField))||dash(iso(new Date()))].filter(Boolean);
  return (parts.join(" ")+(partial?" (part)":"")).replace(/[\\/:*?"<>|]/g,"").replace(/\s+/g," ").trim()+".pdf";
}
async function send(partial){
  const p=problems(partial);
  if(p.length){showPanel(`<h3>Nearly there</h3><p class="note">Please sort these out first:</p><ol>${p.slice(0,25).map(x=>`<li>${esc(x)}</li>`).join("")}</ol>${p.length>25?`<p class="note">…and ${p.length-25} more.</p>`:""}<button class="btn primary" type="button" data-close>OK</button>`);return}
  if(!window.jspdf){showPanel(`<h3>No signal</h3><p>The PDF maker needs a data connection. Your entries are saved. Try again when you have signal.</p><button class="btn primary" type="button" data-close>OK</button>`);return}
  showPanel(`<h3>Making the PDF…</h3><p class="note">This can take a few seconds with photos.</p>`);
  let doc;try{doc=await buildPdf(partial)}catch(err){showPanel(`<h3>Something went wrong</h3><p>${esc(err.message)}</p><p class="note">Your entries are saved. Send a screenshot of this to Graham.</p><button class="btn primary" type="button" data-close>OK</button>`);return}
  const SEND_TO=F.sendTo||"graham@buildandcover.co.uk";
  try{navigator.clipboard&&await navigator.clipboard.writeText(SEND_TO)}catch(e){}
  const name=fileName(partial),blob=doc.output("blob"),file=new File([blob],name,{type:"application/pdf"});
  const subject="B&C FORM – "+name.replace(/\.pdf$/,"");
  const text=`${subject}. Please send to ${SEND_TO}`;
  const mb=(blob.size/1048576).toFixed(1);
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    showPanel(`<h3>Send it</h3><ol><li>Tap <b>Share PDF</b> and choose your email app (Outlook, Gmail…).</li><li>In the <b>To</b> box, paste or type:</li></ol><div class="addr">${SEND_TO}</div><p class="note">PDF size ${mb} MB. The address has been copied – press and hold in the To box and choose Paste.</p><button class="btn primary" type="button" id="doShare">Share PDF</button><button class="btn" type="button" data-close>Cancel</button>`);
    $("doShare").onclick=async()=>{try{await navigator.share({files:[file],title:subject,text});afterSend(partial)}catch(e){if(e.name!=="AbortError")fallback()}};
  } else fallback();
  function fallback(){
    doc.save(name);
    const mail=`mailto:${SEND_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent("Form attached.\n\n"+text)}`;
    showPanel(`<h3>PDF saved</h3><p>The PDF is in your <b>Downloads</b> as:<br><b>${esc(name)}</b> (${mb} MB)</p><ol><li>Tap <b>Open email</b>.</li><li>Attach the PDF from Downloads (paperclip).</li><li>Press Send.</li></ol><div class="addr">${SEND_TO}</div><a class="btn primary" href="${mail}">Open email</a><button class="btn" type="button" id="didSend">I've sent it</button><button class="btn" type="button" data-close>Not now</button>`);
    $("didSend").onclick=()=>afterSend(partial);
  }
}
function afterSend(partial){
  if(partial){showPanel(`<h3>Done</h3><p>Back-up copy sent. Carry on filling in the form as normal.</p><button class="btn primary" type="button" data-close>OK</button>`);return}
  showPanel(`<h3>Sent</h3><p>Did the email go? If so, clear the form ready for next time. A copy of the PDF is in your email Sent folder.</p><button class="btn gold" type="button" id="newOne">Yes – clear for next time</button><button class="btn" type="button" data-close>Not yet</button>`);
  $("newOne").onclick=()=>{const old=S;const keep={};(F.keep||[]).forEach(k=>{if(old.v[k]!=null)keep[k]=old.v[k]});
    Object.values(old.photos).flat().forEach(pDel);
    S=blank();S.v=keep;if(F.onNew)F.onNew(S,old);store(KEY,S);hidePanel();render();window.scrollTo(0,0)};
}

/* ---------- start ---------- */
function refreshBanner(){const b=$("bnr");if(b&&F.banner)b.innerHTML=F.banner(S);if(F.after)F.after(S,api)}
const api={render,refreshBanner,save,val,set:(k,v)=>{S.v[k]=v},state:()=>S,uk,iso,daysTo,parseIso,mondayOf,esc,params};
window.BC={api,start(form){
  F=form;
  const suffix=F.keyParam?(params.get(F.keyParam)||""):"";
  KEY="bcform_"+F.key+(suffix?"_"+suffix:"");
  S=load(KEY)||blank();
  S.v=S.v||{};S.chk=S.chk||{};S.na=S.na||{};S.photos=S.photos||{};S.sig=S.sig||{};S.eq=S.eq||{items:[],day:0};S.iss=S.iss||{};
  if(F.init)F.init(S,api);
  document.title="B&C "+(F.short||F.title);
  document.body.insertAdjacentHTML("afterbegin",`<header><div class="hwrap"><div class="co"><a href="index.html">Build &amp; Cover Ltd · all forms</a></div><h1>${esc(F.title)}</h1><div class="ref">${esc(F.ref)} ${esc(F.ver)} · ${esc(F.tag||"")}</div><div class="saved"><span class="dot"></span><span id="savedTxt">Saves automatically on this phone</span></div></div></header><main id="main"></main>
   <div class="bar"><div class="barin"><div class="prog" id="prog"></div><div class="btns"><button class="btn" type="button" id="sendPart">Send copy so far</button><button class="btn primary" type="button" id="sendFinal">Finish &amp; send</button></div></div></div>
   <div class="panel" id="panel" hidden><div class="sheet" id="sheet"></div></div>`);
  $("panel").addEventListener("click",e=>{if(e.target.id==="panel")hidePanel()});
  window.addEventListener("resize",()=>{clearTimeout(window._rz);window._rz=setTimeout(()=>document.querySelectorAll("canvas[data-sig]").forEach(c=>{const r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.round(r.width*dpr);c.height=Math.round(r.height*dpr);const x=c.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);const s=S.sig[c.dataset.sig];if(s){const im=new Image();im.onload=()=>x.drawImage(im,0,0,r.width,r.height);im.src=s}}),200)});
  render();
}};
})();
