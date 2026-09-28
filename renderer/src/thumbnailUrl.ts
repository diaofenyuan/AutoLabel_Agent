import type { Asset } from '../../shared/protocol';

/**
 * 浏览器演示没有 Electron 的自定义媒体协议，沿用演示数据提供的图片地址；
 * 桌面端继续走本地引擎校验的缩略图协议。
 */
export function thumbnailUrlForAsset(asset: Pick<Asset, 'id' | 'thumbnailUrl' | 'mediaUrl'>, isDemo: boolean): string {
  return isDemo ? (asset.thumbnailUrl ?? asset.mediaUrl ?? '') : `autolabel-media://thumb/${asset.id}`;
}
