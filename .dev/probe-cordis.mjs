import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
const HARNESS = "S:/app/dsh/resources/app.asar/dsh/node_modules"
function entryOf(name) {
  const base = `${HARNESS}/${name}`
  const manifest = JSON.parse(readFileSync(`${base}/package.json`, "utf8"))
  const dot = manifest.exports?.["."]
  const target = typeof dot === "string" ? dot : typeof dot?.default === "string" ? dot.default : typeof dot?.import === "string" ? dot.import : manifest.main ?? "lib/index.js"
  return `file:///${base}/${target.replace(/^\.\//u, "")}`
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@deepseek-ai/")) return nextResolve(specifier, context)
    const parts = specifier.split("/")
    const name = `${parts[0]}/${parts[1]}`
    if (parts.length === 2) {
      try { const url = entryOf(name); console.log("resolve", specifier, "=>", url); return { url, shortCircuit: true } }
      catch (e) { console.log("resolve-miss", specifier, e.message); return nextResolve(specifier, context) }
    }
    return nextResolve(specifier, context)
  },
})
try {
  const cordis = await import(entryOf("@deepseek-ai/cordis"))
  console.log("cordis ok", typeof cordis.Context)
} catch (e) {
  console.log("FAILED", e.code, e.message)
}
process.exit(0)
