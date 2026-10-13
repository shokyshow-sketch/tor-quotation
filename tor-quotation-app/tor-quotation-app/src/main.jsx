import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// เก็บข้อมูล (ประวัติ/ราคาที่จำไว้) ในเบราว์เซอร์ของผู้ใช้แต่ละคน
window.storage = {
  async get(k) {
    const v = localStorage.getItem("tq:" + k);
    if (v === null) throw new Error("not found");
    return { key: k, value: v };
  },
  async set(k, v) {
    localStorage.setItem("tq:" + k, v);
    return { key: k, value: v };
  },
};

// ส่งคำขอผ่าน /api/extract พร้อม API key ของผู้ใช้เอง (ไม่เก็บไว้ที่เซิร์ฟเวอร์)
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
  const key = localStorage.getItem("tq-key") || "";
  if (!key) {
    window.dispatchEvent(new CustomEvent("tq-key-bad", { detail: { missing: true } }));
    return new Response("{}", { status: 401 });
  }
  const res = await realFetch("/api/extract", { ...opts, headers: { ...(opts.headers || {}), "x-api-key": key } });
  if (res.status === 401) window.dispatchEvent(new CustomEvent("tq-key-bad", { detail: {} }));
  return res;
};

const S = {
  page: { minHeight: "100vh", background: "#E8ECF1", color: "#14213D", fontFamily: "'IBM Plex Sans Thai','Noto Sans Thai','Leelawadee UI',Thonburi,system-ui,sans-serif", display: "grid", placeItems: "center", padding: 16, lineHeight: 1.6 },
  card: { background: "#fff", border: "1px solid #CBD3DF", borderRadius: 10, padding: 20, maxWidth: 480, width: "100%" },
  input: { width: "100%", padding: "10px 12px", border: "1px solid #CBD3DF", borderRadius: 6, fontSize: 16, fontFamily: "inherit", boxSizing: "border-box" },
  btn: { width: "100%", padding: "12px 18px", borderRadius: 6, border: "1px solid #1F3B73", background: "#1F3B73", color: "#fff", fontSize: 16, fontFamily: "inherit", cursor: "pointer", marginTop: 10 },
  ghost: { background: "transparent", color: "#1F3B73" },
  small: { fontSize: 13, color: "#5B6781" },
  top: { position: "fixed", top: 8, right: 8, zIndex: 20, fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid #CBD3DF", background: "#fff", color: "#5B6781", cursor: "pointer" },
};

function Root() {
  const [key, setKey] = useState(() => localStorage.getItem("tq-key") || "");
  const [skip, setSkip] = useState(false);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const bad = (e) => {
      if (e.detail && e.detail.missing) {
        alert("ต้องใส่ API key ก่อนจึงจะใช้เอไออ่าน TOR กดปุ่ม API key มุมขวาบน");
        return;
      }
      localStorage.removeItem("tq-key");
      setKey("");
      setSkip(false);
      setErr("API key ใช้ไม่ได้ ตรวจสอบว่าคัดลอกครบ แล้วใส่ใหม่");
    };
    window.addEventListener("tq-key-bad", bad);
    return () => window.removeEventListener("tq-key-bad", bad);
  }, []);

  function save(e) {
    e.preventDefault();
    const k = input.trim();
    if (!k.startsWith("sk-ant-")) return setErr("API key ของ Anthropic ขึ้นต้นด้วย sk-ant-");
    localStorage.setItem("tq-key", k);
    setKey(k);
    setInput("");
    setErr("");
  }
  function changeKey() {
    localStorage.removeItem("tq-key");
    setKey("");
    setSkip(false);
  }

  if (!key && !skip)
    return (
      <div style={S.page}>
        <form style={S.card} onSubmit={save}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>ใส่ API key เพื่อใช้เอไออ่าน TOR</h1>
          <p style={{ margin: "0 0 12px" }}>ค่าใช้จ่ายคิดกับบัญชี Anthropic ของคุณเอง ประมาณไม่กี่บาทต่อ TOR 1 ฉบับ</p>
          <ol style={{ margin: "0 0 14px", paddingLeft: 20 }}>
            <li>สมัครที่ console.anthropic.com</li>
            <li>เติมเครดิตเล็กน้อย (บัญชีใหม่อาจมีเครดิตทดลองให้)</li>
            <li>เข้าเมนู API Keys แล้วสร้าง key ใหม่</li>
            <li>คัดลอก key มาวางด้านล่าง</li>
          </ol>
          <input style={S.input} type="password" autoComplete="off" placeholder="sk-ant-..." value={input} onChange={(e) => setInput(e.target.value)} aria-label="API key" />
          {err && <p style={{ color: "#B3261E", margin: "8px 0 0" }} role="alert">{err}</p>}
          <button style={S.btn} type="submit">บันทึกและเริ่มใช้งาน</button>
          <button style={{ ...S.btn, ...S.ghost }} type="button" onClick={() => setSkip(true)}>ข้าม ใช้แบบกรอกรายการเอง (ไม่ใช้เอไอ)</button>
          <p style={{ ...S.small, margin: "12px 0 0" }}>
            key เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น เว็บส่งต่อให้ Anthropic เพื่อเรียกใช้แต่ละครั้งและไม่บันทึกที่เซิร์ฟเวอร์
            แนะนำให้สร้าง key เฉพาะสำหรับเว็บนี้ และตั้งวงเงินใช้จ่ายสูงสุดไว้
          </p>
        </form>
      </div>
    );

  return (
    <>
      <button className="no-print" style={S.top} onClick={changeKey}>{key ? "เปลี่ยน API key" : "ใส่ API key"}</button>
      <App />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
