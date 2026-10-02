import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const norm = (s) => s.replace(/\s+/g, " ").trim();
// An app with nothing to preload (kv/none storage, or no bounded first read)
// declares no `preload`; the checks below then hold vacuously until it adds one.
const preload = manifest.preload ?? {};

// The hub runs `manifest.preload` while rendering the document and answers the
// app's matching api/db request from the embedded rows — matching on the
// statement text with whitespace collapsed. A drifted copy is not an error
// anywhere: it is a preload that silently never answers. So the manifest is
// checked against the source here.
describe("manifest.preload mirrors the app's first-render reads", () => {
  const body = norm(html);
  const prefix = `app_${manifest.id.replace(/-/g, "_")}__`;

  it("declares statements the app posts, byte-for-byte after whitespace collapse", () => {
    for (const [name, { sql }] of Object.entries(preload)) {
      expect(body.includes(norm(sql)), `preload.${name} is not the text src/index.html posts`).toBe(true);
    }
  });

  it("stays within the hub's caps and reads only this app's tables", () => {
    expect(Object.keys(preload).length).toBeLessThanOrEqual(6);
    for (const [name, { sql, params = [] }] of Object.entries(preload)) {
      expect(sql, name).toMatch(/^(SELECT|WITH) /);
      expect(sql, name).not.toMatch(/;|--/);
      for (const table of sql.match(/(?:FROM|JOIN)\s+(\w+)/g) ?? []) expect(table, name).toMatch(new RegExp(`\\s${prefix}`));
      expect((sql.match(/\?/g) ?? []).length, `${name}: placeholders vs params`).toBe(params.length);
    }
  });
});
