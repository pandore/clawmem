/**
 * OpenClaw memory-recall plugin — auto-injects lizardbrain search results into agent context.
 *
 * Uses the programmatic API (require('lizardbrain')) instead of shelling out.
 * Requires: npm install lizardbrain
 *
 * Setup:
 *   1. Create plugin directory: ~/.openclaw/extensions/memory-recall/
 *   2. Copy this file as index.ts (or openclaw-plugin.ts)
 *   3. Copy openclaw.plugin.json to the same directory
 *   4. Create package.json in the same directory (see openclaw-plugin-package.json):
 *        { "name": "memory-recall", "version": "0.6.0", "type": "module", "main": "openclaw-plugin.ts" }
 *   5. Run: npm install lizardbrain
 *   6. Register in openclaw.json (NOT in plugins.installs — that causes silent skipping):
 *        {
 *          "plugins": {
 *            "allow": ["memory-recall"],
 *            "entries": { "memory-recall": { "enabled": true } }
 *          }
 *        }
 *
 * IMPORTANT: Do NOT use plugins.installs with source: "path" — it silently skips the plugin.
 *            Only use plugins.allow + plugins.entries for local plugins.
 *
 * Recommended integration pattern (two layers):
 *   1. STATIC (refreshed daily): inject `lizardbrain roster` into system prompt
 *      Example:
 *        const lizardbrain = require('lizardbrain');
 *        const driver = lizardbrain.createDriver(dbPath);
 *        const roster = lizardbrain.query.generateRoster(driver);
 *        // inject roster.content into system prompt
 *
 *   2. DYNAMIC (per-turn, this plugin): inject `lizardbrain search` results
 *      → gives agent contextual facts relevant to the current conversation
 */

const SKIP = [/^.{0,15}$/, /^(hi|hey|gm|gn|ok|lol|haha|thanks|wow)$/i];

const plugin = {
  id: "memory-recall",
  name: "Memory Recall",
  register(api: any) {
    const dbPath = api.getConfig?.()?.lizardbrainDbPath || process.env.LIZARDBRAIN_DB_PATH || "./lizardbrain.db";
    const maxResults = api.getConfig?.()?.maxResults ?? 5;

    // Lazy-load lizardbrain to avoid startup penalty when plugin is disabled
    let lb: any = null;
    let driver: any = null;

    function getDriver() {
      if (!driver) {
        lb = require("lizardbrain");
        if (!lb.dbExists(dbPath)) return null;
        driver = lb.createDriver(dbPath);
        lb.migrate(driver);
      }
      return driver;
    }

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      try {
        if (ctx.chatType === "direct" || ctx.chatType === "dm") return {};
        const messages = event.messages || [];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user") return {};

        const text = typeof last.content === "string" ? last.content
          : last.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") || "";
        if (text.length < 20 || SKIP.some((p: RegExp) => p.test(text))) return {};

        const query = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim().slice(0, 200);
        if (query.length < 15) return {};

        const drv = getDriver();
        if (!drv) return {};

        const result = await lb.search(drv, query, { limit: maxResults });
        if (!result.results?.length) return {};

        const formatted = result.results
          .map((r: any) => `- [${r.source}] ${(r.text || "").slice(0, 300)}`)
          .join("\n");

        return {
          prependContext: `[Memory context — related community knowledge. Use naturally if relevant.]\n${formatted}\n[/Memory context]`,
        };
      } catch { return {}; }
    }, { priority: 5 });
  },
};

export default plugin;
