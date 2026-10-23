// Trusted serial integrator for independently reviewed parallel MVP slices.
// Never execute code from an unreviewed branch with GitHub write credentials.
import {execFileSync} from 'node:child_process';
import {appendFileSync,copyFileSync,existsSync,lstatSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {taskPathAllowed} from './policy.mjs';
import {runIsolatedCheck} from './controller.mjs';

const control=dirname(fileURLToPath(import.meta.url));
const lanes=[{name:'persona',id:'P1'},{name:'onebot',id:'Q1'}];
const target='feat/companion-v3';
function git(args,env=process.env) {
  return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{
    encoding:'utf8',env,timeout:60000,maxBuffer:4*1024*1024
  }).trim();
}
function report(message) {
  console.log(message);
  if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,message+'\n\n');
}

export function laneDiffAllowed(id,files) {
  return files.length>0 && files.every(path=>taskPathAllowed({id},path));
}
function isAncestor(a,b) {
  try {git(['merge-base','--is-ancestor',a,b]);return true;}
  catch(error) {if(error.status===1) return false;throw error;}
}
function snapshotAndCheck() {
  const dir=mkdtempSync(join(process.env.RUNNER_TEMP,'parallel-merge-check-'));
  try {
    const tracked=git(['ls-files','-z']).split('\0').filter(Boolean);
    for(const path of tracked) {
      if(path.startsWith('data/')||path.split('/').some(p=>p==='.env'||p==='.git'||p==='node_modules')) continue;
      if(!existsSync(path)) continue;
      if(lstatSync(path).isSymbolicLink()) throw new Error('Snapshot symlink rejected: '+path);
      const to=join(dir,path);
      mkdirSync(dirname(to),{recursive:true});
      copyFileSync(path,to);
    }
    console.log(runIsolatedCheck(dir,join(control,'check.sh')));
  } finally {
    if(dirname(dir)===resolve(process.env.RUNNER_TEMP)) rmSync(dir,{recursive:true,force:true});
  }
}
function pushVerified() {
  if(!process.env.GH_TOKEN) throw new Error('Missing scoped GitHub token');
  const auth='AUTHORIZATION: basic '+Buffer.from('x-access-token:'+process.env.GH_TOKEN).toString('base64');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(KEY|TOKEN|SECRET|PASSWORD)$/.test(k)));
  Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:auth});
  git(['push','origin','HEAD:refs/heads/'+target],env);
}
export async function integrate() {
  for(const lane of lanes) {
    const ref='refs/heads/automation/ready-'+lane.name;
    let remote;
    try {remote=git(['ls-remote','--exit-code','origin',ref]).split(/\s/)[0];}
    catch(error) {if(error.status===2){report(lane.name+': no reviewed branch');continue;}throw error;}
    if(isAncestor(remote,'HEAD')) {report(lane.name+': already integrated');continue;}
    git(['fetch','--no-tags','origin',ref]);
    const candidate=git(['rev-parse','FETCH_HEAD']);
    if(candidate!==remote) throw new Error('Ready branch moved during fetch: '+lane.name);
    const fork=git(['merge-base','HEAD',candidate]);
    const files=git(['diff','--name-only',fork,candidate,'--']).split('\n').filter(Boolean);
    if(!laneDiffAllowed(lane.id,files)) {
      report(lane.name+': blocked; candidate contains files outside its isolated scope');
      continue;
    }
    let merging=true;
    try {
      git(['merge','--no-commit','--no-ff',candidate]);
      snapshotAndCheck();
      // A non-force push rejects concurrent updates to the target.
      git(['-c','user.name=oh-bot automation','-c','user.email=4927411+sekaiai@users.noreply.github.com',
        'commit','-m','Integrate reviewed parallel MVP '+lane.id]);
      merging=false;
      pushVerified();
      report(lane.name+': integrated after full isolated verification, commit '+git(['rev-parse','HEAD']));
    } catch(error) {
      if(merging) {try{git(['merge','--abort']);}catch{}}
      report(lane.name+': integration blocked; reviewed branch retained ('+(error.message||'unknown').slice(0,200)+')');
      // A push conflict leaves the current checkout ahead of origin; abort this run.
      if(!merging) throw error;
    }
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await integrate();} catch(error) {console.error(error.message);process.exitCode=1;}
}
