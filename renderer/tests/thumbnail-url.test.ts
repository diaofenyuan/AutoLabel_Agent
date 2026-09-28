import assert from 'node:assert/strict';
import test from 'node:test';
import { thumbnailUrlForAsset } from '../src/thumbnailUrl';

const asset = { id: 'asset-1', thumbnailUrl: 'data:image/png;base64,demo-thumb', mediaUrl: 'data:image/png;base64,demo-full' };

test('浏览器演示使用数据提供的缩略图或原图地址', () => {
  assert.equal(thumbnailUrlForAsset(asset, true), asset.thumbnailUrl);
  assert.equal(thumbnailUrlForAsset({ ...asset, thumbnailUrl: undefined }, true), asset.mediaUrl);
});

test('桌面端继续使用受控的本地缩略图协议', () => {
  assert.equal(thumbnailUrlForAsset(asset, false), 'autolabel-media://thumb/asset-1');
});
