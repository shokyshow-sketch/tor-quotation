// BYOK: ใช้ API key ของผู้ใช้ที่ส่งมากับคำขอ ไม่เก็บ ไม่บันทึก
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const key = req.headers["x-api-key"];
  if (!key || !String(key).startsWith("sk-ant-")) return res.status(401).json({ error: "missing api key" });
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: "bad request" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.MODEL || "claude-sonnet-5-5", max_tokens: 4000, messages }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: "upstream error" });
  }
}
