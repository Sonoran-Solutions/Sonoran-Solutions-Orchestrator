import { resolve, sep } from "node:path";
const SAFE=/^[A-Za-z0-9._-]+$/; const SHA=/^[0-9a-f]{7,40}$/i;
export function makeTaskId(repo, issueNumber, headSha="") {
 const component=String(repo||"").split("/").pop()?.replace(/[^A-Za-z0-9._-]/g,"")||"";
 if(!component) throw new Error("repository component is empty");
 if(issueNumber!==null && issueNumber!==undefined && issueNumber!=="") { if(!Number.isSafeInteger(Number(issueNumber))||Number(issueNumber)<=0) throw new Error("issue number must be a positive integer"); return `${component}-${Number(issueNumber)}`; }
 if(!SHA.test(String(headSha||""))) throw new Error("head SHA fallback is invalid"); return `${component}-${String(headSha).slice(0,12)}`;
}
export function containedPath(root,id) { const base=resolve(root), value=String(id||""); if(!value||value==="."||value===".."||value.includes("/")||value.includes("\\")||value.includes("..")||!SAFE.test(value)) throw new Error("unsafe path component"); const dest=resolve(base,value); if(dest===base||!dest.startsWith(base+sep)) throw new Error("path escapes root"); return dest; }
