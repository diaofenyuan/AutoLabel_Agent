import { useEffect, useState } from 'react';

interface AssetThumbnailProps {
  src: string;
  alt: string;
  retryKey: number;
  onFailureChange: (failed: boolean) => void;
}

/**
 * 素材缩略图的统一失败态：协议图片可能因引擎重启或缓存失效暂时读不到，
 * 这里保留卡片尺寸并提供就地重试，避免整张素材卡变成空白或误导成无素材。
 */
export default function AssetThumbnail({ src, alt, retryKey, onFailureChange }: AssetThumbnailProps) {
  const [failed, setFailed] = useState(!src);

  useEffect(() => {
    setFailed(!src);
    onFailureChange(!src);
    // src 变化时重置失败态；重试由父级更新 key 重新挂载，不把回调放进依赖避免重复触发父级更新。
  }, [src]);

  if (failed) return <span className="asset-thumbnail-failure" role="img" aria-label={`${alt}缩略图加载失败`}>缩略图加载失败</span>;

  return <img key={`${src}:${retryKey}`} loading="lazy" src={src} alt={alt} onError={() => {
    setFailed(true);
    onFailureChange(true);
  }} />;
}
