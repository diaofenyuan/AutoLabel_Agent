// 纯 node 单测里的 electron 桩：vault 只用到 safeStorage 的加解密接口，这里给确定性实现。
// 真实加密链路由 smoke:desktop 的 credentialEncryptedAtRest / credentialRoundtrip 覆盖，不在单测重复。
const encode = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
module.exports = {
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => encode(value),
    decryptString: value => Buffer.from(value).toString('utf8'),
  },
  app: { getPath: () => require('node:os').tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false },
  utilityProcess: { fork: () => { throw new Error('electron 桩：utilityProcess 不应在纯单测中使用'); } },
};
