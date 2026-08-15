/**
 * dsh-skill-viewer — scope layout + migration engine (entity model).
 *
 * Since 0.3.0 the plugin keeps NO central store and NO junctions: a skill's
 * entity lives directly in the skill folder of its scope —
 *
 *   - global:    <dshHome>/skills/<name>/SKILL.md          (or <file>.md)
 *   - workspace: <workspaceProjectRoot>/.dsh/skills/<name>/SKILL.md
 *
 * What a session sees is exactly what the provider discovers in its roots —
 * no hidden layer to explain. Changing a skill's scope is a real migration:
 * copy or move of the entity between two scope folders, with validation
 * first and rollback when anything fails mid-write.
 *
 * This module is dependency-free (node:fs / node:path / node:os only).
 */
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { findProjectRoot, pathExists } from "./skill-files.js";
/** The skills folder a workspace project root manages. */
export function workspaceSkillRoot(projectRoot) {
    return join(projectRoot, ".dsh", "skills");
}
/**
 * The destination skills folder for a scope target:
 *   null    → the global user root (<dshHome>/skills)
 *   a path  → <projectRoot>/.dsh/skills
 */
export function scopeRootOf(target, dshHome) {
    return target === null || target === undefined ? join(dshHome, "skills") : workspaceSkillRoot(target);
}
/**
 * Normalize a list of raw workspace paths into distinct project-root paths.
 * Every path must exist and resolve to its nearest `.git` ancestor (or
 * itself when there is none), because that is where the provider looks for
 * `<projectRoot>/.dsh/skills`. Case-insensitive dedupe on Windows.
 */
export async function normalizeWorkspaces(paths) {
    const seen = new Set();
    const result = [];
    for (const raw of paths) {
        if (typeof raw !== "string" || raw.trim() === "")
            continue;
        const absolute = resolve(raw.trim());
        const info = await stat(absolute).catch(() => undefined);
        if (info === undefined || !info.isDirectory())
            throw new Error('工作区不存在或不是目录："' + raw + '"');
        const project = await findProjectRoot(absolute);
        const key = process.platform === "win32" ? project.toLowerCase() : project;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(project);
    }
    return result;
}
/** Normalize exactly one workspace path (throws when none resolves). */
export async function normalizeWorkspace(raw) {
    const list = await normalizeWorkspaces([raw]);
    if (list.length === 0)
        throw new Error("至少需要指定一个存在的工作区");
    return list[0];
}
/** Windows sharing-violation / permission codes that may clear after a beat. */
function isBusyError(error) {
    return error !== null && typeof error === "object" && ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error.code);
}
/** Remove a file or directory, retrying transient sharing violations. */
async function removeRetry(path) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await rm(path, { recursive: true, force: true });
            return true;
        }
        catch (error) {
            if (!isBusyError(error))
                throw error;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 300 * (attempt + 1)));
        }
    }
    return false;
}
/**
 * Migrate one skill entity (bundle directory or flat file) from its current
 * location to `targetRoot`, copying or moving as requested.
 *
 * Order of operations:
 *   1. validate (target conflict, same-location no-op) — nothing written yet
 *   2. materialize the entity at the target (staged inside targetRoot, then
 *      renamed into place) — any failure removes the staging residue
 *   3. for "move": delete the source; if the source cannot be removed the
 *      freshly written target copy is rolled back so no duplicate is left
 *
 * @param entry - a skill-files entry ({ name, file, dirBundle, enabled }).
 * @param targetRoot - absolute path of the destination skills folder.
 * @param mode - "copy" (keep the source) or "move" (delete the source).
 * @returns the entity's new location (directory for bundles, file for flat).
 */
export async function migrateEntry(entry, targetRoot, mode) {
    const sourceDir = entry.dirBundle ? dirname(entry.file) : entry.file;
    const target = entry.dirBundle ? join(targetRoot, entry.name) : join(targetRoot, basename(entry.file));
    // ── validation (nothing written yet) ──────────────────────────────────────
    if (resolve(sourceDir) === resolve(target))
        throw new Error('技能 "' + entry.name + '" 已在此作用域中');
    if (await pathExists(target))
        throw new Error('目标位置已存在同名技能："' + target + '"');
    if (!(await pathExists(sourceDir)))
        throw new Error('技能 "' + entry.name + '" 的源文件不存在：' + sourceDir);
    await mkdir(targetRoot, { recursive: true });
    // ── move fast path: a same-volume rename is atomic and cheap ───────────────
    if (mode === "move") {
        try {
            await rename(sourceDir, target);
            return { target };
        }
        catch (error) {
            if (!["EXDEV", "EBUSY", "EPERM", "EACCES"].includes(error.code))
                throw new Error("移动技能文件失败：" + (error instanceof Error ? error.message : String(error)));
            // cross-volume or transiently locked: fall through to copy + delete
        }
    }
    // ── copy path: stage inside the target root, then rename into place ───────
    const staging = join(targetRoot, ".dsh-skill-staging-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
    try {
        if (entry.dirBundle) {
            await cp(sourceDir, staging, { recursive: true });
            await rename(staging, target);
        }
        else {
            await mkdir(staging, { recursive: true });
            const stagedFile = join(staging, basename(entry.file));
            await cp(entry.file, stagedFile);
            await rename(stagedFile, target);
            await rm(staging, { recursive: true, force: true }).catch(() => { });
        }
    }
    catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => { });
        throw new Error("复制技能文件失败（已回滚）：" + (error instanceof Error ? error.message : String(error)));
    }
    // ── move: delete the source; roll the fresh copy back when that fails ──────
    if (mode === "move") {
        try {
            if (!(await removeRetry(sourceDir)))
                throw new Error("源文件删除超时");
        }
        catch (error) {
            await rm(target, { recursive: true, force: true }).catch(() => { });
            throw new Error('技能 "' + entry.name + '" 已复制到目标，但无法删除源文件（可能被占用），已回滚新副本：' + (error instanceof Error ? error.message : String(error)));
        }
    }
    return { target };
}
/**
 * Migrate several entities in sequence. Every item is independent: one
 * failure never aborts the rest, and each item either lands completely or
 * rolls back to its pre-migration state.
 *
 * @param items - skill-files entries to migrate.
 * @param targetRoot - destination skills folder.
 * @param mode - "copy" | "move".
 * @returns per-item results [{ name, ok, error? }] in input order.
 */
export async function batchMigrateEntries(items, targetRoot, mode) {
    const results = [];
    for (const item of items) {
        try {
            await migrateEntry(item, targetRoot, mode);
            results.push({ name: item.name, ok: true });
        }
        catch (error) {
            results.push({ name: item.name, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}
