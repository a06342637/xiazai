import path from 'node:path';
import { atomicJson, readJson } from '../server/util.mjs';
import { getRelease, newer } from '../server/releases.mjs';
import { cloneConfig } from './docker.mjs';
import { readFile, writeFile, rename } from 'node:fs/promises';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Updater {
  constructor({docker, root, appName = 'xiazai', releaseFetcher = getRelease, wait = delay, healthAttempts = 36}) {
    this.docker = docker; this.file = path.join(root,'system','update.json'); this.appName = appName;
    this.releaseFetcher = releaseFetcher; this.wait = wait; this.healthAttempts = healthAttempts; this.busy = false;
  }
  async state() { return readJson(this.file,{phase:'idle',message:'尚未执行更新'}); }
  async save(phase, message, extra = {}) {
    this.job = {...this.job, ...extra, phase, message, updatedAt:Date.now()};
    await atomicJson(this.file,this.job); return this.job;
  }
  async health(name) {
    for (let attempt = 0; attempt < this.healthAttempts; attempt++) {
      const inspect = await this.docker.inspect(name);
      if (!inspect.State.Running || inspect.State.Health?.Status === 'unhealthy') throw new Error('新版容器启动失败');
      if (inspect.State.Health?.Status === 'healthy') return;
      await this.wait(5000);
    }
    throw new Error('新版容器健康检查超时');
  }
  async persistImage(image) {
    // The one-click installer keeps deployment configuration on this same bind mount.
    // Persist the digest so subsequent `docker compose up` uses the upgraded app.
    const envFile = path.join(path.dirname(path.dirname(this.file)), 'deploy', '.env');
    let env;
    try { env = await readFile(envFile,'utf8'); } catch(error) { if(error.code==='ENOENT') return; throw error; }
    const next = /^APP_IMAGE=.*$/m.test(env) ? env.replace(/^APP_IMAGE=.*$/m,`APP_IMAGE=${image}`) : `${env}\nAPP_IMAGE=${image}\n`;
    const temporary = `${envFile}.upgrade.tmp`;
    await writeFile(temporary,next,{mode:0o600}); await rename(temporary,envFile);
  }
  async recover() {
    const state = await this.state();
    if (['idle','success','failed','rolled_back'].includes(state.phase)) return;
    this.job = state;
    // A persisted switching intent is written before any container mutation.
    if (state.phase === 'pulling') { await this.save('failed','升级服务重启，原版本继续运行，请重新检查更新'); return; }
    const backup = await this.docker.inspect(state.backupName).catch(e => { if(e.status===404) return null; throw e; });
    if (backup) { await this.rollback(state.backupName,state.candidateName); return; }
    const old = await this.docker.inspect(state.originalId).catch(e => { if(e.status===404) return null; throw e; });
    if (!old) throw new Error('无法找到原版本容器，请检查 Docker 状态');
    if (!old.State.Running) await this.docker.start(old.Id);
    if (state.candidateName) await this.docker.remove(state.candidateName).catch(e => { if(e.status!==404) throw e; });
    await this.save('failed','升级任务中断，已恢复原版本，请重新检查更新');
  }
  async rollback(backupName, candidateName) {
    await this.save('rolling_back','新版未通过检查，正在恢复原版本');
    const current = await this.docker.inspect(this.appName).catch(e => { if(e.status===404) return null; throw e; });
    const backup = await this.docker.inspect(backupName);
    if (current && current.Id !== backup.Id) await this.docker.remove(current.Id);
    if (candidateName) await this.docker.remove(candidateName).catch(e => { if(e.status!==404) throw e; });
    await this.docker.rename(backup.Id,this.appName);
    if (!backup.State.Running) await this.docker.start(backup.Id);
    await this.health(backup.Id);
    await this.persistImage(backup.Config.Image);
    await this.save('rolled_back','升级失败，已恢复原版本。文件和设置保持完整。');
  }
  async prepare(version) {
    if (this.busy) throw Object.assign(new Error('已有升级任务正在运行'),{status:409});
    this.busy = true;
    try {
      const release = await this.releaseFetcher(version), original = await this.docker.inspect(this.appName);
      const current = original.Config.Labels?.['org.opencontainers.image.version'];
      if (!newer(release.version,current)) throw Object.assign(new Error('当前版本已是最新版本'),{status:409});
      const stamp = `${Date.now()}`;
      this.job = { targetVersion:release.version, previousVersion:current, originalId:original.Id,
        backupName:`${this.appName}-backup-${stamp}`, candidateName:`${this.appName}-candidate-${stamp}`, image:release.image, startedAt:Date.now() };
      await this.save('pulling','正在拉取并校验新版本镜像');
      return {release,original,state:this.job};
    } catch(error) { this.busy = false; throw error; }
  }
  async run({release,original}) {
    let switched = false, stopped = false, candidateId;
    try {
      await this.docker.pull(release.image);
      // Persist intent before creating candidate, stopping or renaming the old app.
      await this.save('switching','镜像校验完成，正在切换版本');
      const candidate = await this.docker.create(this.job.candidateName,cloneConfig(original,release.image,release.version)); candidateId = candidate.Id;
      await this.docker.stop(original.Id); stopped = true;
      await this.docker.rename(original.Id,this.job.backupName); switched = true;
      await this.docker.rename(candidateId,this.appName); await this.docker.start(candidateId);
      await this.save('checking','新版已启动，正在检查服务健康状态');
      await this.health(candidateId);
      await this.persistImage(release.image);
      // Mark complete before deleting rollback container. Recovery will preserve the healthy version.
      await this.save('success','升级完成，服务已恢复');
      await this.docker.remove(original.Id).catch(error => console.error('旧容器清理失败:',error.message));
    } catch(error) {
      console.error('升级失败:',error.message);
      if (switched) {
        try { await this.rollback(this.job.backupName, this.job.candidateName); }
        catch(rollbackError) { await this.save('failed',`自动回滚未完成：${rollbackError.message}。请在服务器检查 Docker 容器。`); }
      } else {
        if (candidateId) await this.docker.remove(candidateId).catch(() => {});
        if (stopped) await this.docker.start(original.Id).catch(() => {});
        await this.save('failed',`升级未完成：${error.message}。原版本继续保留，请稍后重试。`);
      }
    } finally { this.busy = false; }
  }
}
