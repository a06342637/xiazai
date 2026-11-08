import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let checked = 0;
for (const folder of ['server','updater','public','scripts']) {
  for (const file of await readdir(folder)) if (/\.(?:mjs|js)$/.test(file)) {
    const result = spawnSync(process.execPath,['--check',path.join(folder,file)],{stdio:'inherit'});
    if(result.status!==0) process.exit(result.status || 1); checked++;
  }
}
const pkg = JSON.parse(await readFile('package.json','utf8'));
for(const file of ['Dockerfile','compose.yml','.env.example','install.sh','reset-admin.sh','README.md']) await access(file);
const compose = await readFile('compose.yml','utf8');
if(!compose.includes(`xiazai:${pkg.version}`)) throw new Error('compose.yml 默认版本与 package.json 不一致');
const lock = JSON.parse(await readFile('package-lock.json','utf8'));
if(lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('锁文件版本与 package.json 不一致');
for(const [file,expected] of [['Dockerfile',`ARG VERSION=${pkg.version}`],['.env.example',`xiazai:${pkg.version}`],['public/index.html',`id="footer-version">v${pkg.version}`]]){
  if(!(await readFile(file,'utf8')).includes(expected))throw new Error(`${file} 默认版本不一致`);
}
console.log(`Build verified: v${pkg.version}, ${checked} JavaScript modules, static assets and Docker deployment files.`);
