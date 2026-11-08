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
console.log(`Build verified: v${pkg.version}, ${checked} JavaScript modules, static assets and Docker deployment files.`);
