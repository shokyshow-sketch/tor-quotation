import { useState, useEffect, useMemo, useRef } from "react";
import { Upload, Trash2, Plus, Printer, Download, Loader2, FileText } from "lucide-react";

const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (n) =>
  (Number(n) || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => v.replace(/[^0-9.]/g, "");
const SELLER_KEY = "seller-profile";

/* ---------- ตัวเลขเป็นตัวอักษรไทย ---------- */
const TH_NUM = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const TH_POS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];
function readChunk(s) {
  let out = "";
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const d = +s[i];
    const pos = len - i - 1;
    if (d === 0) continue;
    if (pos === 0 && d === 1 && len > 1) out += "เอ็ด";
    else if (pos === 1 && d === 2) out += "ยี่สิบ";
    else if (pos === 1 && d === 1) out += "สิบ";
    else out += TH_NUM[d] + TH_POS[pos];
  }
  return out;
}
function readInt(str) {
  let s = str.replace(/^0+/, "") || "0";
  if (s === "0") return "ศูนย์";
  const chunks = [];
  while (s.length > 6) {
    chunks.unshift(s.slice(-6));
    s = s.slice(0, -6);
  }
  chunks.unshift(s);
  return chunks.map((c, i) => readChunk(c) + (i < chunks.length - 1 ? "ล้าน" : "")).join("");
}
function bahtText(n) {
  const cents = Math.round((Number(n) || 0) * 100);
  const baht = Math.floor(cents / 100);
  const sat = cents % 100;
  if (cents === 0) return "ศูนย์บาทถ้วน";
  if (sat === 0) return readInt(String(baht)) + "บาทถ้วน";
  return (baht > 0 ? readInt(String(baht)) + "บาท" : "") + readInt(String(sat)) + "สตางค์";
}

/* ---------- เรียก Claude อ่าน TOR ---------- */
const PROMPT = `You extract structured data from a Thai TOR (Terms of Reference / ขอบเขตของงาน) so a vendor can prepare a price quotation.
Respond with ONLY a JSON object. No markdown, no preamble.
Schema:
{"project": string, "agency": string, "refNo": string,
 "terms": [{"label": string, "detail": string}],
 "items": [{"name": string, "spec": string, "qty": number, "unit": string}]}
Rules:
- Keep Thai wording from the document.
- terms: only commercial conditions (delivery period, warranty, payment, penalties, validity). Max 6 entries, each detail under 70 characters.
- items: every product, service or deliverable that needs a price. name under 45 characters, spec under 60 characters. If quantity is not stated use 1 and unit "งาน". Max 30 items.
- Never invent prices. Use "" for unknown text fields.
- Put "terms" before "items" in the JSON.`;

function parseJson(raw) {
  const s = raw.replace(/```json|```/g, "").trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  const body = s.slice(start);
  try {
    return JSON.parse(body);
  } catch (e) {}
  // ผลลัพธ์ถูกตัดกลางทาง: ถอยกลับไปปิดที่รายการสุดท้ายที่ครบ
  for (let i = body.lastIndexOf("}"); i > 0; i = body.lastIndexOf("}", i - 1)) {
    try {
      return JSON.parse(body.slice(0, i + 1) + "]}");
    } catch (e) {}
  }
  return null;
}

const toBase64 = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(file);
  });

const blankItem = () => ({ id: uid(), name: "", spec: "", qty: "1", unit: "รายการ", price: "" });

export default function App() {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [doc, setDoc] = useState(null);
  const [discount, setDiscount] = useState("");
  const [vatOn, setVatOn] = useState(true);
  const [seller, setSeller] = useState({ name: "", address: "", taxId: "", phone: "", signer: "", validDays: "30" });
  const [quoteNo, setQuoteNo] = useState(() => {
    const d = new Date();
    return `QT-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-001`;
  });
  const paperRef = useRef(null);
  const loadedRef = useRef(false);
  const [priceBook, setPriceBook] = useState({});
  const [history, setHistory] = useState([]);
  const [pct, setPct] = useState("");

  /* โปรไฟล์บริษัทจำไว้ ไม่ต้องกรอกซ้ำ */
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(SELLER_KEY, false);
        if (r && r.value) setSeller((s) => ({ ...s, ...JSON.parse(r.value) }));
      } catch (e) {}
      try { const r = await window.storage.get("price-book", false); if (r && r.value) setPriceBook(JSON.parse(r.value)); } catch (e) {}
      try { const r = await window.storage.get("quote-history", false); if (r && r.value) setHistory(JSON.parse(r.value)); } catch (e) {}
      loadedRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(async () => {
      try {
        await window.storage.set(SELLER_KEY, JSON.stringify(seller), false);
      } catch (e) {}
    }, 600);
    return () => clearTimeout(t);
  }, [seller]);

  const calc = useMemo(() => {
    const items = (doc && doc.items) || [];
    const sub = items.reduce((a, it) => a + (parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0), 0);
    const disc = Math.min(parseFloat(discount) || 0, sub);
    const net = sub - disc;
    const vat = vatOn ? Math.round(net * 7) / 100 : 0;
    const missing = items.filter((it) => it.price === "").length;
    return { sub, disc, net, vat, total: net + vat, missing };
  }, [doc, discount, vatOn]);

  function onPick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    if (f.type === "text/plain" || f.name.toLowerCase().endsWith(".txt")) {
      const r = new FileReader();
      r.onload = () => {
        setText(String(r.result));
        setFile(null);
      };
      r.readAsText(f);
      return;
    }
    if (f.type === "application/pdf" || f.type.startsWith("image/")) {
      if (f.size > 20 * 1024 * 1024) return setError("ไฟล์ใหญ่เกิน 20 MB ลองลดขนาดหรือแยกเฉพาะหน้าที่เป็นขอบเขตงาน");
      return setFile(f);
    }
    setError("รองรับ PDF รูปภาพ และไฟล์ .txt ถ้าเป็น Word ให้บันทึกเป็น PDF หรือวางข้อความด้านล่าง");
  }

  async function extract() {
    setBusy(true);
    setError("");
    try {
      const content = [];
      if (file) {
        const b64 = await toBase64(file);
        if (file.type === "application/pdf")
          content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
        else content.push({ type: "image", source: { type: "base64", media_type: file.type, data: b64 } });
      }
      if (text.trim()) content.push({ type: "text", text: "TOR text:\n" + text.trim().slice(0, 30000) });
      content.push({ type: "text", text: PROMPT });

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error("api");
      const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const p = parseJson(raw);
      if (!p || !Array.isArray(p.items) || p.items.length === 0) throw new Error("parse");
      setDoc({
        project: p.project || "",
        agency: p.agency || "",
        refNo: p.refNo || "",
        terms: (p.terms || []).map((t) => ({ id: uid(), label: t.label || "", detail: t.detail || "" })),
        items: p.items.map((it) => ({
          id: uid(),
          name: it.name || "",
          spec: it.spec || "",
          qty: String(Number(it.qty) || 1),
          unit: it.unit || "รายการ",
          price: priceBook[(it.name || "").trim()] || "",
        })),
      });
      setStep(2);
    } catch (e) {
      setError("อ่าน TOR ไม่สำเร็จ ลองอัปโหลดอีกครั้ง หรือคัดลอกข้อความจาก TOR มาวางแทน");
    } finally {
      setBusy(false);
    }
  }

  function startBlank() {
    setDoc({ project: "", agency: "", refNo: "", terms: [], items: [blankItem()] });
    setStep(2);
  }

  const setItem = (id, patch) =>
    setDoc((d) => ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  const setTerm = (id, patch) =>
    setDoc((d) => ({ ...d, terms: d.terms.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const setHead = (patch) => setDoc((d) => ({ ...d, ...patch }));
  const setSell = (patch) => setSeller((s) => ({ ...s, ...patch }));

  function persist(key, val) {
    try { window.storage.set(key, JSON.stringify(val), false).catch(() => {}); } catch (e) {}
  }
  function learnPrices() {
    const pb = { ...priceBook };
    doc.items.forEach((it) => { if (it.name.trim() && it.price !== "") pb[it.name.trim()] = it.price; });
    setPriceBook(pb);
    persist("price-book", pb);
  }
  function saveQuote() {
    learnPrices();
    const rec = { id: quoteNo, no: quoteNo, project: doc.project, agency: doc.agency, total: calc.total, date: new Date().toLocaleDateString("th-TH"), doc, discount, vatOn };
    const h = [rec, ...history.filter((x) => x.id !== rec.id)].slice(0, 30);
    setHistory(h);
    persist("quote-history", h);
    setNotice("บันทึกใบเสนอราคาแล้ว");
  }
  function loadQuote(h) { setDoc(h.doc); setDiscount(h.discount || ""); setVatOn(h.vatOn); setQuoteNo(h.no); setStep(2); }
  function delQuote(id) { const h = history.filter((x) => x.id !== id); setHistory(h); persist("quote-history", h); }
  function bump() {
    const p = parseFloat(pct);
    if (!p) return;
    setDoc((d) => ({ ...d, items: d.items.map((it) => (it.price === "" ? it : { ...it, price: String(Math.round(parseFloat(it.price) * (1 + p / 100) * 100) / 100) })) }));
    setPct("");
  }
  function exportCsv() {
    try {
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const rows = [["ที่", "รายการ", "รายละเอียด", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน"], ...doc.items.map((it, i) => [i + 1, it.name, it.spec, it.qty, it.unit, it.price, (parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0)])];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["\ufeff", rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
      a.download = `${quoteNo}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) { setNotice("ดาวน์โหลดในหน้านี้ไม่ได้"); }
  }
  async function copyText() {
    const t = [`ใบเสนอราคา ${quoteNo}`, doc.project, ...doc.items.map((it, i) => `${i + 1}. ${it.name} ${it.qty} ${it.unit} x ${it.price === "" ? "-" : fmt(it.price)}`), `รวมทั้งสิ้น ${fmt(calc.total)} บาท (${bahtText(calc.total)})`].join("\n");
    try { await navigator.clipboard.writeText(t); setNotice("คัดลอกข้อความแล้ว"); } catch (e) { setNotice("คัดลอกในหน้านี้ไม่ได้"); }
  }
  function printPaper() {
    try {
      window.print();
    } catch (e) {
      setNotice("หน้านี้พิมพ์โดยตรงไม่ได้ ลองดาวน์โหลดเป็น Word แทน");
    }
  }
  function downloadWord() {
    try {
      const css =
        "body{font-family:Sarabun,'TH Sarabun New',Tahoma,sans-serif;font-size:12pt}table{border-collapse:collapse;width:100%}" +
        ".qt td,.qt th{border:1px solid #444;padding:4px}.r{text-align:right}.c{text-align:center}h1{text-align:center;font-size:18pt}";
      const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${paperRef.current.innerHTML}</body></html>`;
      const blob = new Blob(["\ufeff", html], { type: "application/msword" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ใบเสนอราคา-${quoteNo}.doc`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setNotice("");
    } catch (e) {
      setNotice("ดาวน์โหลดในหน้านี้ไม่ได้ ลองใช้ปุ่มพิมพ์/บันทึก PDF แทน");
    }
  }

  const today = new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  const canNext = (n) => n === 1 || !!doc;

  return (
    <div className="app">
      <style>{css}</style>

      <header className="top no-print">
        <h1 className="brand">TOR เป็นใบเสนอราคา</h1>
        <nav className="steps" aria-label="ขั้นตอน">
          {["อัปโหลด TOR", "ใส่ราคา", "ใบเสนอราคา"].map((label, i) => (
            <button
              key={label}
              className={"step" + (step === i + 1 ? " on" : "")}
              disabled={!canNext(i + 1)}
              onClick={() => setStep(i + 1)}
              aria-current={step === i + 1 ? "step" : undefined}
            >
              <span className="n">{i + 1}</span>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {/* ---------- ขั้นที่ 1 ---------- */}
      {step === 1 && (
        <main className="wrap no-print">
          <h2 className="lead">เริ่มจาก TOR ของงานที่จะเสนอราคา</h2>
          <p className="sub">เอไอจะดึงรายการ จำนวน และเงื่อนไขออกมาให้ คุณแค่ใส่ราคา</p>

          <label className="drop">
            <input type="file" accept="application/pdf,image/*,.txt" onChange={onPick} hidden />
            {file ? <FileText size={28} /> : <Upload size={28} />}
            <strong>{file ? file.name : "เลือกไฟล์ TOR"}</strong>
            <span>{file ? "แตะเพื่อเปลี่ยนไฟล์" : "PDF, รูปภาพ หรือ .txt ขนาดไม่เกิน 20 MB"}</span>
          </label>

          <label className="field">
            หรือวางข้อความจาก TOR
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="คัดลอกขอบเขตงานมาวางที่นี่" />
          </label>

          {error && <p className="err" role="alert">{error}</p>}

          <button className="btn primary block" disabled={busy || (!file && !text.trim())} onClick={extract}>
            {busy ? (<><Loader2 size={18} className="spin" /> กำลังอ่าน TOR</>) : "ดึงรายการจาก TOR"}
          </button>
          <button className="btn ghost block" onClick={startBlank} disabled={busy}>
            เริ่มจากใบเสนอราคาเปล่า
          </button>
        </main>
      )}

      {step === 1 && history.length > 0 && (
        <section className="wrap hist no-print">
          <h2 className="h">ใบเสนอราคาที่บันทึกไว้</h2>
          {history.map((h) => (
            <div className="item hrow" key={h.id}>
              <button className="hbtn" onClick={() => loadQuote(h)}>
                <b>{h.no}</b> {h.project || "(ไม่มีชื่อโครงการ)"}
                <span>{h.agency} / ฿{fmt(h.total)} / {h.date}</span>
              </button>
              <button className="icon" aria-label="ลบใบเสนอราคาที่บันทึก" onClick={() => delQuote(h.id)}><Trash2 size={18} /></button>
            </div>
          ))}
        </section>
      )}

      {/* ---------- ขั้นที่ 2 ---------- */}
      {step === 2 && doc && (
        <main className="wrap no-print">
          <section className="card">
            <h2 className="h">ข้อมูลงาน</h2>
            <label className="field">ชื่อโครงการ / งาน
              <input value={doc.project} onChange={(e) => setHead({ project: e.target.value })} />
            </label>
            <label className="field">เรียน (หน่วยงาน)
              <input value={doc.agency} onChange={(e) => setHead({ agency: e.target.value })} />
            </label>
            <div className="two">
              <label className="field">เลขที่อ้างอิง TOR
                <input value={doc.refNo} onChange={(e) => setHead({ refNo: e.target.value })} />
              </label>
              <label className="field">เลขที่ใบเสนอราคา
                <input value={quoteNo} onChange={(e) => setQuoteNo(e.target.value)} />
              </label>
            </div>
          </section>

          <h2 className="h pad">รายการที่ต้องเสนอราคา ({doc.items.length})</h2>
          {doc.items.map((it, i) => {
            const missing = it.price === "";
            const line = (parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0);
            return (
              <div className="item" key={it.id}>
                <div className="item-head">
                  <span className="idx">{i + 1}</span>
                  <input className="name" aria-label="ชื่อรายการ" placeholder="ชื่อรายการ" value={it.name} onChange={(e) => setItem(it.id, { name: e.target.value, ...(it.price === "" && priceBook[e.target.value.trim()] ? { price: priceBook[e.target.value.trim()] } : {}) })} />
                  <button className="icon" aria-label="คัดลอกรายการ" onClick={() => setDoc((d) => { const k = d.items.findIndex((x) => x.id === it.id); const a = [...d.items]; a.splice(k + 1, 0, { ...it, id: uid() }); return { ...d, items: a }; })}><Plus size={18} /></button>
                  <button className="icon" aria-label="ลบรายการ" onClick={() => setDoc((d) => ({ ...d, items: d.items.filter((x) => x.id !== it.id) }))}>
                    <Trash2 size={18} />
                  </button>
                </div>
                <input className="spec" aria-label="รายละเอียด" placeholder="รายละเอียด / สเปก" value={it.spec} onChange={(e) => setItem(it.id, { spec: e.target.value })} />
                <div className="trio">
                  <label className="field sm">จำนวน
                    <input inputMode="decimal" value={it.qty} onChange={(e) => setItem(it.id, { qty: num(e.target.value) })} />
                  </label>
                  <label className="field sm">หน่วย
                    <input value={it.unit} onChange={(e) => setItem(it.id, { unit: e.target.value })} />
                  </label>
                  <label className={"field sm price" + (missing ? " need" : "")}>ราคาต่อหน่วย (บาท)
                    <input inputMode="decimal" placeholder="ใส่ราคา" value={it.price} onChange={(e) => setItem(it.id, { price: num(e.target.value) })} />
                  </label>
                </div>
                <div className="line">รวม <b>{missing ? "-" : fmt(line)}</b></div>
              </div>
            );
          })}
          <button className="btn ghost block" onClick={() => setDoc((d) => ({ ...d, items: [...d.items, blankItem()] }))}>
            <Plus size={18} /> เพิ่มรายการ
          </button>
          <p className="hint">ถ้า TOR ยาวมาก เอไออาจดึงรายการได้ไม่ครบ ตรวจสอบกับต้นฉบับ แล้วเพิ่มรายการที่ขาดได้เลย</p>

          <section className="card">
            <h2 className="h">ปรับราคา ส่วนลด และภาษี</h2>
            <div className="two bumprow">
              <input aria-label="ปรับราคาทุกรายการ เป็นเปอร์เซ็นต์" inputMode="decimal" placeholder="ปรับทุกรายการ % เช่น 15 หรือ -5" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^0-9.\-]/g, ""))} />
              <button className="btn ghost" onClick={bump}>ปรับราคา</button>
            </div>
            <p className="hint">ใส่ราคาทุน แล้วบวกกำไร % ทีเดียวทุกรายการ</p>
            <label className="field">ส่วนลด (บาท)
              <input inputMode="decimal" value={discount} onChange={(e) => setDiscount(num(e.target.value))} placeholder="0.00" />
            </label>
            <label className="check">
              <input type="checkbox" checked={vatOn} onChange={(e) => setVatOn(e.target.checked)} />
              บวกภาษีมูลค่าเพิ่ม 7%
            </label>
          </section>

          <section className="card">
            <h2 className="h">เงื่อนไขจาก TOR</h2>
            {doc.terms.length === 0 && <p className="hint">ยังไม่มีเงื่อนไข เพิ่มได้ เช่น กำหนดส่งมอบ การรับประกัน การชำระเงิน</p>}
            {doc.terms.map((t) => (
              <div className="term" key={t.id}>
                <input aria-label="หัวข้อ" placeholder="หัวข้อ" value={t.label} onChange={(e) => setTerm(t.id, { label: e.target.value })} />
                <input aria-label="รายละเอียด" placeholder="รายละเอียด" value={t.detail} onChange={(e) => setTerm(t.id, { detail: e.target.value })} />
                <button className="icon" aria-label="ลบเงื่อนไข" onClick={() => setDoc((d) => ({ ...d, terms: d.terms.filter((x) => x.id !== t.id) }))}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => setDoc((d) => ({ ...d, terms: [...d.terms, { id: uid(), label: "", detail: "" }] }))}>
              <Plus size={18} /> เพิ่มเงื่อนไข
            </button>
          </section>

          <section className="card">
            <h2 className="h">ข้อมูลผู้เสนอราคา</h2>
            <label className="field">ชื่อบริษัท / ร้าน
              <input value={seller.name} onChange={(e) => setSell({ name: e.target.value })} />
            </label>
            <label className="field">ที่อยู่
              <textarea rows={2} value={seller.address} onChange={(e) => setSell({ address: e.target.value })} />
            </label>
            <div className="two">
              <label className="field">เลขประจำตัวผู้เสียภาษี
                <input inputMode="numeric" value={seller.taxId} onChange={(e) => setSell({ taxId: e.target.value })} />
              </label>
              <label className="field">โทรศัพท์
                <input inputMode="tel" value={seller.phone} onChange={(e) => setSell({ phone: e.target.value })} />
              </label>
            </div>
            <div className="two">
              <label className="field">ผู้ลงนาม
                <input value={seller.signer} onChange={(e) => setSell({ signer: e.target.value })} />
              </label>
              <label className="field">ยืนราคา (วัน)
                <input inputMode="numeric" value={seller.validDays} onChange={(e) => setSell({ validDays: num(e.target.value) })} />
              </label>
            </div>
            <p className="hint">ระบบจำข้อมูลนี้ไว้ให้ ครั้งต่อไปไม่ต้องกรอกซ้ำ</p>
          </section>

          <div className="bar">
            <div>
              <div className="bar-label">รวมสุทธิ</div>
              <div className="bar-total">฿{fmt(calc.total)}</div>
              {calc.missing > 0 && <div className="bar-warn">ยังไม่ใส่ราคา {calc.missing} รายการ</div>}
            </div>
            <button className="btn primary" onClick={() => { learnPrices(); setStep(3); }}>ดูใบเสนอราคา</button>
          </div>
        </main>
      )}

      {/* ---------- ขั้นที่ 3 ---------- */}
      {step === 3 && doc && (
        <main className="wrap wide">
          <div className="actions no-print">
            <button className="btn primary" onClick={printPaper}><Printer size={18} /> พิมพ์ / บันทึก PDF</button>
            <button className="btn ghost" onClick={downloadWord}><Download size={18} /> ดาวน์โหลด Word</button>
            <button className="btn ghost" onClick={() => setStep(2)}>แก้ไขราคา</button>
            <button className="btn ghost" onClick={saveQuote}>บันทึกใบเสนอราคา</button>
            <button className="btn ghost" onClick={exportCsv}>ส่งออก CSV</button>
            <button className="btn ghost" onClick={copyText}>คัดลอกเป็นข้อความ</button>
          </div>
          {notice && <p className={"no-print " + (/^(บันทึก|คัดลอก)/.test(notice) ? "okmsg" : "err")} role="status">{notice}</p>}
          {calc.missing > 0 && <p className="warn no-print">ยังมี {calc.missing} รายการที่ไม่ได้ใส่ราคา ในใบเสนอราคาจะแสดงเป็น "-"</p>}

          <div className="paper" ref={paperRef}>
            <h1 className="p-title">ใบเสนอราคา</h1>
            <div className="p-co">{seller.name || "ชื่อบริษัทของคุณ"}</div>
            {seller.address && <div>{seller.address}</div>}
            <div>
              {seller.taxId && <>เลขประจำตัวผู้เสียภาษี {seller.taxId}&nbsp;&nbsp;</>}
              {seller.phone && <>โทร {seller.phone}</>}
            </div>
            <div className="p-meta">
              <div>เลขที่ {quoteNo}</div>
              <div>วันที่ {today}</div>
              <div>เรียน {doc.agency || "-"}</div>
              <div>เรื่อง เสนอราคา {doc.project || "-"}</div>
              {doc.refNo && <div>อ้างอิง TOR เลขที่ {doc.refNo}</div>}
            </div>

            <table className="qt">
              <thead>
                <tr>
                  <th className="c" style={{ width: "8%" }}>ที่</th>
                  <th>รายการ</th>
                  <th className="c" style={{ width: "16%" }}>จำนวน</th>
                  <th className="r" style={{ width: "19%" }}>ราคา/หน่วย</th>
                  <th className="r" style={{ width: "20%" }}>จำนวนเงิน</th>
                </tr>
              </thead>
              <tbody>
                {doc.items.map((it, i) => {
                  const has = it.price !== "";
                  return (
                    <tr key={it.id}>
                      <td className="c">{i + 1}</td>
                      <td>
                        {it.name}
                        {it.spec && <div className="spec-s">{it.spec}</div>}
                      </td>
                      <td className="c">{it.qty} {it.unit}</td>
                      <td className="r">{has ? fmt(it.price) : "-"}</td>
                      <td className="r">{has ? fmt((parseFloat(it.qty) || 0) * (parseFloat(it.price) || 0)) : "-"}</td>
                    </tr>
                  );
                })}
                <tr><td colSpan={4} className="r">รวมเป็นเงิน</td><td className="r">{fmt(calc.sub)}</td></tr>
                {calc.disc > 0 && (<><tr><td colSpan={4} className="r">หักส่วนลด</td><td className="r">{fmt(calc.disc)}</td></tr>
                <tr><td colSpan={4} className="r">คงเหลือ</td><td className="r">{fmt(calc.net)}</td></tr></>)}
                {vatOn && <tr><td colSpan={4} className="r">ภาษีมูลค่าเพิ่ม 7%</td><td className="r">{fmt(calc.vat)}</td></tr>}
                <tr className="grand"><td colSpan={4} className="r">รวมเป็นเงินทั้งสิ้น</td><td className="r">{fmt(calc.total)}</td></tr>
              </tbody>
            </table>
            <div className="baht">({bahtText(calc.total)})</div>

            <div className="p-terms">
              <b>เงื่อนไขการเสนอราคา</b>
              <ul>
                {doc.terms.filter((t) => t.label || t.detail).map((t) => (
                  <li key={t.id}>{t.label}{t.label && t.detail ? ": " : ""}{t.detail}</li>
                ))}
                {seller.validDays && <li>ยืนราคา {seller.validDays} วัน นับจากวันที่เสนอราคา</li>}
              </ul>
            </div>

            <div className="sign">
              <div>ขอแสดงความนับถือ</div>
              <div className="sig-line" />
              <div>({seller.signer || "........................................"})</div>
              <div>ผู้เสนอราคา</div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Sarabun:wght@400;600;700&display=swap');
.app{--bg:#E8ECF1;--surface:#fff;--ink:#14213D;--muted:#5B6781;--line:#CBD3DF;--primary:#1F3B73;--primary-d:#17305F;--amber:#F5B942;--amber-t:#FFF3D1;--danger:#B3261E;
  min-height:100vh;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans Thai','Noto Sans Thai','Leelawadee UI',Thonburi,system-ui,sans-serif;font-size:16px;line-height:1.55}
.app *{box-sizing:border-box}
.top{background:var(--surface);border-bottom:1px solid var(--line);padding:14px 16px 0;position:sticky;top:0;z-index:5}
.brand{font-size:17px;font-weight:600;margin:0 0 10px}
.steps{display:flex;gap:4px}
.step{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 4px;border:0;border-bottom:3px solid transparent;background:none;color:var(--muted);font:inherit;font-size:14px;cursor:pointer}
.step:disabled{opacity:.4;cursor:default}
.step.on{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}
.step .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--line);color:var(--ink);font-size:12px}
.step.on .n{background:var(--primary);color:#fff}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 120px}
.wrap.wide{max-width:820px;padding-bottom:40px}
.lead{font-size:22px;line-height:1.35;margin:8px 0 6px}
.sub{color:var(--muted);margin:0 0 20px}
.drop{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;padding:28px 16px;border:2px dashed var(--primary);border-radius:10px;background:var(--surface);cursor:pointer;margin-bottom:18px;color:var(--primary)}
.drop strong{color:var(--ink);word-break:break-all}
.drop span{color:var(--muted);font-size:14px}
.field{display:flex;flex-direction:column;gap:4px;font-size:14px;color:var(--muted);margin-bottom:12px}
.field.sm{margin-bottom:0;font-size:12px}
.app input[type=text],.app input:not([type]),.app textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);font:inherit;font-size:16px}
.app textarea{resize:vertical}
.app :focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 18px;border-radius:6px;border:1px solid var(--primary);font:inherit;font-weight:500;cursor:pointer;background:#fff;color:var(--primary)}
.btn.primary{background:var(--primary);color:#fff}
.btn.primary:hover:not(:disabled){background:var(--primary-d)}
.btn.ghost{background:transparent}
.btn:disabled{opacity:.45;cursor:default}
.btn.block{display:flex;width:100%;margin-top:10px}
.err{color:var(--danger);margin:8px 0}
.warn{background:var(--amber-t);border-left:4px solid var(--amber);padding:10px 12px;margin:0 0 12px;font-size:14px}
.hint{color:var(--muted);font-size:13px;margin:8px 0 0}
.h{font-size:16px;margin:0 0 12px}
.h.pad{margin:22px 0 10px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.item{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px}
.item-head{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.idx{flex:none;width:26px;height:26px;border-radius:50%;background:var(--bg);display:grid;place-items:center;font-size:13px;font-weight:600}
.item .spec{margin-bottom:8px;font-size:14px}
.trio{display:grid;grid-template-columns:.8fr 1fr 1.4fr;gap:8px}
.price.need input{background:var(--amber-t);border-color:var(--amber)}
.line{text-align:right;margin-top:8px;color:var(--muted);font-size:14px}
.line b{color:var(--ink);font-size:16px}
.icon{flex:none;border:0;background:none;color:var(--muted);padding:8px;border-radius:6px;cursor:pointer}
.icon:hover{color:var(--danger)}
.term{display:grid;grid-template-columns:1fr 1.6fr auto;gap:6px;align-items:center;margin-bottom:8px}
.term input{font-size:14px!important}
.check{display:flex;align-items:center;gap:10px;font-size:15px}
.check input{width:20px;height:20px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:6}
.bar-label{font-size:12px;color:var(--muted)}
.bar-total{font-size:20px;font-weight:600;line-height:1.2}
.bar-warn{font-size:12px;color:#8A5A00}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}

/* ใบเสนอราคา: กระดาษมุมคม เงาเดียวในทั้งหน้า */
.paper{background:#fff;color:#111;font-family:Sarabun,'TH Sarabun New','Noto Sans Thai',Tahoma,sans-serif;font-size:14px;line-height:1.5;padding:22px 18px;border-radius:2px;box-shadow:0 6px 28px rgba(20,33,61,.18);overflow-x:auto}
.p-title{text-align:center;font-size:24px;font-weight:700;margin:0 0 10px}
.p-co{font-weight:700;font-size:16px}
.p-meta{margin:10px 0 12px;padding:8px 0;border-top:1px solid #999;border-bottom:1px solid #999}
.qt{width:100%;border-collapse:collapse;font-size:13px}
.qt th,.qt td{border:1px solid #444;padding:4px 6px;vertical-align:top}
.qt th{background:#EEF1F6}
.qt .c{text-align:center}.qt .r{text-align:right}
.qt .grand td{font-weight:700;background:#EEF1F6}
.spec-s{font-size:12px;color:#444}
.baht{text-align:right;margin:6px 0 14px;font-weight:600}
.p-terms ul{margin:4px 0 0;padding-left:20px}
.sign{margin:28px 0 0 auto;width:62%;text-align:center}
.sig-line{border-bottom:1px dotted #333;height:42px;margin:6px 0}
@media (min-width:640px){.paper{padding:40px 44px;font-size:15px}.qt{font-size:14px}.p-title{font-size:28px}}
.okmsg{color:#1E7A5A;margin:8px 0}
.hist{padding-top:0}
.bumprow{margin-bottom:6px}
.hrow{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px}
.hbtn{flex:1;text-align:left;border:0;background:none;font:inherit;color:var(--ink);cursor:pointer;padding:6px 0}
.hbtn span{display:block;font-size:13px;color:var(--muted)}
@media print{
  body *{visibility:hidden}
  .paper,.paper *{visibility:visible}
  .paper{position:absolute;left:0;top:0;width:100%;box-shadow:none;padding:0}
  .no-print{display:none!important}
}
`;
