// Fugu code generator (v3) — ストリーミング進捗 + .env自動読込 + 全文ログ
// 既定: stream=ON, FUGU_MAXTIME=86400(24h), FUGU_MODEL=fugu
//   node gen.mjs                       初回=生成 / 2回目以降=前回コードを渡して修正
//   node gen.mjs "改良指示"
//   FUGU_MODEL=fugu-ultra node gen.mjs
//   FUGU_STREAM=0 ... でストリーミング無効
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { spawn } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT  = join(ROOT, "public", "index.html");
const LOGS = join(ROOT, "logs");
mkdirSync(LOGS, { recursive: true });

function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const API_KEY  = process.env.FUGU_API_KEY;
const BASE_URL = "https://api.sakana.ai/v1";
const MODEL    = process.env.FUGU_MODEL || "fugu";
const MAXTIME  = process.env.FUGU_MAXTIME || "86400";
const STREAM   = process.env.FUGU_STREAM !== "0";
if (!API_KEY) { console.error("FUGU_API_KEY が .env にも環境変数にもありません"); process.exit(1); }

const extra = process.argv.slice(2).join(" ").trim();
const prev  = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;

const system = `あなたは熟練のクリエイティブコーダーです。
出力は **単一の index.html ファイルのみ**。説明文やマークダウンの装飾は一切付けず、<!DOCTYPE html> から始まる完全なHTMLだけを返してください。
要件:
- Three.js を CDN (https://unpkg.com/three@0.160.0/build/three.module.js) から importmap で読み込む
- 外部アセット・画像・サーバは使わず、ジオメトリとシェーダ/マテリアルだけで完結させる
- スマホ/PC両対応、リサイズ対応、60fpsを意識`;

const baseTask = `水中を泳ぐ「魚のゲーム」をThree.jsで作ってください。
- プレイヤーは1匹の魚。マウス/タップ追従、またはWASD/矢印で操作
- 周囲に小さな餌が漂い、食べるとスコアが増え魚が少し大きくなる
- 敵の大きい魚が数匹泳いでいて、接触するとゲームオーバー
- 水の揺らぎ・気泡・ライティングで雰囲気を出す
- 画面にスコアと簡単な操作説明を表示`;

const userMsg = prev
  ? `現在の index.html はこれです。次の指示に従って改良し、また単一HTMLとして全文返してください。\n指示: ${extra || "バグがあれば直し、見栄えと操作性を良くする"}\n\n--- 現在のコード ---\n${prev}`
  : (extra ? `${baseTask}\n\n追加要望: ${extra}` : baseTask);

const mode = prev ? "fix" : "gen";
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const reqBody = {
  model: MODEL,
  stream: STREAM,
  ...(STREAM ? { stream_options: { include_usage: true } } : {}),
  messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
};
const reqPath = join(LOGS, `${ts}_${mode}_req.json`);
const rawPath = join(LOGS, `${ts}_${mode}_res.${STREAM ? "sse" : "json"}`);
writeFileSync(reqPath, JSON.stringify(reqBody, null, 2));

console.log(`▶ ${MODEL} に${prev ? "修正" : "生成"}を依頼中... (stream=${STREAM}, max ${MAXTIME}s)`);

const curlArgs = [
  "-sS", "-N", "--no-buffer", "--max-time", MAXTIME,
  `${BASE_URL}/chat/completions`,
  "-H", `Authorization: Bearer ${API_KEY}`,
  "-H", "Content-Type: application/json",
  "--data-binary", `@${reqPath}`,
];

const t0 = Date.now();
const child = spawn("curl", curlArgs);
const rawOut = createWriteStream(rawPath);
let html = "", buf = "", usage = null, chars = 0, lastTick = -99;

function tick(force) {
  const el = (Date.now() - t0) / 1000;
  if (force || el - lastTick >= 3) { lastTick = el; process.stdout.write(`\r⏳ ${el.toFixed(0)}s  受信 ${chars} 文字 ...    `); }
}
child.stderr.on("data", d => process.stderr.write(d));
child.stdout.on("data", chunk => {
  rawOut.write(chunk);
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") continue;
    try {
      const j = JSON.parse(d);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) { html += delta; chars += delta.length; }
      if (j.usage) usage = j.usage;
    } catch {}
  }
  tick(false);
});
child.on("close", code => {
  rawOut.end();
  tick(true); process.stdout.write("\n");
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (code !== 0) { console.error(`curl 終了コード ${code}`); process.exit(1); }
  if (!html) { // 非ストリーム応答だった場合のフォールバック
    try { const j = JSON.parse(readFileSync(rawPath, "utf8")); html = j.choices?.[0]?.message?.content || ""; usage = j.usage || usage; } catch {}
  }
  html = html.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  appendFileSync(join(LOGS, "transcript.md"),
    `\n## ${ts}  [${mode}]  model=${MODEL}  ${elapsed}s\n` +
    `**指示:** ${prev ? (extra || "(自動修正)") : "(初回生成)"}\n` +
    `**usage:** ${JSON.stringify(usage)}\n` +
    `**出力:** ${html.length} bytes → public/index.html\n`);
  if (!/<!doctype|<html/i.test(html)) { console.error("HTMLが得られませんでした。冒頭:\n" + html.slice(0, 300)); process.exit(1); }
  writeFileSync(OUT, html);
  console.log(`✓ public/index.html に保存 (${html.length} bytes, ${elapsed}s, usage=${JSON.stringify(usage)})`);
  console.log(`  ログ: logs/${ts}_${mode}_req.json / ${basename(rawPath)} / transcript.md`);
});
