// 試験用の計算式プラグインの zip の合成（stored。中身はスタブで、計算式プラグインのコードを含まない。tools の test/zip-helper.mjs と同じ 2 層の形）。
// 計算式プラグインの公開鍵は本物の zip の PUBKEY（公開鍵なので試験に置いてよい）。中核は SIGNATURE を検証しない
import { crc32 } from "node:zlib";

/** stored の zip（ZIP64 なし） */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const data = Buffer.isBuffer(entries[name]) ? entries[name] : Buffer.from(entries[name], "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 計算式プラグインの公開鍵（本物の zip の PUBKEY。spki の DER） */
export const PRINT_CRAFT_PUBKEY = Buffer.from(
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCCNIFs3e8gQlhFVpHJpE3Tz2loDgMyClEEsLnTSDwGfB8mvRvK5mq1+8ez6iQiWGLT2NxJoMPnSUsnzBY3il7dFYyG1Pp0W/+k1EKkBEFESsHI37eBKSKXaCncb8e8x+TZrax57v24K5NFXMmVsph89dHzWC7Sea0fJsS0IpYIiQIDAQAB",
  "base64"
);

/** 計算式プラグインの zip と同じ 2 層の合成 zip（outerExtra で PUBKEY を差し替え、null で外す） */
export function makePluginZip(inner, outerExtra = {}) {
  const outer = { "contents.zip": makeZip(inner), PUBKEY: PRINT_CRAFT_PUBKEY, SIGNATURE: "stub", ...outerExtra };
  for (const k of Object.keys(outer)) if (outer[k] === null) delete outer[k];
  return makeZip(outer);
}

/** 合成 zip の中身の既定（Ver.6 の形。コードはすべてスタブ） */
export function stubInnerEntries(overrides = {}) {
  return {
    "manifest.json": JSON.stringify({ manifest_version: 1, version: 6, name: { ja: "stub" }, config: { js: ["config_js/formula-authoring-api.js"] } }),
    "desktop_js/KintoneFormulaPCraft.min.js": "window.rex0220p = { KintoneFormulaPCraft: function () { this.funs = {}; } };",
    "desktop_js/bignumber.min.js": "window.rex0220_BigNumber = function () {};",
    "desktop_js/moment-timezone-with-data.min.js": "/* stub */",
    "config_js/formula-authoring-api.js": 'window.rex0220PrintCraftAuthoring = { apiVersion: 1, pluginVersion: "6" };',
    ...overrides
  };
}
