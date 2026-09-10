// 从 JSON 备份恢复书签数据到 Cloudflare KV
// 用法：
//   node restore.example.mjs <备份文件.json>           仅预览（不写入，默认）
//   node restore.example.mjs <备份文件.json> --yes     真正写入
//
// 凭据通过环境变量传入（不要写死在文件里）：
//   CF_ACCOUNT_ID   你的 Cloudflare 账户 ID
//   CF_KV_NS        你的 BOOKMARKS KV 命名空间 ID
//   CF_EMAIL        登录邮箱
//   CF_GLOBAL_KEY   全局 API 密钥（X-Auth-Key 方式）
import fs from "node:fs";

const ACC = process.env.CF_ACCOUNT_ID;
const NS = process.env.CF_KV_NS;
const H = {
  "X-Auth-Email": process.env.CF_EMAIL,
  "X-Auth-Key": process.env.CF_GLOBAL_KEY,
  "Content-Type": "application/json",
};

if (!ACC || !NS || !H["X-Auth-Key"]) {
  console.error("请先设置环境变量：CF_ACCOUNT_ID / CF_KV_NS / CF_EMAIL / CF_GLOBAL_KEY");
  process.exit(1);
}

const src = process.argv[2];
const write = process.argv.includes("--yes");

if (!src || !fs.existsSync(src)) {
  console.error("用法: node restore.example.mjs <备份文件.json> [--yes]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(src, "utf8"));
const keys = Object.entries(data.keys || {});
console.log(`备份时间: ${data.exported_at}`);
console.log(`待恢复: ${keys.length} 个键，模式: ${write ? "写入" : "预览"}\n`);

const base = `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}`;

for (const [k, v] of keys) {
  const body = typeof v === "string" ? v : JSON.stringify(v);
  if (!write) {
    console.log(`  [预览] ${k}  ${(body.length / 1024).toFixed(1)} KB`);
    continue;
  }
  const r = await fetch(`${base}/values/${encodeURIComponent(k)}`, { method: "PUT", headers: H, body });
  console.log(`  ${r.ok ? "[OK]  " : "[FAIL]"} ${k}`);
}

if (!write) console.log("\n确认无误后加 --yes 参数执行写入。");
else console.log("\n恢复完成。若密码也被覆盖，请用备份里的密码登录。");
