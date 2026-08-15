import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  DISABLED_SUFFIX,
  collectSkillEntries,
  findProjectRoot,
  pathExists,
  validateFrontmatter,
  winnerEntry
} from "./skill-files.js";
import {
  batchMigrateEntries,
  migrateEntry,
  normalizeWorkspace,
  scopeRootOf,
  workspaceSkillRoot
} from "./scope.js";

/**
 * dsh-skill-viewer - host half.
 *
 * A Typert Remote service ("skillsViewer") exposing the skill catalog and hot
 * management operations: enable/disable (rename to/from *.disabled), delete,
 * add (import a skill bundle or flat markdown file), and migration between
 * scopes.
 *
 * Entity model (0.3.0): a skill's files live directly in the skill folder of
 * its scope — the global user root (~/.dsh/skills) or a workspace's project
 * root (<workspace>/.dsh/skills). There is no central store, no junction and
 * no plugin-private state: what a session sees is exactly what the
 * skill-filesystem provider discovers in its roots. The watcher picks every
 * change up within ~200ms, so none of these operations require a restart.
 */
export const name = "skills-viewer";
export const inject = ["typert", "skills", "sessions", "agents"];

// ── wire schemas (zod v4) ────────────────────────────────────────────────────

const sessionIdSchema = z.string().optional();

const scopeSchema = z.object({
  kind: z.enum(["global", "workspace"]),
  path: z.string().optional(),
  label: z.string().optional()
});

const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  provider: z.string(),
  source: z.string(),
  enabled: z.boolean(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  scope: scopeSchema.optional()
});

const listResultSchema = z.object({ skills: z.array(skillSummarySchema) });

const workspacesResultSchema = z.object({
  workspaces: z.array(z.object({ path: z.string(), label: z.string(), sessions: z.number() }))
});

const resourceBaseSchema = z
  .object({
    kind: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional()
  })
  .optional();

const skillContentSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    content: z.string(),
    provider: z.string(),
    whenToUse: z.string().optional(),
    path: z.string().optional(),
    resourceBase: resourceBaseSchema
  })
  .nullable();

const setEnabledResultSchema = z.object({ name: z.string(), enabled: z.boolean() });

const deleteSkillResultSchema = z.object({ name: z.string() });

const migratePayloadSchema = z.object({
  target: z.string().nullable(),
  mode: z.enum(["copy", "move"])
});
const migrateResultSchema = z.object({ name: z.string(), scope: scopeSchema });

const batchMigratePayloadSchema = z.object({
  from: z.string().nullable(),
  targets: z.array(z.string().nullable()).min(1),
  mode: z.enum(["copy", "move"]),
  names: z.array(z.string())
});
const batchMigrateResultSchema = z.object({
  results: z.array(z.object({ name: z.string(), target: z.string().nullable().optional(), ok: z.boolean(), error: z.string().optional() }))
});

const addFileSchema = z.object({ path: z.string(), base64: z.string() });
const addPayloadSchema = z.object({
  kind: z.enum(["bundle", "flat"]),
  files: z.array(addFileSchema).min(1),
  workspace: z.string().nullable().optional()
});
const addResultSchema = z.object({ name: z.string(), kind: z.enum(["bundle", "flat"]), scope: scopeSchema });

/** Typed wire descriptors registered with the API gateway. */
const MANIFEST = {
  package: "dsh-skill-viewer",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-skill-viewer#skillsViewer/list",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillListResult", schema: listResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/workspaces",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "workspaces",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#WorkspacesResult", schema: workspacesResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/content",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "content",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillContent", schema: skillContentSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/setEnabled",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "setEnabled",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } },
        { name: "enabled", wire: "enabled", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#EnabledFlag", schema: z.boolean() } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#SetEnabledResult", schema: setEnabledResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/migrate",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "migrate",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } },
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#MigratePayload", schema: migratePayloadSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#MigrateResult", schema: migrateResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/batchMigrate",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "batchMigrate",
      invocation: { kind: "direct" },
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } },
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#BatchMigratePayload", schema: batchMigratePayloadSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#BatchMigrateResult", schema: batchMigrateResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/deleteSkill",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "deleteSkill",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#DeleteSkillResult", schema: deleteSkillResultSchema }
    },
    {
      id: "dsh-skill-viewer#skillsViewer/addSkill",
      service: "skillsViewer",
      namespace: "skillsViewer",
      method: "addSkill",
      invocation: { kind: "direct" },
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#sessionId", schema: sessionIdSchema } },
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-viewer#AddPayload", schema: addPayloadSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-viewer#AddResult", schema: addResultSchema }
    }
  ],
  model: { services: [], events: [], objects: [] }
};

/** Guard rails for browser-uploaded bundles. */
const MAX_ADD_FILES = 200;
const MAX_ADD_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * The remote service instance. Constructing it registers the "skillsViewer"
 * cordis service; the manifest above lets the API gateway dispatch endpoints.
 */
class SkillsViewerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "skillsViewer");
  }

  /** Untyped access to the dynamic harness context (sessions/agents/typert). */
  get C() {
    return this.ctx as any;
  }

  // ── catalog resolution (mirrors the host api-proxy skill.list) ─────────────

  registryFor(sessionId) {
    const live = sessionId === undefined ? undefined : this.C.agents.get(sessionId);
    if (live !== undefined) {
      const scoped = this.C.get("agentPresets")?.serviceFor(live, "skills");
      if (scoped !== undefined) return scoped;
    }
    return this.C.skills;
  }

  viewFor(sessionId) {
    const registry = this.registryFor(sessionId);
    const session = sessionId === undefined ? undefined : this.C.sessions.get(sessionId);
    const scope = sessionId === undefined ? undefined : this.C.agents.get(sessionId);
    return { registry, cwd: session?.header?.cwd, scope };
  }

  homes() {
    return {
      dshHome: resolveDshHome(),
      agentsHome: resolvePath(process.env.DSH_AGENTS_HOME?.trim() ? process.env.DSH_AGENTS_HOME : join(homedir(), ".agents"))
    };
  }

  /** Whether a candidate path lives inside a base directory. */
  isWithin(baseDir, candidate) {
    if (typeof candidate !== "string" || candidate === "") return false;
    const base = resolvePath(baseDir);
    const value = resolvePath(candidate);
    if (value === base) return true;
    const b = process.platform === "win32" ? base.toLowerCase() : base;
    const v = process.platform === "win32" ? value.toLowerCase() : value;
    const sep = process.platform === "win32" ? "\\" : "/";
    return v.startsWith(b.endsWith(sep) ? b : b + sep);
  }

  /** Every management root: user roots + one project pair per known workspace. */
  async allRoots() {
    const { dshHome, agentsHome } = this.homes();
    const roots: any[] = [];
    const seen = new Set();
    const push = (path, source, projectRoot) => {
      const normalized = resolvePath(path);
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) return;
      seen.add(key);
      roots.push({ path, source, projectRoot });
    };
    push(join(dshHome, "skills"), "user-dsh", undefined);
    push(join(agentsHome, "skills"), "user-agents", undefined);
    for (const workspace of (await this.workspaces()).workspaces) {
      push(join(workspace.path, ".dsh", "skills"), "project-dsh", workspace.path);
      push(join(workspace.path, ".agents", "skills"), "project-agents", workspace.path);
    }
    return roots;
  }

  /** All file-level entries across user roots and every known workspace. */
  async fileEntriesAll() {
    return collectSkillEntries(await this.allRoots());
  }

  /** The project root owning a registry skill path, when it is a workspace file. */
  workspaceOfPath(path, roots) {
    if (typeof path !== "string" || path === "") return undefined;
    for (const root of roots) {
      if (root.projectRoot === undefined) continue;
      if (this.isWithin(root.path, path)) return root.projectRoot;
    }
    return undefined;
  }

  scopeForEntry(entry) {
    if (entry.projectRoot !== undefined) return { kind: "workspace", path: entry.projectRoot, label: basename(entry.projectRoot) || entry.projectRoot };
    return { kind: "global" };
  }

  scopeForTarget(targetRoot, targetProject) {
    const { dshHome } = this.homes();
    if (resolvePath(targetRoot) === resolvePath(join(dshHome, "skills"))) return { kind: "global" };
    return { kind: "workspace", path: targetProject, label: basename(targetProject) || targetProject };
  }

  // ── remote methods ─────────────────────────────────────────────────────────

  /** The catalog: registry skills (global) + every file entry tagged by scope. */
  async list(sessionId) {
    const { registry, cwd, scope } = this.viewFor(sessionId);
    const roots = await this.allRoots();
    const listed = await registry.list({ cwd, scope });
    const skills: any[] = [];
    // Dedupe by (name, scope) — not by name alone: the same skill may exist
    // both globally and inside a workspace, and each row must stay visible
    // under its own scope chip.
    const seen = new Set();
    const seenKey = (name, scopePath) => name + "\u0000" + (scopePath ?? "global");
    for (const skill of listed) {
      // Workspace file skills are covered by the file scan below; the
      // registry row only reflects the current session's project view.
      if (this.workspaceOfPath(skill.path, roots) !== undefined) continue;
      const source = skill.source ?? (skill.provider === "runtime" ? "runtime" : "");
      skills.push({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        provider: skill.provider,
        source,
        enabled: true,
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
        scope: { kind: "global" }
      });
      seen.add(seenKey(skill.name, "global"));
    }
    for (const entry of await collectSkillEntries(roots)) {
      const scopePath = entry.projectRoot ?? "global";
      if (seen.has(seenKey(entry.name, scopePath))) continue;
      seen.add(seenKey(entry.name, scopePath));
      skills.push({
        name: entry.name,
        description: entry.description,
        ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
        provider: "filesystem",
        source: entry.source,
        enabled: entry.enabled,
        modelInvocable: false,
        userInvocable: false,
        scope: this.scopeForEntry(entry)
      });
    }
    return { skills };
  }

  /** Distinct project roots of all known workspaces (for the scope bar). */
  async workspaces() {
    const map = new Map();
    const keyOf = (path) => process.platform === "win32" ? path.toLowerCase() : path;
    const add = async (path, label, sessions) => {
      if (typeof path !== "string" || path === "") return;
      let project;
      try {
        project = await findProjectRoot(resolvePath(path));
      } catch {
        return;
      }
      const key = keyOf(project);
      if (map.has(key)) return;
      map.set(key, { path: project, label: label || basename(project) || project, sessions: sessions ?? 0 });
    };
    try {
      const registry = this.C.get("workspaceRegistry");
      if (registry !== undefined && typeof registry.list === "function") {
        for (const workspace of registry.list()) {
          try {
            if ((await workspace.status()) !== "ok") continue;
          } catch {
            // status probe unavailable: keep the record
          }
          await add(workspace.path, workspace.title, Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0);
        }
      }
    } catch {
      // registry unavailable: fall back to live sessions below
    }
    try {
      for (const session of this.C.sessions.list()) {
        const cwd = session.header?.cwd;
        if (cwd === undefined || cwd === "") continue;
        await add(resolvePath(cwd), undefined, 1);
      }
    } catch {
      // session listing unavailable: empty picker
    }
    return { workspaces: [...map.values()].sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path)) };
  }

  /** Locate a skill: live registry row, plain file entry, or missing. */
  async locate(name, sessionId) {
    const { registry, cwd, scope } = this.viewFor(sessionId);
    const skill = await registry.get(name, { cwd, scope });
    if (skill !== undefined && this.workspaceOfPath(skill.path, await this.allRoots()) === undefined) return { kind: "live", skill };
    const entry = winnerEntry(await this.fileEntriesAll(), name);
    if (entry !== undefined) return { kind: "file", entry };
    return { kind: "missing" };
  }

  /** Full body: the registry definition, or the raw skill file on disk. */
  async content(name, sessionId) {
    const located = await this.locate(name, sessionId);
    if (located.kind === "missing") return null;
    if (located.kind === "file") {
      const raw = await readFile(located.entry.file, "utf8");
      return {
        name: located.entry.name,
        description: located.entry.description,
        content: raw,
        provider: "filesystem",
        path: located.entry.file
      };
    }
    const skill = located.skill;
    return {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      provider: skill.provider,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      ...(skill.path === undefined ? {} : { path: skill.path }),
      ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase })
    };
  }

  assertEditable(skill) {
    if (skill.source === "bundled") throw new Error('技能 "' + skill.name + '" 随部署附带，不可修改');
    if (typeof skill.path !== "string" || skill.path.length === 0) throw new Error('技能 "' + skill.name + '" 没有可修改的文件');
  }

  /** Hot enable/disable: rename the skill file to/from *.disabled in place. */
  async setEnabled(name, sessionId, enabled) {
    const located = await this.locate(name, sessionId);
    if (located.kind === "missing") throw new Error('技能 "' + name + '" 不存在');
    if (located.kind === "live") {
      const skill = located.skill;
      this.assertEditable(skill);
      if (enabled) return { name, enabled: true };
      const target = skill.path + DISABLED_SUFFIX;
      if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
      await rename(skill.path, target);
      return { name, enabled: false };
    }
    const entry = located.entry;
    if (enabled === entry.enabled) return { name, enabled };
    const target = enabled ? entry.file.slice(0, -DISABLED_SUFFIX.length) : entry.file + DISABLED_SUFFIX;
    if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
    await rename(entry.file, target);
    return { name, enabled };
  }

  /** Delete a skill permanently (bundle directories remove the whole dir). */
  async deleteSkill(name, sessionId) {
    const located = await this.locate(name, sessionId);
    if (located.kind === "missing") throw new Error('技能 "' + name + '" 不存在');
    if (located.kind === "live") {
      const skill = located.skill;
      this.assertEditable(skill);
      if (basename(skill.path) === "SKILL.md") await rm(dirname(skill.path), { recursive: true, force: true });
      else await rm(skill.path, { force: true });
      return { name };
    }
    const entry = located.entry;
    if (entry.dirBundle) await rm(dirname(entry.file), { recursive: true, force: true });
    else await rm(entry.file, { force: true });
    return { name };
  }

  /** The entry (or user-root live skill) that migration may move around. */
  async migratableEntry(name, sessionId) {
    const entry = winnerEntry(await this.fileEntriesAll(), name);
    if (entry !== undefined) return entry;
    const located = await this.locate(name, sessionId);
    if (located.kind !== "live") return undefined;
    const skill = located.skill;
    if (typeof skill.path !== "string" || skill.path === "") return undefined;
    const { dshHome, agentsHome } = this.homes();
    const userRoots = [join(dshHome, "skills"), join(agentsHome, "skills")];
    if (!userRoots.some((root) => this.isWithin(root, skill.path))) return undefined;
    this.assertEditable(skill);
    return { name: skill.name, file: skill.path, dirBundle: basename(skill.path) === "SKILL.md", enabled: true, source: skill.source ?? "user-dsh" };
  }

  /** Move or copy one skill into another scope folder. */
  async migrate(name, sessionId, payload) {
    const { target: rawTarget, mode } = payload;
    const { dshHome } = this.homes();
    const targetProject = rawTarget === null || rawTarget === undefined ? null : await normalizeWorkspace(rawTarget);
    const targetRoot = scopeRootOf(targetProject, dshHome);
    const entry = await this.migratableEntry(name, sessionId);
    if (entry === undefined) throw new Error('技能 "' + name + '" 没有可迁移的文件（随部署附带或运行时内置的技能不可迁移）');
    await migrateEntry(entry, targetRoot, mode);
    return { name, scope: this.scopeForTarget(targetRoot, targetProject) };
  }

  /** Migrate a batch of skills into one or more target scopes; per-item results. */
  async batchMigrate(sessionId, payload) {
    const { from: rawFrom, targets: rawTargets, mode, names } = payload;
    if (mode === "move" && rawTargets.length > 1) throw new Error("移动模式只能选择一个目标作用域（多个目标请改用复制）");
    const { dshHome, agentsHome } = this.homes();
    const fromProject = rawFrom === null || rawFrom === undefined ? null : await normalizeWorkspace(rawFrom);
    const fromRoots = fromProject === null
      ? [{ path: join(dshHome, "skills"), source: "user-dsh" }, { path: join(agentsHome, "skills"), source: "user-agents" }]
      : [{ path: workspaceSkillRoot(fromProject), source: "project-dsh", projectRoot: fromProject }];

    const byName = new Map();
    for (const entry of await collectSkillEntries(fromRoots)) if (!byName.has(entry.name)) byName.set(entry.name, entry);
    const chosen: any[] = [];
    const results: any[] = [];
    for (const name of names) {
      const entry = byName.get(name);
      if (entry === undefined) results.push({ name, ok: false, error: '技能 "' + name + '" 不在源作用域中' });
      else chosen.push(entry);
    }
    for (const rawTarget of rawTargets) {
      const targetProject = rawTarget === null || rawTarget === undefined ? null : await normalizeWorkspace(rawTarget);
      const targetRoot = scopeRootOf(targetProject, dshHome);
      if (fromRoots.some((root) => resolvePath(root.path) === resolvePath(targetRoot))) {
        for (const entry of chosen) results.push({ name: entry.name, target: rawTarget ?? null, ok: false, error: "目标作用域与源作用域相同" });
        continue;
      }
      for (const item of await batchMigrateEntries(chosen, targetRoot, mode)) {
        results.push({ name: item.name, target: rawTarget ?? null, ok: item.ok, ...(item.error === undefined ? {} : { error: item.error }) });
      }
    }
    return { results };
  }

  /**
   * Import a new skill directly into a scope folder:
   *   workspace absent/null → the global user root
   *   workspace given     → <workspaceProjectRoot>/.dsh/skills
   * Frontmatter is validated before writing; afterwards the registry is
   * polled to confirm DSH accepted the skill — otherwise the files are
   * rolled back and the rejection is reported.
   */
  async addSkill(sessionId, payload) {
    const { kind, files, workspace: rawWorkspace } = payload;
    if (files.length > MAX_ADD_FILES) throw new Error("文件数量过多（最多 " + MAX_ADD_FILES + " 个）");
    const decoded = files.map((file) => {
      const data = Buffer.from(file.base64, "base64");
      if (data.length === 0 && file.base64.length > 0) throw new Error("文件内容解码失败：" + file.path);
      return { path: file.path.replaceAll("\\", "/"), data };
    });
    if (decoded.reduce((sum, file) => sum + file.data.length, 0) > MAX_ADD_TOTAL_BYTES) throw new Error("技能总大小超过 8MB 上限");

    // Reject unsafe relative paths up front.
    for (const file of decoded) {
      if (file.path.startsWith("/") || file.path.split("/").some((segment) => segment === ".." || segment === ".")) throw new Error("非法文件路径：" + file.path);
    }

    const { dshHome } = this.homes();
    let targetProject;
    let targetRoot;
    if (rawWorkspace === undefined || rawWorkspace === null || rawWorkspace === "") {
      targetRoot = join(dshHome, "skills");
    } else {
      targetProject = await normalizeWorkspace(rawWorkspace);
      targetRoot = workspaceSkillRoot(targetProject);
    }

    // Determine the canonical skill name and the files to write.
    let name;
    let writes;
    if (kind === "bundle") {
      const tops = new Set(decoded.map((file) => file.path.split("/")[0]));
      if (tops.size !== 1 || decoded.some((file) => file.path.split("/").length < 2)) throw new Error("技能文件夹结构不正确：所有文件应位于同一个文件夹内");
      const top = [...tops][0] as string;
      const skillFile = decoded.find((file) => file.path === top + "/SKILL.md");
      if (skillFile === undefined) throw new Error("技能文件夹缺少顶层的 SKILL.md 文件");
      const validation = validateFrontmatter(skillFile.data.toString("utf8"));
      if (!validation.ok) throw new Error("技能格式不符合要求：" + validation.error);
      name = validation.skill.name;
      writes = decoded.map((file) => ({ relative: file.path.slice(top.length + 1), data: file.data }));
    } else {
      if (decoded.length !== 1) throw new Error("单个技能文件一次只能添加一个");
      const file = decoded[0];
      const flatName = file.path.split("/").filter(Boolean).pop() ?? "";
      if (!flatName.toLowerCase().endsWith(".md")) throw new Error("技能文件必须是 .md 文件");
      const validation = validateFrontmatter(file.data.toString("utf8"));
      if (!validation.ok) throw new Error("技能格式不符合要求：" + validation.error);
      name = validation.skill.name;
      writes = [{ relative: flatName, data: file.data }];
    }

    // Refuse duplicates: the name may not exist enabled or disabled anywhere.
    const existing = winnerEntry(await this.fileEntriesAll(), name);
    if (existing !== undefined) throw new Error('同名技能 "' + name + '" 已存在（' + (existing.enabled ? "已启用" : "已停用") + "，位于 " + (existing.projectRoot !== undefined ? existing.projectRoot : "全局用户根") + "）");
    const { registry, cwd, scope } = this.viewFor(sessionId);
    if ((await registry.list({ cwd, scope })).some((skill) => skill.name === name)) throw new Error('同名技能 "' + name + '" 已存在');

    // Write the files (staged in the target root, then renamed into place).
    const target = kind === "bundle" ? join(targetRoot, name) : join(targetRoot, writes[0].relative);
    const staging = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
    try {
      if (kind === "bundle") {
        for (const write of writes) {
          const filePath = join(staging, write.relative);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, write.data);
        }
        await rename(staging, target);
      } else {
        await mkdir(staging, { recursive: true });
        const stagedFile = join(staging, writes[0].relative);
        await writeFile(stagedFile, writes[0].data);
        await rename(stagedFile, target);
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error("写入技能文件失败（已回滚）：" + (error instanceof Error ? error.message : String(error)));
    }

    // Let DSH itself be the final judge: poll the registry until the skill
    // shows up in the target scope. Roll back when it never does.
    const accepted = await this.waitForDiscovery(name, sessionId, targetProject ?? cwd);
    if (!accepted) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error("DSH 未接受该技能（格式校验未通过），已回滚。请检查 frontmatter 后重试");
    }
    return { name, kind, scope: targetProject !== undefined ? { kind: "workspace", path: targetProject, label: basename(targetProject) || targetProject } : { kind: "global" } };
  }

  async waitForDiscovery(name, sessionId, probeCwd) {
    const { registry, scope } = this.viewFor(sessionId);
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      try {
        if ((await registry.get(name, { cwd: probeCwd, scope })) !== undefined) return true;
      } catch {
        // registry unavailable: treat as accepted (nothing to verify against)
        return true;
      }
    }
    return false;
  }
}

export function apply(ctx: any) {
  new SkillsViewerGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "skills-viewer: typert manifest");
}
