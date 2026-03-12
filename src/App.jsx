import { useState, useEffect, useRef, useMemo } from "react";

// ─── SUPABASE CONFIG ─────────────────────────────────────────────────────────
// 1. Create a project at https://supabase.com
// 2. Run this SQL in the Supabase SQL editor:
//    create table library_items (
//      id text primary key, title text, url text, type text,
//      tags text[], notes text, description text, image text,
//      read boolean default false, collection text,
//      saved timestamptz default now()
//    );
//    alter table library_items enable row level security;
//    create policy "public access" on library_items for all using (true);
// 3. Fill in your project URL and anon key below:
const SUPABASE_URL = "";   // e.g. https://abcxyz.supabase.co
const SUPABASE_KEY = "";   // your anon/public key

const sb = SUPABASE_URL && SUPABASE_KEY ? {
  h: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
  async all() {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/library_items?select=*&order=saved.desc`, { headers: this.h });
    return r.ok ? r.json() : null;
  },
  async add(item) {
    await fetch(`${SUPABASE_URL}/rest/v1/library_items`, { method: "POST", headers: { ...this.h, Prefer: "return=minimal" }, body: JSON.stringify(item) });
  },
  async patch(id, data) {
    await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${id}`, { method: "PATCH", headers: this.h, body: JSON.stringify(data) });
  },
  async del(id) {
    await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${id}`, { method: "DELETE", headers: this.h });
  },
} : null;

// ─── LOCAL FALLBACK STORAGE ──────────────────────────────────────────────────
const local = {
  async load() {
    try { const r = await window.storage?.get("kl-v4"); if (r) return JSON.parse(r.value); } catch {}
    try { const s = localStorage.getItem("kl-v4"); if (s) return JSON.parse(s); } catch {}
    return null;
  },
  async save(items) {
    try { await window.storage?.set("kl-v4", JSON.stringify(items)); } catch {}
    try { localStorage.setItem("kl-v4", JSON.stringify(items)); } catch {}
  },
};

// ─── TYPES ───────────────────────────────────────────────────────────────────
const TYPES = [
  { id: "article", label: "Article",          icon: "✦", color: "#E8B86D" },
  { id: "paper",   label: "Academic Paper",   icon: "◈", color: "#7EB8C9" },
  { id: "podcast", label: "Podcast",          icon: "◉", color: "#B889C9" },
  { id: "tweet",   label: "Tweet",            icon: "◇", color: "#6EC98F" },
  { id: "video",   label: "Conference Video", icon: "▶", color: "#E87E7E" },
];
const TYPE_MAP = Object.fromEntries(TYPES.map(t => [t.id, t]));

const SAMPLE = [
  { id:"s1", title:"Attention Is All You Need", url:"https://arxiv.org/abs/1706.03762",
    type:"paper", tags:["transformers","NLP","deep learning"], notes:"Foundational transformer paper.",
    read:false, saved:"2024-11-12T10:00:00Z", collection:"AI Research",
    image:"https://www.google.com/s2/favicons?domain=arxiv.org&sz=128",
    description:"The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." },
  { id:"s2", title:"The Knowledge Project – Shane Parrish", url:"https://fs.blog/knowledge-project-podcast/",
    type:"podcast", tags:["mental models","decision making"], notes:"",
    read:true, saved:"2024-12-01T14:30:00Z", collection:"Podcasts",
    image:"https://www.google.com/s2/favicons?domain=fs.blog&sz=128",
    description:"Shane Parrish explores mental models and decision-making frameworks." },
  { id:"s3", title:"How LLMs Will Reshape Scientific Discovery", url:"https://paradigm.xyz/writing",
    type:"article", tags:["AI","science","research"], notes:"Great perspective on AI-assisted research.",
    read:false, saved:"2025-01-08T09:15:00Z", collection:"AI Research",
    image:"https://www.google.com/s2/favicons?domain=paradigm.xyz&sz=128",
    description:"Exploring how large language models are transforming research and knowledge discovery." },
];

// ─── IMAGE FETCHING (fast: OG + favicon only, no screenshot) ─────────────────
function getFavicon(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=128`; } catch { return null; }
}
async function fetchMeta(url) {
  const favicon = getFavicon(url);
  try {
    const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}&meta=true`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error();
    const json = await res.json();
    if (json.status === "success") {
      return {
        title: json.data?.title || "",
        description: json.data?.description || "",
        image: json.data?.image?.url || json.data?.logo?.url || favicon,
      };
    }
  } catch {}
  return { title: "", description: "", image: favicon };
}

// ─── FUZZY SEARCH ────────────────────────────────────────────────────────────
function scoreText(text, q) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 70;
  if (t.split(/\s+/).some(w => w.startsWith(q))) return 55;
  // character subsequence
  let i = 0;
  for (const c of t) { if (c === q[i]) i++; if (i === q.length) return q.length > 2 ? 25 : 0; }
  return 0;
}
function fuzzySearch(items, query) {
  if (!query.trim()) return items;
  const q = query.toLowerCase().trim();
  return items
    .map(item => ({ item, score: Math.max(
      scoreText(item.title, q) * 3,
      scoreText(item.description, q),
      scoreText(item.notes, q),
      scoreText((item.tags || []).join(" "), q) * 2,
      scoreText(item.collection, q) * 1.5,
    )}))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmtDate = iso => new Date(iso).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });

// ─── TAG PILL ────────────────────────────────────────────────────────────────
function TagPill({ tag, active, onClick }) {
  return (
    <span onClick={onClick} style={{
      display:"inline-flex", alignItems:"center",
      background: active ? "rgba(232,184,109,0.15)" : "rgba(255,255,255,0.07)",
      border: `1px solid ${active ? "rgba(232,184,109,0.5)" : "rgba(255,255,255,0.12)"}`,
      borderRadius:4, padding:"2px 8px", fontSize:11,
      color: active ? "#E8B86D" : "#ccc",
      fontFamily:"'DM Mono',monospace", letterSpacing:"0.03em",
      cursor: onClick ? "pointer" : "default",
      transition:"all 0.15s",
    }}>{tag}</span>
  );
}

// ─── CARD ────────────────────────────────────────────────────────────────────
function Card({ item, onToggleRead, onDelete, activeTag, onTagClick }) {
  const [expanded, setExpanded] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const t = TYPE_MAP[item.type] || TYPES[0];
  const isFavicon = item.image?.includes("favicons");

  return (
    <div style={{
      background: expanded ? "rgba(255,255,255,0.055)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${expanded ? "rgba(255,255,255,0.13)" : "rgba(255,255,255,0.07)"}`,
      borderLeft: `3px solid ${t.color}`, borderRadius:10, overflow:"hidden",
      transition:"all 0.2s ease", opacity: item.read ? 0.58 : 1,
    }}>
      <div style={{display:"flex"}}>
        {/* Thumbnail */}
        {item.image && !imgErr ? (
          <div style={{
            width:90, minHeight:88, flexShrink:0, background: isFavicon ? `${t.color}12` : "#1a1814",
            position:"relative", overflow:"hidden",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            {isFavicon ? (
              <>
                <div style={{position:"absolute",inset:0,background:`linear-gradient(135deg,${t.color}18,rgba(0,0,0,0.55))`}} />
                <img src={item.image} alt="" onError={()=>setImgErr(true)}
                  style={{width:36,height:36,objectFit:"contain",borderRadius:8,position:"relative",zIndex:1}} />
              </>
            ) : (
              <>
                <img src={item.image} alt="" onError={()=>setImgErr(true)}
                  style={{width:"100%",height:"100%",objectFit:"cover",position:"absolute",inset:0}} />
                <div style={{position:"absolute",inset:0,background:"linear-gradient(to right,transparent 50%,rgba(16,15,13,0.55))"}} />
              </>
            )}
          </div>
        ) : (
          <div style={{width:64,minHeight:88,flexShrink:0,background:`${t.color}10`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:`${t.color}55`}}>
            {t.icon}
          </div>
        )}

        {/* Body */}
        <div style={{flex:1,minWidth:0,padding:"12px 14px"}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:3}}>
                <span style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:t.color,letterSpacing:"0.12em",textTransform:"uppercase"}}>
                  {t.icon} {t.label}
                </span>
                <span style={{color:"rgba(255,255,255,0.15)",fontSize:10}}>·</span>
                <span style={{fontSize:10,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace"}}>{fmtDate(item.saved)}</span>
                {item.collection && (
                  <>
                    <span style={{color:"rgba(255,255,255,0.15)",fontSize:10}}>·</span>
                    <span style={{fontSize:10,color:"rgba(255,255,255,0.35)",fontFamily:"'DM Mono',monospace"}}>📁 {item.collection}</span>
                  </>
                )}
                {item.read && <span style={{fontSize:9,letterSpacing:"0.1em",color:"#6EC98F",fontFamily:"'DM Mono',monospace",textTransform:"uppercase"}}>✓ read</span>}
              </div>
              <h3 onClick={()=>setExpanded(!expanded)} style={{
                margin:"0 0 4px",fontSize:14,fontWeight:600,color:"#f0ece4",
                fontFamily:"'Playfair Display',Georgia,serif",lineHeight:1.35,cursor:"pointer",
              }}>{item.title}</h3>
              {item.description && !expanded && (
                <p style={{margin:"0 0 6px",fontSize:12,color:"rgba(255,255,255,0.37)",lineHeight:1.5,
                  display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                  {item.description}
                </p>
              )}
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {(item.tags||[]).map(tag => (
                  <TagPill key={tag} tag={tag} active={activeTag===tag} onClick={()=>onTagClick(tag)} />
                ))}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
              <button onClick={()=>onToggleRead(item.id)} style={{
                background:"none",border:`1px solid ${item.read?"#6EC98F50":"rgba(255,255,255,0.12)"}`,
                borderRadius:4,color:item.read?"#6EC98F":"rgba(255,255,255,0.28)",
                cursor:"pointer",padding:"4px 7px",fontSize:12,transition:"all 0.15s",
              }}>{item.read?"✓":"○"}</button>
              <button onClick={()=>onDelete(item.id)} style={{
                background:"none",border:"1px solid rgba(255,255,255,0.07)",
                borderRadius:4,color:"rgba(255,255,255,0.18)",
                cursor:"pointer",padding:"4px 7px",fontSize:11,
              }}>✕</button>
            </div>
          </div>
          {expanded && (
            <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(255,255,255,0.07)"}}>
              {item.description && <p style={{margin:"0 0 7px",fontSize:13,color:"rgba(255,255,255,0.42)",lineHeight:1.6}}>{item.description}</p>}
              {item.notes && (
                <p style={{margin:"0 0 7px",fontSize:12,color:"rgba(255,255,255,0.35)",fontStyle:"italic",lineHeight:1.6,
                  borderLeft:"2px solid rgba(255,255,255,0.08)",paddingLeft:10}}>"{item.notes}"</p>
              )}
              <a href={item.url} target="_blank" rel="noreferrer" style={{
                fontSize:11,color:t.color,fontFamily:"'DM Mono',monospace",
                textDecoration:"none",wordBreak:"break-all",opacity:0.65,
              }}>{item.url}</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ADD / EDIT MODAL ────────────────────────────────────────────────────────
function AddModal({ onClose, onAdd, collections }) {
  const [form, setForm] = useState({ title:"", url:"", type:"article", tags:"", notes:"", collection:"" });
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview] = useState(null);
  const [newCol, setNewCol] = useState("");
  const debRef = useRef(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleUrl = v => {
    set("url", v);
    setPreview(null);
    clearTimeout(debRef.current);
    if (!v.trim() || !v.startsWith("http")) return;
    debRef.current = setTimeout(async () => {
      setFetching(true);
      const meta = await fetchMeta(v.trim());
      setFetching(false);
      if (meta.title || meta.image) {
        setPreview(meta);
        if (meta.title && !form.title) set("title", meta.title);
      }
    }, 700);
  };

  const submit = () => {
    if (!form.title.trim() || !form.url.trim()) return;
    const col = newCol.trim() || form.collection;
    onAdd({
      id: Date.now().toString(),
      title: form.title.trim(), url: form.url.trim(), type: form.type,
      tags: form.tags.split(",").map(t=>t.trim()).filter(Boolean),
      notes: form.notes.trim(), read: false, saved: new Date().toISOString(),
      image: preview?.image || getFavicon(form.url) || null,
      description: preview?.description || "",
      collection: col || null,
    });
    onClose();
  };

  const inp = { width:"100%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",
    borderRadius:6,padding:"9px 12px",color:"#f0ece4",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",boxSizing:"border-box" };
  const lbl = { display:"block",fontSize:10,letterSpacing:"0.1em",color:"rgba(255,255,255,0.38)",
    fontFamily:"'DM Mono',monospace",textTransform:"uppercase",marginBottom:5 };
  const activeType = TYPES.find(t=>t.id===form.type);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",display:"flex",alignItems:"center",
      justifyContent:"center",zIndex:100,backdropFilter:"blur(6px)",padding:20}}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:"#1a1814",border:"1px solid rgba(255,255,255,0.12)",borderRadius:14,
        padding:26,width:"100%",maxWidth:500,maxHeight:"90vh",overflowY:"auto"}}>
        <h2 style={{margin:"0 0 20px",fontFamily:"'Playfair Display',serif",fontSize:20,color:"#f0ece4",fontWeight:700}}>
          Add to Library
        </h2>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* Type */}
          <div>
            <label style={lbl}>Type</label>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              {TYPES.map(t=>(
                <button key={t.id} onClick={()=>set("type",t.id)} style={{
                  padding:"5px 11px",borderRadius:5,cursor:"pointer",fontSize:11,
                  border:`1px solid ${form.type===t.id?t.color:"rgba(255,255,255,0.1)"}`,
                  background:form.type===t.id?`${t.color}20`:"transparent",
                  color:form.type===t.id?t.color:"rgba(255,255,255,0.38)",
                  fontFamily:"'DM Mono',monospace",transition:"all 0.15s",
                }}>{t.icon} {t.label}</button>
              ))}
            </div>
          </div>

          {/* URL */}
          <div>
            <label style={lbl}>URL * — auto-fills title & image</label>
            <div style={{position:"relative"}}>
              <input style={inp} placeholder="https://…" value={form.url} onChange={e=>handleUrl(e.target.value)} />
              {fetching && <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                fontSize:10,color:"#E8B86D",fontFamily:"'DM Mono',monospace"}}>fetching…</span>}
            </div>
            {preview && (
              <div style={{marginTop:7,borderRadius:7,overflow:"hidden",border:"1px solid rgba(255,255,255,0.1)",
                display:"flex",height:68,animation:"fadeIn 0.2s ease"}}>
                {preview.image && (
                  <div style={{width:90,height:68,flexShrink:0,background:`${activeType?.color||"#E8B86D"}15`,
                    display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",position:"relative"}}>
                    <img src={preview.image} alt="" style={{
                      width:preview.image?.includes("favicons")?32:"100%",
                      height:preview.image?.includes("favicons")?32:68,
                      objectFit:"cover",borderRadius:preview.image?.includes("favicons")?6:0,
                    }} onError={e=>e.target.style.display="none"} />
                  </div>
                )}
                <div style={{padding:"8px 11px",flex:1,minWidth:0,background:"rgba(255,255,255,0.02)"}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#f0ece4",fontFamily:"'Playfair Display',serif",
                    whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{preview.title}</div>
                  {preview.description && (
                    <div style={{fontSize:11,color:"rgba(255,255,255,0.32)",lineHeight:1.4,marginTop:2,
                      display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                      {preview.description}
                    </div>
                  )}
                </div>
                <div style={{padding:"7px 9px",fontSize:10,color:"#6EC98F",fontFamily:"'DM Mono',monospace",flexShrink:0}}>✓</div>
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label style={lbl}>Title *</label>
            <input style={inp} placeholder="Enter title…" value={form.title} onChange={e=>set("title",e.target.value)} />
          </div>

          {/* Collection */}
          <div>
            <label style={lbl}>Collection</label>
            <div style={{display:"flex",gap:6}}>
              <select value={form.collection} onChange={e=>set("collection",e.target.value)} style={{
                ...inp,width:"auto",flex:1,cursor:"pointer",
              }}>
                <option value="">None</option>
                {collections.map(c=><option key={c} value={c}>{c}</option>)}
                <option value="__new__">+ New collection…</option>
              </select>
            </div>
            {(form.collection==="__new__") && (
              <input style={{...inp,marginTop:6}} placeholder="Collection name…"
                value={newCol} onChange={e=>setNewCol(e.target.value)} />
            )}
          </div>

          {/* Tags */}
          <div>
            <label style={lbl}>Tags (comma separated)</label>
            <input style={inp} placeholder="AI, research, NLP…" value={form.tags} onChange={e=>set("tags",e.target.value)} />
          </div>

          {/* Notes */}
          <div>
            <label style={lbl}>Notes</label>
            <textarea style={{...inp,height:66,resize:"vertical"}}
              placeholder="Why did you save this?" value={form.notes} onChange={e=>set("notes",e.target.value)} />
          </div>
        </div>

        <div style={{display:"flex",justifyContent:"flex-end",gap:9,marginTop:20}}>
          <button onClick={onClose} style={{background:"none",border:"1px solid rgba(255,255,255,0.12)",
            borderRadius:6,color:"rgba(255,255,255,0.38)",cursor:"pointer",padding:"9px 18px",fontSize:12}}>Cancel</button>
          <button onClick={submit} style={{background:"#E8B86D",border:"none",borderRadius:6,color:"#1a1814",
            cursor:"pointer",padding:"9px 22px",fontSize:12,fontWeight:700,fontFamily:"'DM Mono',monospace",letterSpacing:"0.05em"}}>
            Save →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function Sidebar({ items, activeCollection, setActiveCollection, activeTag, setActiveTag }) {
  const collections = useMemo(() => {
    const map = {};
    items.forEach(i => { if (i.collection) map[i.collection] = (map[i.collection]||0)+1; });
    return Object.entries(map).sort((a,b)=>b[1]-a[1]);
  }, [items]);

  const tags = useMemo(() => {
    const map = {};
    items.forEach(i => (i.tags||[]).forEach(t => { map[t] = (map[t]||0)+1; }));
    return Object.entries(map).sort((a,b)=>b[1]-a[1]);
  }, [items]);

  const sectionLabel = { fontSize:9,letterSpacing:"0.14em",color:"rgba(255,255,255,0.25)",
    fontFamily:"'DM Mono',monospace",textTransform:"uppercase",marginBottom:8,display:"block" };
  const rowStyle = (active) => ({
    display:"flex",alignItems:"center",justifyContent:"space-between",
    padding:"5px 9px",borderRadius:5,cursor:"pointer",marginBottom:2,
    background: active?"rgba(232,184,109,0.1)":"transparent",
    border:`1px solid ${active?"rgba(232,184,109,0.3)":"transparent"}`,
    transition:"all 0.12s",
  });

  return (
    <div style={{width:210,flexShrink:0,padding:"22px 16px",borderRight:"1px solid rgba(255,255,255,0.06)",
      height:"calc(100vh - 0px)",position:"sticky",top:0,overflowY:"auto"}}>

      {/* Collections */}
      <span style={sectionLabel}>Collections</span>
      <div style={{marginBottom:18}}>
        <div style={rowStyle(!activeCollection)} onClick={()=>setActiveCollection(null)}>
          <span style={{fontSize:12,color:"rgba(255,255,255,0.5)",fontFamily:"'DM Sans',sans-serif"}}>📚 All items</span>
          <span style={{fontSize:10,color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace"}}>{items.length}</span>
        </div>
        {collections.map(([name,count])=>(
          <div key={name} style={rowStyle(activeCollection===name)} onClick={()=>setActiveCollection(activeCollection===name?null:name)}>
            <span style={{fontSize:12,color: activeCollection===name?"#E8B86D":"rgba(255,255,255,0.45)",
              fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
              📁 {name}
            </span>
            <span style={{fontSize:10,color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace",flexShrink:0,marginLeft:4}}>{count}</span>
          </div>
        ))}
        {collections.length===0 && (
          <div style={{fontSize:11,color:"rgba(255,255,255,0.18)",fontFamily:"'DM Mono',monospace",padding:"4px 9px"}}>
            No collections yet
          </div>
        )}
      </div>

      {/* Tags */}
      <span style={sectionLabel}>Tags</span>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {tags.map(([tag,count])=>(
          <div key={tag} style={rowStyle(activeTag===tag)} onClick={()=>setActiveTag(activeTag===tag?null:tag)}>
            <span style={{fontSize:11,color:activeTag===tag?"#E8B86D":"rgba(255,255,255,0.42)",
              fontFamily:"'DM Mono',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
              # {tag}
            </span>
            <span style={{fontSize:10,color:"rgba(255,255,255,0.22)",fontFamily:"'DM Mono',monospace",flexShrink:0,marginLeft:4}}>{count}</span>
          </div>
        ))}
        {tags.length===0 && (
          <div style={{fontSize:11,color:"rgba(255,255,255,0.18)",fontFamily:"'DM Mono',monospace",padding:"4px 9px"}}>
            No tags yet
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [filterRead, setFilterRead] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [activeCollection, setActiveCollection] = useState(null);
  const [activeTag, setActiveTag] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load
  useEffect(() => {
    (async () => {
      let data = null;
      if (sb) { try { data = await sb.all(); } catch {} }
      if (!data) data = await local.load();
      setItems(data || SAMPLE);
      setLoaded(true);
    })();
  }, []);

  // Save (local only — Supabase ops are per-mutation)
  useEffect(() => {
    if (!loaded || sb) return;
    local.save(items);
  }, [items, loaded]);

  const addItem = async item => {
    setItems(p => [item, ...p]);
    if (sb) { setSaving(true); await sb.add(item).catch(()=>{}); setSaving(false); }
  };

  const toggleRead = async id => {
    const item = items.find(i=>i.id===id);
    setItems(p => p.map(i => i.id===id ? { ...i, read:!i.read } : i));
    if (sb && item) sb.patch(id, { read: !item.read }).catch(()=>{});
  };

  const deleteItem = async id => {
    setItems(p => p.filter(i => i.id!==id));
    if (sb) sb.del(id).catch(()=>{});
  };

  const collections = useMemo(() => [...new Set(items.map(i=>i.collection).filter(Boolean))], [items]);

  const filtered = useMemo(() => {
    let result = items;
    if (activeCollection) result = result.filter(i=>i.collection===activeCollection);
    if (activeTag)        result = result.filter(i=>(i.tags||[]).includes(activeTag));
    if (filterType!=="all") result = result.filter(i=>i.type===filterType);
    if (filterRead==="unread") result = result.filter(i=>!i.read);
    if (filterRead==="read")   result = result.filter(i=>i.read);
    result = fuzzySearch(result, search);
    if (!search) result = [...result].sort((a,b)=>{
      if (sortBy==="newest") return new Date(b.saved)-new Date(a.saved);
      if (sortBy==="oldest") return new Date(a.saved)-new Date(b.saved);
      return a.title.localeCompare(b.title);
    });
    return result;
  }, [items, search, filterType, filterRead, sortBy, activeCollection, activeTag]);

  const counts = useMemo(() => ({
    all: items.length,
    unread: items.filter(i=>!i.read).length,
    ...Object.fromEntries(TYPES.map(t=>[t.id, items.filter(i=>i.type===t.id).length])),
  }), [items]);

  const chip = (active, color) => ({
    padding:"4px 11px",borderRadius:5,cursor:"pointer",fontSize:11,
    border:`1px solid ${active?(color||"rgba(255,255,255,0.5)"):"rgba(255,255,255,0.09)"}`,
    background:active?`${color||"rgba(255,255,255,0.9)"}15`:"transparent",
    color:active?(color||"#f0ece4"):"rgba(255,255,255,0.32)",
    fontFamily:"'DM Mono',monospace",letterSpacing:"0.05em",transition:"all 0.15s",whiteSpace:"nowrap",
  });
  const sel = {
    background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.09)",
    borderRadius:5,color:"rgba(255,255,255,0.4)",padding:"4px 9px",
    fontSize:11,fontFamily:"'DM Mono',monospace",cursor:"pointer",outline:"none",
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@300;400&display=swap');
        @keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box}body{margin:0;background:#100f0d}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}
        input::placeholder,textarea::placeholder{color:rgba(255,255,255,0.18)!important}
        input:focus,textarea:focus,select:focus{border-color:rgba(232,184,109,0.35)!important;outline:none}
        button:hover{opacity:0.75}select option{background:#1a1814;color:#f0ece4}
        a:hover{opacity:1!important}
      `}</style>

      <div style={{minHeight:"100vh",background:"#100f0d",color:"#f0ece4",fontFamily:"'DM Sans',sans-serif",
        backgroundImage:"radial-gradient(ellipse at 75% 0%,rgba(232,184,109,0.035) 0%,transparent 55%)"}}>

        {/* Top bar */}
        <div style={{borderBottom:"1px solid rgba(255,255,255,0.07)",padding:"16px 24px",
          position:"sticky",top:0,zIndex:50,background:"rgba(16,15,13,0.93)",backdropFilter:"blur(14px)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
            <div style={{display:"flex",alignItems:"baseline",gap:10,flexShrink:0}}>
              <h1 style={{margin:0,fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:700,
                color:"#f0ece4",letterSpacing:"-0.01em"}}>The Library</h1>
              <span style={{fontSize:10,color:"#E8B86D",fontFamily:"'DM Mono',monospace",
                letterSpacing:"0.12em",textTransform:"uppercase",opacity:0.75}}>
                {counts.all} items · {counts.unread} unread
                {saving && " · saving…"}
                {sb && !saving && " · ☁"}
              </span>
            </div>

            {/* Search */}
            <input style={{
              flex:1,maxWidth:420,background:"rgba(255,255,255,0.05)",
              border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,
              padding:"8px 13px",color:"#f0ece4",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",
            }} placeholder="Fuzzy search titles, tags, notes…" value={search} onChange={e=>setSearch(e.target.value)} />

            <button onClick={()=>setShowModal(true)} style={{
              background:"#E8B86D",border:"none",borderRadius:7,color:"#1a1814",
              cursor:"pointer",padding:"9px 18px",fontSize:11,fontWeight:700,
              fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em",flexShrink:0,
            }}>＋ Add</button>
          </div>

          {/* Type filter row */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginTop:12}}>
            <button style={chip(filterType==="all")} onClick={()=>setFilterType("all")}>All ({counts.all})</button>
            {TYPES.map(t=>(
              <button key={t.id} style={chip(filterType===t.id,t.color)} onClick={()=>setFilterType(filterType===t.id?"all":t.id)}>
                {t.icon} {t.label} {counts[t.id]?`(${counts[t.id]})`:""}</button>
            ))}
            <div style={{flex:1}}/>
            <select value={filterRead} onChange={e=>setFilterRead(e.target.value)} style={sel}>
              <option value="all">All</option>
              <option value="unread">Unread ({counts.unread})</option>
              <option value="read">Read ({counts.all-counts.unread})</option>
            </select>
            <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={sel}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="title">A → Z</option>
            </select>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div style={{display:"flex",minHeight:"calc(100vh - 120px)"}}>
          <Sidebar items={items} activeCollection={activeCollection}
            setActiveCollection={setActiveCollection} activeTag={activeTag} setActiveTag={setActiveTag} />

          <div style={{flex:1,minWidth:0,padding:"20px 24px 60px"}}>
            {/* Active filters */}
            {(activeCollection||activeTag) && (
              <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace"}}>Filtered by:</span>
                {activeCollection && (
                  <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"rgba(232,184,109,0.1)",
                    border:"1px solid rgba(232,184,109,0.25)",borderRadius:4,padding:"2px 8px",
                    fontSize:11,color:"#E8B86D",fontFamily:"'DM Mono',monospace",cursor:"pointer"}}
                    onClick={()=>setActiveCollection(null)}>📁 {activeCollection} ×</span>
                )}
                {activeTag && (
                  <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"rgba(232,184,109,0.1)",
                    border:"1px solid rgba(232,184,109,0.25)",borderRadius:4,padding:"2px 8px",
                    fontSize:11,color:"#E8B86D",fontFamily:"'DM Mono',monospace",cursor:"pointer"}}
                    onClick={()=>setActiveTag(null)}># {activeTag} ×</span>
                )}
              </div>
            )}

            {filtered.length===0 ? (
              <div style={{textAlign:"center",padding:"70px 20px",color:"rgba(255,255,255,0.18)"}}>
                <div style={{fontSize:36,marginBottom:12}}>◈</div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:17,marginBottom:7}}>
                  {items.length===0?"Your library is empty":"No results found"}
                </div>
                <div style={{fontSize:11,fontFamily:"'DM Mono',monospace"}}>
                  {items.length===0?"Add your first item to get started":"Try adjusting your search or filters"}
                </div>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:7}}>
                {filtered.map(item=>(
                  <Card key={item.id} item={item}
                    onToggleRead={toggleRead} onDelete={deleteItem}
                    activeTag={activeTag} onTagClick={t=>setActiveTag(activeTag===t?null:t)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showModal && <AddModal onClose={()=>setShowModal(false)} onAdd={addItem} collections={collections} />}
    </>
  );
}
