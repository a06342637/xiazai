import { httpError } from './util.mjs';

export const REPOSITORY = 'a06342637/xiazai';
export const IMAGE_PREFIX = `ghcr.io/${REPOSITORY}@sha256:`;
export const isVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newer(a, b) {
  if (!isVersion(a) || !isVersion(b)) return false;
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (aa[i] !== bb[i]) return aa[i] > bb[i]; }
  return false;
}
async function fetchRelease(url, fetcher, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(15000) });
      if ([502,503,504].includes(response.status) && attempt < 2) { await response.body?.cancel(); continue; }
      return response;
    } catch { if (attempt === 2) throw httpError(502, '无法连接版本服务，请稍后重试'); }
  }
}
export async function githubJson(url, fetcher = fetch) {
  const response = await fetchRelease(url, fetcher, { Accept: 'application/vnd.github+json', 'User-Agent': 'xiazai-updater' });
  if (response.status === 404) throw httpError(404, '暂无已发布版本');
  if (!response.ok) throw httpError(502, `版本服务暂时不可用（${response.status}），请稍后重试`);
  try { return await response.json(); } catch { throw httpError(502, '版本服务返回无效信息，请稍后重试'); }
}
export async function getRelease(version, fetcher = fetch) {
  if (version && !isVersion(version)) throw httpError(400, '版本号格式错误');
  const release = await githubJson(`https://api.github.com/repos/${REPOSITORY}/releases/${version ? `tags/v${version}` : 'latest'}`, fetcher);
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) throw httpError(502, '发行版本信息无效');
  const target = release.tag_name?.replace(/^v/, '');
  if (release.draft || release.prerelease || !isVersion(target) || (version && target !== version)) throw httpError(502, '发行版本信息无效');
  const asset = release.assets?.find(a => a.name === 'release.json');
  if (!asset?.browser_download_url || !asset.browser_download_url.startsWith(`https://github.com/${REPOSITORY}/releases/download/v${target}/`)) throw httpError(502, '发行版本缺少更新清单');
  const response = await fetchRelease(asset.browser_download_url, fetcher);
  if (!response.ok) throw httpError(502, '无法读取更新清单');
  let manifest;
  try { manifest = await response.json(); } catch { throw httpError(502, '更新清单格式错误'); }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== target || typeof manifest.image !== 'string' || !manifest.image.startsWith(IMAGE_PREFIX) || !/^[a-f0-9]{64}$/.test(manifest.image.slice(IMAGE_PREFIX.length)) || manifest.schema !== 1) throw httpError(502, '更新清单校验失败');
  return { version: target, image: manifest.image, notes: (release.body || '').slice(0, 12000),
    publishedAt: release.published_at, url: release.html_url };
}
