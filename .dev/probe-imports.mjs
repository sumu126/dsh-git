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
    const rest = parts.slice(2)
    if (rest.length === 0) {
      try { return { url: entryOf(name), shortCircuit: true } } catch { return nextResolve(specifier, context) }
    }
    const file = rest.join("/").replace(/\.ts$/u, ".js").replace(/^src\//u, "")
    for (const candidate of [`${HARNESS}/${name}/lib/types/${file}`, `${HARNESS}/${name}/lib/${file}`, `${HARNESS}/${name}/${file}`]) {
      try { readFileSync(candidate); console.log("subpath", specifier, "=>", candidate); return { url: `file:///${candidate}`, shortCircuit: true } } catch {}
    }
    console.log("subpath-miss", specifier)
    return nextResolve(specifier, context)
  },
})
async function step(label, fn) { try { const v = await fn(); console.log("ok", label); return v } catch (e) { console.log("FAIL", label, e.code, e.message); process.exit(1) } }
const { Context } = await step("cordis", () => import(entryOf("@deepseek-ai/cordis")))
const SystemPrompt = await step("system-prompt", async () => (await import(entryOf("@deepseek-ai/dsh-system-prompt"))).default)
const { ToolRuntime } = await step("dsh-tools", () => import(entryOf("@deepseek-ai/dsh-tools")))
const { validateJsonSchemaValue } = await step("json-schema", () => import(`${HARNESS}/@deepseek-ai/dsh-tools/lib/types/json-schema.js`))
const plugin = await step("plugin", () => import("file:///S:/dev/DSH/dsh-git/lib/index.js"))
console.log("all imports ok", typeof Context, typeof ToolRuntime, typeof plugin.apply)
process.exit(0)
