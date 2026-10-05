// 自动生成新版本号并写入 index.html / app.js，让浏览器与 CDN 自动取新版静态文件
const fs = require("fs");
const path = require("path");

const d = new Date();
const p = (n) => String(n).padStart(2, "0");
const v =
  String(d.getFullYear()) +
  p(d.getMonth() + 1) +
  p(d.getDate()) +
  p(d.getHours()) +
  p(d.getMinutes());

const files = [
  { f: "public/index.html", re: /app\.js\?v=[A-Za-z0-9]+/g, to: `app.js?v=${v}` },
  { f: "public/app.js", re: /const VERSION = "[^"]*"/g, to: `const VERSION = "${v}"` },
];

for (const { f, re, to } of files) {
  const fp = path.join(__dirname, f);
  let s = fs.readFileSync(fp, "utf8");
  if (!re.test(s)) {
    console.error(`[bump] 未匹配到版本号：${f}`);
    process.exit(1);
  }
  s = s.replace(re, to);
  fs.writeFileSync(fp, s, "utf8");
}

console.log(`[bump] version = ${v}`);
