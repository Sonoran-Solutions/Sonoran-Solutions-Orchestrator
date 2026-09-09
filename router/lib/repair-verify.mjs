import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
function git(cwd,args){return execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null"}});}
function snapshot(worktree,startSha,expectedBranch){
 const launcher=fileURLToPath(new URL("../../hermes-watch/verify-repair-sandboxed",import.meta.url));
 const raw=execFileSync(launcher,[worktree,startSha,expectedBranch],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
 const f=Object.fromEntries(raw.trim().split("\n").map(x=>{const i=x.indexOf(":");return [x.slice(0,i),x.slice(i+1)]}));
 return {branch:f.BRANCH,head:f.HEAD,status:Buffer.from(f.STATUS_B64||"","base64").toString(),files:Buffer.from(f.FILES_B64||"","base64").toString()};
}
// Sonoran patterns are repository-relative: * and ? never cross /; ** crosses
// zero or more complete path segments. Thus *.md matches README.md but not docs/README.md.
function rx(pattern){let o="^"; for(let i=0;i<pattern.length;i++){const c=pattern[i]; if(c==="*"&&pattern[i+1]==="*"){if(pattern[i+2]==="/"){o+="(?:.*/)?";i+=2;}else{o+=".*";i++;}}else if(c==="*")o+="[^/]*";else if(c==="?")o+="[^/]";else o+=/[\\^$+?.()|{}\[\]]/.test(c)?"\\"+c:c;} return new RegExp(o+"$");}
export function pathMatches(path,patterns=[]){return patterns.some(p=>rx(String(p)).test(path));}
export function pathsAllowed(path,worker,task){return pathMatches(path,worker)&&(!task.length||pathMatches(path,task));}
export function verifyRepairCandidate({worktree,expectedBranch,startSha,workerAllowedPaths=[],taskAllowedPaths=[],declaredFiles=[]}){
 const fail=reason=>({ok:false,reason}); let x;
 try{x=snapshot(worktree,startSha,expectedBranch);}catch(e){return fail(`Git verification failed in verifier sandbox: ${e.message}`);}
 if(x.branch!==expectedBranch)return fail(`current branch '${x.branch}' does not equal assigned branch '${expectedBranch}'`);
 if(x.head===startSha)return fail("candidate has no committed change"); if(x.status)return fail("working tree is dirty");
 const actual=x.files.split("\n").map(v=>v.trim()).filter(Boolean).sort(); if(!actual.length)return fail("actual changed-file set is empty");
 if(actual.some(v=>!pathsAllowed(v,workerAllowedPaths,taskAllowedPaths)))return fail("committed path is outside allowed scope");
 if(actual.some(v=>v===".sonoran-repair-result.json"||v.startsWith(".sonoran-")))return fail("router metadata changed");
 const declared=[...new Set((Array.isArray(declaredFiles)?declaredFiles:[]).map(String))].sort();
 if(declared.length!==actual.length||declared.some((v,i)=>v!==actual[i]))return fail("declared files do not match actual Git changes");
 return {ok:true,branch:x.branch,head:x.head,actualFiles:actual};
}
