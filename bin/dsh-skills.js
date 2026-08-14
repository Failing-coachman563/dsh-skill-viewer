#!/usr/bin/env node
/**
 * dsh-skills - hot skill management CLI for the dsh-skill-viewer plugin.
 *
 * Works directly on the skill files the DSH skill-filesystem provider reads;
 * the running gateway picks changes up through its file watcher (no restart).
 *
 *   dsh-skills list                    list skills (project + user roots)
 *   dsh-skills enable <name>           re-enable a disabled skill
 *   dsh-skills disable <name>          hot-disable a skill (rename to *.disabled)
 *   dsh-skills delete <name> [--yes]   delete a skill permanently
 *   --cwd <path>                       project root anchor (default: current dir)
 */
import { rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  DISABLED_SUFFIX,
  buildRoots,
  collectSkillEntries,
  pathExists,
  winnerEntry
} from "../lib/skill-files.js";

function usage() {
  console.log([
    "用法:",
    "  dsh-skills list [--cwd <path>]             列出技能（项目 + 用户根，按生效优先级）",
    "  dsh-skills enable <name> [--cwd <path>]    启用已停用的技能",
    "  dsh-skills disable <name> [--cwd <path>]   停用技能（改名 *.disabled，热生效）",
    "  dsh-skills delete <name> [--yes] [--cwd <path>]  删除技能（目录型删整个目录）",
    "",
    "说明: 停用 = 把 SKILL.md 改名 SKILL.md.disabled；网关的监听器会热感知，",
    "无需重启。随部署附带的技能（bundled）不在本工具管理范围内。"
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

async function main() {
  const args = process.argv.slice(2);
  const flags = { cwd: process.cwd(), yes: false };
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
      console.log([state, entry.name, "[" + entry.source + "]", detail].filter(Boolean).join("\t"));
    }
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
  console.error("dsh-skills: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
