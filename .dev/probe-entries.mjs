import { readFileSync } from "node:fs"
const HARNESS = "S:/app/dsh/resources/app.asar/dsh/node_modules"
function entryOf(name) {
  const base = `${HARNESS}/${name}`
  const manifest = JSON.parse(readFileSync(`${base}/package.json`, "utf8"))
  const dot = manifest.exports?.["."]
  const target = typeof dot === "string" ? dot : typeof dot?.default === "string" ? dot.default : typeof dot?.import === "string" ? dot.import : manifest.main ?? "lib/index.js"
  return `file:///${base}/${target.replace(/^\.\//u, "")}`
}
for (const n of ["@deepseek-ai/cordis","@deepseek-ai/dsh-system-prompt","@deepseek-ai/dsh-tools"]) {
  try { console.log(n, "->", entryOf(n)) } catch (e) { console.log(n, "ERR", e.message) }
}
