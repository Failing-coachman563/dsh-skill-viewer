/**
 * dsh-webui-skills-viewer - shared skill-file conventions.
 *
 * The single source of truth for how skills live on disk, shared by:
 *   - lib/index.js (host half: catalog merge, hot enable/disable, delete, add)
 *   - bin/dsh-skills.js (management CLI)
 *
 * Conventions (must match what @deepseek-ai/dsh-skill-filesystem discovers):
 *   - directory bundle:  <root>/<name>/SKILL.md   (name comes from frontmatter)
 *   - flat skill:        <root>/<name>.md          (name comes from frontmatter)
 *   - disabled = renamed to "*.disabled"; the provider then no longer lists it.
 *   - frontmatter: YAML block between "---" lines with name + description.
 *
 * This module is dependency-free (node:fs / node:path / node:os only).
 */
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Suffix marking a hot-disabled skill file. */
export const DISABLED_SUFFIX = ".disabled";

/** The public skill-name grammar (kebab-case, lowercase alphanumerics). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a filesystem path exists. */
export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The project anchor: nearest ancestor containing .git, else the cwd itself. */
export async function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/**
 * Lenient frontmatter read for listing/scanning (name + description + body).
 * Returns undefined when the file is not a plausible skill.
 */
export function parseFrontmatter(raw) {
  const text = raw.trimStart();
  if (!text.startsWith("---")) return undefined;
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1) return undefined;
  const closing = text.indexOf("\n---", firstEnd + 1);
  const fmEnd = closing === -1 ? text.length : closing;
  const fm = text.slice(3, fmEnd);
  let body = "";
  if (closing !== -1) {
    const at = text.indexOf("\n", closing + 3);
    if (at !== -1) body = text.slice(at + 1);
  }
  const pick = (key) => {
    const m = new RegExp("^" + key + ":\\s*(.+)$", "m").exec(fm);
    if (m === null) return undefined;
    const value = m[1].trim();
    return value.replace(/^["']|["']$/g, "");
  };
  const name = pick("name");
  if (name === undefined || !SKILL_NAME_RE.test(name)) return undefined;
  return { name, description: pick("description") ?? "", whenToUse: pick("whenToUse"), body: body.trim() };
}

/**
 * Strict frontmatter validation for NEW skills, mirroring the acceptance
 * rules of dsh-skill-filesystem so that invalid content is rejected before
 * anything is written:
 *   - name: required, kebab-case grammar
 *   - description: required, non-empty
 *   - whenToUse: string when present
 *   - disable-model-invocation / user-invocable: boolean-ish values
 *   - legacy invocation keys are rejected
 *   - metadata: object when present
 * @returns { ok: true, skill } or { ok: false, error } with a readable reason.
 */
export function validateFrontmatter(raw) {
  const text = raw.trimStart();
  if (!text.startsWith("---")) return { ok: false, error: "缺少 YAML frontmatter（文件必须以 --- 开头）" };
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1) return { ok: false, error: "frontmatter 未闭合" };
  const closing = text.indexOf("\n---", firstEnd + 1);
  const fmEnd = closing === -1 ? text.length : closing;
  const fm = text.slice(3, fmEnd);
  const lines = fm.split("\n");
  let name;
  let description;
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else if (key === "metadata" && value !== "" && !value.startsWith("{") && !value.startsWith("[")) return { ok: false, error: "metadata 必须是对象" };
    else if (["disableModelInvocation", "modelInvocable", "userInvocable"].includes(key)) return { ok: false, error: '不支持旧字段 "' + key + '"，请改用 disable-model-invocation / user-invocable' };
    else if (key === "disable-model-invocation" || key === "user-invocable") {
      const lower = String(value).toLowerCase();
      if (!["true", "false", "yes", "no", "on", "off", "1", "0"].includes(lower)) return { ok: false, error: key + " 必须是布尔值" };
    }
  }
  if (typeof name !== "string" || name.length === 0) return { ok: false, error: "frontmatter 缺少 name" };
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: '技能名 "' + name + '" 不符合命名规则（仅小写字母、数字与连字符，如 my-skill）' };
  if (typeof description !== "string" || description.length === 0) return { ok: false, error: "frontmatter 缺少 description" };
  const pick = (key) => {
    const m = new RegExp("^" + key + ":\\s*(.+)$", "m").exec(fm);
    return m === null ? undefined : m[1].trim().replace(/^["']|["']$/g, "");
  };
  return { ok: true, skill: { name, description, whenToUse: pick("whenToUse"), body: "" } };
}

/**
 * The management roots: project roots (anchored at the git root of cwd) and
 * user roots. Order = discovery precedence (lower index wins), matching the
 * provider ranks: project .dsh > project .agents > user .dsh > user .agents.
 */
export async function buildRoots(cwd, options = {}) {
  const roots = [];
  if (cwd !== undefined) {
    const project = await findProjectRoot(cwd);
    roots.push({ path: join(project, ".dsh", "skills"), source: "project-dsh" });
    roots.push({ path: join(project, ".agents", "skills"), source: "project-agents" });
  }
  if (options.dshHome !== undefined) roots.push({ path: join(options.dshHome, "skills"), source: "user-dsh" });
  if (options.agentsHome !== undefined) roots.push({ path: join(options.agentsHome, "skills"), source: "user-agents" });
  return roots;
}

/**
 * Collect every skill entry (enabled + disabled, bundles + flat files) under
 * the given roots. Unknown/invalid entries fall back to a name derived from
 * the directory/file name and are still reported (disabled ones must stay
 * manageable).
 */
export async function collectSkillEntries(roots) {
  const entries = [];
  for (const root of roots) {
    let items;
    try {
      items = await readdir(root.path, { withFileTypes: true });
    } catch {
      continue; // absent root
    }
    for (const item of items) {
      if (item.isDirectory()) {
        const md = join(root.path, item.name, "SKILL.md");
        const disabled = md + DISABLED_SUFFIX;
        if (await pathExists(md)) {
          const parsed = parseFrontmatter(await readFile(md, "utf8").catch(() => ""));
          entries.push({ name: parsed?.name ?? item.name, description: parsed?.description ?? "", whenToUse: parsed?.whenToUse, enabled: true, kind: "bundle", file: md, dirBundle: true, source: root.source });
        } else if (await pathExists(disabled)) {
          const parsed = parseFrontmatter(await readFile(disabled, "utf8").catch(() => ""));
          entries.push({ name: parsed?.name ?? item.name, description: parsed?.description ?? "", whenToUse: parsed?.whenToUse, enabled: false, kind: "bundle", file: disabled, dirBundle: true, source: root.source });
        }
      } else if (item.isFile()) {
        if (item.name.endsWith(".md" + DISABLED_SUFFIX)) {
          const file = join(root.path, item.name);
          const parsed = parseFrontmatter(await readFile(file, "utf8").catch(() => ""));
          entries.push({ name: parsed?.name ?? item.name.slice(0, -(".md" + DISABLED_SUFFIX).length), description: parsed?.description ?? "", whenToUse: parsed?.whenToUse, enabled: false, kind: "flat", file, dirBundle: false, source: root.source });
        } else if (item.name.endsWith(".md")) {
          const file = join(root.path, item.name);
          const parsed = parseFrontmatter(await readFile(file, "utf8"));
          entries.push({ name: parsed?.name ?? item.name.slice(0, -3), description: parsed?.description ?? "", whenToUse: parsed?.whenToUse, enabled: true, kind: "flat", file, dirBundle: false, source: root.source });
        }
      }
    }
  }
  return entries;
}

/**
 * The winning entry for a skill name: the first one in root order (the same
 * precedence the gateway's registry applies).
 */
export function winnerEntry(entries, name) {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  return matches[0];
}

/** Stable numeric rank for one root source (lower = higher precedence). */
export function sourceRank(source) {
  switch (source) {
    case "project-dsh": return 1;
    case "project-agents": return 2;
    case "user-dsh": return 3;
    case "user-agents": return 4;
    default: return 9;
  }
}
