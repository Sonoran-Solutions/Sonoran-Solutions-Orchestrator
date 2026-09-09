import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyRepairCandidate, pathMatches } from "./lib/repair-verify.mjs";
import { makeTaskId, containedPath } from "./lib/task-id.mjs";
const d=mkdtempSync("/tmp/repair-verify-"); const repo=join(d,"repo"); mkdirSync(repo); const g=(a)=>execFileSync("git",a,{cwd:repo,stdio:"ignore"}); g(["init","-q"]); g(["config","user.name","test"]); g(["config","user.email","test@example.invalid"]); writeFileSync(join(repo,"src.txt"),"base\n"); g(["add","src.txt"]); g(["commit","-qm","base"]); const start=execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim(); writeFileSync(join(repo,"src.txt"),"changed\n"); g(["add","src.txt"]); g(["commit","-qm","fix"]); assert.deepEqual(verifyRepairCandidate({worktree:repo,expectedBranch:"master",startSha:start,workerAllowedPaths:["*.txt"],declaredFiles:["src.txt"]}).actualFiles,["src.txt"]); assert.equal(pathMatches("app/src/a.js",["app/src/**"]),true); assert.equal(makeTaskId("org/repo",3),"repo-3"); assert.throws(()=>containedPath(d,"../x")); rmSync(d,{recursive:true,force:true}); console.log("repair verification tests passed");
