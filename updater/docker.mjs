import http from 'node:http';
import { httpError } from '../server/util.mjs';

export class Docker {
  constructor(socket = '/var/run/docker.sock') { this.socket = socket; }
  request(method, url, body, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ socketPath: this.socket, path: url, method,
        headers: encoded ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)} : {} }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 ** 2) { req.destroy(new Error('Docker response too large')); } else chunks.push(chunk); });
        res.on('end', () => {
          let value;
          const text = Buffer.concat(chunks).toString();
          try { value = text ? JSON.parse(text) : null; } catch { value = text; }
          if (res.statusCode >= 400) return reject(httpError(res.statusCode, value?.message || `Docker HTTP ${res.statusCode}`));
          resolve(value);
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('Docker request timed out')));
      req.on('error', reject); if (encoded) req.write(encoded); req.end();
    });
  }
  pull(image, onProgress) {
    return new Promise((resolve, reject) => {
      const [repository, digest] = image.split('@');
      const req = http.request({ socketPath: this.socket, method: 'POST',
        path: `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}` }, res => {
        let buffer = '', ended = false;
        const fail = error => { if (!ended) { ended = true; req.destroy(); reject(error); } };
        if (res.statusCode >= 400) { res.resume(); return fail(new Error(`镜像拉取失败 (${res.statusCode})`)); }
        res.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.length > 1024 ** 2) return fail(new Error('镜像响应异常'));
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
            if (!line.trim()) continue;
            try { const event = JSON.parse(line); if (event.error) return fail(new Error(event.error)); onProgress?.(event.status || '正在拉取镜像'); }
            catch (error) { return fail(error); }
          }
        });
        res.on('end', () => { if (!ended) { ended = true; resolve(); } }); res.on('error', fail);
      });
      req.setTimeout(600000, () => req.destroy(new Error('镜像拉取超时，请稍后重试')));
      req.on('error', reject); req.end();
    });
  }
  inspect(name) { return this.request('GET', `/containers/${encodeURIComponent(name)}/json`); }
  rename(name, replacement) { return this.request('POST', `/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(replacement)}`); }
  stop(name) { return this.request('POST', `/containers/${encodeURIComponent(name)}/stop?t=30`, undefined, 45000); }
  start(name) { return this.request('POST', `/containers/${encodeURIComponent(name)}/start`); }
  remove(name) { return this.request('DELETE', `/containers/${encodeURIComponent(name)}?force=true`); }
  create(name, config) { return this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, config); }
}

export function cloneConfig(inspect, image, version) {
  const allowed = ['Hostname','Domainname','User','AttachStdin','AttachStdout','AttachStderr','ExposedPorts','Tty','OpenStdin','StdinOnce',
    'Env','WorkingDir','Volumes','Labels','StopSignal','StopTimeout'];
  const config = Object.fromEntries(allowed.filter(k => inspect.Config[k] !== undefined).map(k => [k, structuredClone(inspect.Config[k])]));
  // Use the new image's command, entrypoint and healthcheck so future releases may change startup behavior.
  config.Image = image;
  config.Labels = {...config.Labels, 'com.docker.compose.image': image};
  if (version) config.Labels['org.opencontainers.image.version'] = version;
  config.HostConfig = structuredClone(inspect.HostConfig);
  if (config.HostConfig.NetworkMode === 'container' || String(config.HostConfig.NetworkMode).startsWith('container:')) throw new Error('不支持共享其他容器网络的部署');
  config.NetworkingConfig = { EndpointsConfig: {} };
  for (const [name, endpoint] of Object.entries(inspect.NetworkSettings.Networks)) {
    config.NetworkingConfig.EndpointsConfig[name] = { Aliases: (endpoint.Aliases || []).filter(a => a !== inspect.Id && a !== inspect.Id.slice(0,12)),
      ...(endpoint.IPAMConfig ? {IPAMConfig:endpoint.IPAMConfig} : {}) };
  }
  return config;
}
