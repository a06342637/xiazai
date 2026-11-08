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
export async function githubJson(url, fetcher = fetch) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xiazai-updater' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 404) throw httpError(404, '暂无已发布版本');
  if (!response.ok) throw httpError(502, `版本服务暂时不可用（${response.status}），请稍后重试`);
  return response.json();
}
export async function getRelease(version, fetcher = fetch) {
  if (version && !isVersion(version)) throw httpError(400, '版本号格式错误');
  const release = await githubJson(`https://api.github.com/repos/${REPOSITORY}/releases/${version ? `tags/v${version}` : 'latest'}`, fetcher);
  const target = release.tag_name?.replace(/^v/, '');
  if (release.draft || release.prerelease || !isVersion(target) || (version && target !== version)) throw httpError(502, '发行版本信息无效');
  const asset = release.assets?.find(a => a.name === 'release.json');
  if (!asset?.browser_download_url || !asset.browser_download_url.startsWith(`https://github.com/${REPOSITORY}/releases/download/v${target}/`)) throw httpError(502, '发行版本缺少更新清单');
  const response = await fetcher(asset.browser_download_url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw httpError(502, '无法读取更新清单');
  const manifest = await response.json();
  if (manifest.version !== target || !new RegExp(`^${IMAGE_PREFIX}[a-f0-9]{64}$`).test(manifest.image) || manifest.schema !== 1) throw httpError(502, '更新清单校验失败');
  return { version: target, image: manifest.image, notes: (release.body || '').slice(0, 12000),
    publishedAt: release.published_at, url: release.html_url };
}
