#!/usr/bin/env node
/**
 * dsh-skill - hot skill management CLI for the dsh-skill-viewer plugin.
 *
 * Works directly on the skill files the DSH skill-filesystem provider reads;
 * the running gateway picks changes up through its file watcher (no restart).
 *
 *   dsh-skill list                     list skills (project + user roots)
 *   dsh-skill enable <name>            re-enable a disabled skill
 *   dsh-skill disable <name>           hot-disable a skill (rename to *.disabled)
 *   dsh-skill delete <name> [--yes]    delete a skill permanently
 *   dsh-skill add <path>               add a skill (.md file, or a bundle dir
 *                                      whose top level contains SKILL.md)
 *   --cwd <path>                       project root anchor (default: current dir)
 *   --project                          add into the project root instead of ~/.dsh/skills
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  DISABLED_SUFFIX,
  buildRoots,
  collectSkillEntries,
  pathExists,
  validateFrontmatter,
  winnerEntry
} from "../lib/skill-files.js";

function usage() {
  console.log([
    "用法:",
    "  dsh-skill list [--cwd <path>]                         列出技能（项目 + 用户根，按生效优先级）",
    "  dsh-skill enable <name> [--cwd <path>]                启用已停用的技能",
    "  dsh-skill disable <name> [--cwd <path>]               停用技能（改名 *.disabled，热生效）",
    "  dsh-skill delete <name> [--yes] [--cwd <path>]        删除技能（目录型删整个目录）",
    "  dsh-skill add <path> [--cwd <path>] [--project]       添加技能：单个 .md 文件或含顶层 SKILL.md 的目录束",
    "",
    "说明: 停用 = 把 SKILL.md 改名 SKILL.md.disabled；网关的监听器会热感知，",
    "无需重启。add 默认写入 ~/.dsh/skills（--project 写入项目 .dsh/skills），",
    "写入前完整校验并查重，任何一步失败都会自动回滚，不会留下半成品。",
    "随部署附带的技能（bundled）不在本工具管理范围内。"
  ].join("\n"));
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolvePromise) => {
    rl.question(question, (value) => {
      rl.close();
      resolvePromise(value.trim().toLowerCase());
    });
  });
  return answer === "y" || answer === "yes";
}

/** Resolve the user roots the same way the host plugin does. */
function userHomes() {
  const dshHome = resolve(process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), ".dsh"));
  const agentsHome = resolve(process.env.DSH_AGENTS_HOME && process.env.DSH_AGENTS_HOME.trim() ? process.env.DSH_AGENTS_HOME : join(homedir(), ".agents"));
  return { dshHome, agentsHome };
}

/**
 * Recursively list regular files under a directory as { full, relative } with
 * forward-slash relative paths. Symlinked files are followed; symlinked
 * directories are skipped so a cycle can never be traversed.
 */
async function walkFiles(dir, rel = "", out = []) {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = join(dir, item.name);
    const childRel = rel === "" ? item.name : rel + "/" + item.name;
    if (item.isDirectory()) {
      await walkFiles(full, childRel, out);
    } else if (item.isFile()) {
      out.push({ full, relative: childRel });
    } else if (item.isSymbolicLink()) {
      const target = await stat(full).catch(() => undefined);
      if (target?.isFile()) out.push({ full, relative: childRel });
    }
  }
  return out;
}

/**
 * Add a skill from a local path, mirroring the Web UI add flow:
 *   bundle = a directory whose top level contains SKILL.md
 *   flat   = a single markdown file
 *
 * Every validation step runs BEFORE anything is written (frontmatter,
 * duplicate name across all roots, destination conflicts, unsafe layouts).
 * The copy itself is staged inside the destination root and renamed into
 * place at the end, so any failure mid-write rolls back cleanly.
 */
async function addSkill(sourceArg, flags, roots, entries) {
  const source = resolve(sourceArg);
  const info = await stat(source).catch(() => undefined);
  if (info === undefined) throw new Error("路径不存在：" + sourceArg);
  if (!info.isDirectory() && !info.isFile()) throw new Error("只支持 .md 文件或包含顶层 SKILL.md 的目录束：" + sourceArg);

  // 1) Kind + frontmatter validation + canonical name (nothing written yet).
  let kind;
  let name;
  if (info.isDirectory()) {
    const skillMd = join(source, "SKILL.md");
    if (!(await pathExists(skillMd))) throw new Error("目录束缺少顶层的 SKILL.md 文件：" + sourceArg);
    const validation = validateFrontmatter(await readFile(skillMd, "utf8"));
    if (!validation.ok) throw new Error("技能格式不符合要求：" + validation.error);
    kind = "bundle";
    name = validation.skill.name;
  } else {
    if (!sourceArg.toLowerCase().endsWith(".md")) throw new Error("单个技能文件必须是 .md 文件：" + sourceArg);
    if (basename(source).toLowerCase() === "skill.md") throw new Error("单文件不能直接叫 SKILL.md，请把它放进一个文件夹里作为目录束添加");
    const validation = validateFrontmatter(await readFile(source, "utf8"));
    if (!validation.ok) throw new Error("技能格式不符合要求：" + validation.error);
    kind = "flat";
    name = validation.skill.name;
  }

  // 2) Destination root.
  const destRoot = flags.project
    ? roots.find((root) => root.source === "project-dsh")?.path
    : join(userHomes().dshHome, "skills");
  if (destRoot === undefined) throw new Error("找不到目标技能根（--project 需要当前目录锚定一个项目根）");
  const target = kind === "bundle" ? join(destRoot, name) : join(destRoot, basename(source));

  // 3) Duplicate + layout guards.
  const existing = winnerEntry(entries, name);
  if (existing !== undefined) throw new Error('同名技能 "' + name + '" 已存在（' + existing.source + "，" + (existing.enabled ? "已启用" : "已停用") + "）");
  if (await pathExists(target)) throw new Error("目标路径已存在：" + target);
  const resolvedRoot = resolve(destRoot);
  if (resolve(source) === resolve(target)) throw new Error("源路径与目标相同，无需添加：" + sourceArg);
  if (resolvedRoot.startsWith(resolve(source))) throw new Error("源路径不能是目标技能根本身或其上级目录：" + sourceArg);

  // 4) Staged copy + atomic rename; roll back on any failure.
  await mkdir(destRoot, { recursive: true });
  const staging = join(destRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  try {
    if (kind === "bundle") {
      for (const file of await walkFiles(source)) {
        const dest = join(staging, file.relative);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(file.full, dest);
      }
      await rename(staging, target);
    } else {
      await mkdir(staging, { recursive: true });
      const stagedFile = join(staging, basename(source));
      await copyFile(source, stagedFile);
      await rename(stagedFile, target);
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new Error("写入技能文件失败（已回滚）：" + (error instanceof Error ? error.message : String(error)));
  }
  return { name, kind, target };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = { cwd: process.cwd(), yes: false, project: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") {
      i += 1;
      if (i >= args.length) {
        console.error("--cwd 需要一个路径参数");
        process.exit(2);
      }
      flags.cwd = args[i];
    } else if (args[i] === "--yes") flags.yes = true;
    else if (args[i] === "--project") flags.project = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      usage();
      return;
    } else positional.push(args[i]);
  }
  const command = positional[0];
  const name = positional[1];
  if (command === undefined) {
    usage();
    process.exit(2);
  }

  const roots = await buildRoots(flags.cwd, userHomes());
  const entries = await collectSkillEntries(roots);

  if (command === "list") {
    if (entries.length === 0) {
      console.log("未找到技能。（搜索范围：项目 .dsh/skills、.agents/skills 与用户 ~/.dsh/skills、~/.agents/skills）");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
    for (const entry of entries) {
      const state = entry.enabled ? "启用" : "停用";
      const detail = entry.description.length > 70 ? entry.description.slice(0, 70) + "…" : entry.description;
      console.log([state, entry.name, "[" + entry.source + "]", detail].filter(Boolean).join("	"));
    }
    return;
  }
  if (command === "add") {
    if (name === undefined) {
      console.error("add 需要一个路径参数（单个 .md 文件或包含顶层 SKILL.md 的目录束）");
      process.exit(2);
    }
    const added = await addSkill(name, flags, roots, entries);
    console.log('已添加技能 "' + added.name + '"（' + (added.kind === "bundle" ? "目录束" : "单文件") + " → " + added.target + "，网关监听器将热感知）");
    return;
  }
  if (name === undefined) {
    console.error(command + " 需要一个技能名参数");
    process.exit(2);
  }
  const entry = winnerEntry(entries, name);
  if (entry === undefined) {
    console.error('技能 "' + name + '" 未找到（项目与用户技能根中均不存在）');
    process.exit(1);
  }
  if (command === "enable") {
    if (entry.enabled) {
      console.log('技能 "' + name + '" 已是启用状态');
      return;
    }
    const target = entry.file.slice(0, -DISABLED_SUFFIX.length);
    await rename(entry.file, target);
    console.log('已启用技能 "' + name + '"（网关监听器将热感知，无需重启）');
    return;
  }
  if (command === "disable") {
    if (!entry.enabled) {
      console.log('技能 "' + name + '" 已是停用状态');
      return;
    }
    const target = entry.file + DISABLED_SUFFIX;
    if (await pathExists(target)) {
      console.error("目标文件已存在：" + target);
      process.exit(1);
    }
    await rename(entry.file, target);
    console.log('已停用技能 "' + name + '"（网关监听器将热感知，无需重启）');
    return;
  }
  if (command === "delete") {
    if (!flags.yes) {
      const ok = await confirm('确认删除技能 "' + name + '"？此操作不可恢复 (y/N): ');
      if (!ok) {
        console.log("已取消");
        return;
      }
    }
    if (entry.dirBundle) await rm(dirname(entry.file), { recursive: true, force: true });
    else await rm(entry.file, { force: true });
    console.log('已删除技能 "' + name + '"');
    return;
  }
  console.error('未知命令 "' + command + '"');
  usage();
  process.exit(2);
}

main().catch((error) => {
  console.error("dsh-skill: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
