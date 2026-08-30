/**
 * 模型掃描與中繼資料解析 — FR-01-01、FR-01-02、FR-01-04、FR-01-05、FR-01-06。
 *
 * 為了讓模型清單能即時列出授權資訊，這裡**不載入 3D 內容**，
 * 只讀取 GLB 容器最前面的 JSON chunk（通常數百 KB），
 * 因此 30 MB 的模型也能在毫秒級解析完中繼資料。
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * 讀取 GLB 的 JSON chunk。
 * @param {string} file
 * @returns {Promise<object>} glTF JSON
 */
async function readGltfJson(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await fh.read(header, 0, 12, 0);
    if (bytesRead < 12) throw new Error('檔案過小，非有效的 GLB');

    const magic = header.readUInt32LE(0);
    if (magic !== GLB_MAGIC) throw new Error('不是 GLB 容器（magic 不符）');
    const version = header.readUInt32LE(4);
    if (version !== 2) throw new Error(`不支援的 glTF 版本：${version}`);

    const chunkHeader = Buffer.alloc(8);
    await fh.read(chunkHeader, 0, 8, 12);
    const chunkLength = chunkHeader.readUInt32LE(0);
    const chunkType = chunkHeader.readUInt32LE(4);
    if (chunkType !== CHUNK_JSON) throw new Error('第一個 chunk 不是 JSON');
    if (chunkLength > 64 * 1024 * 1024) throw new Error('JSON chunk 異常龐大');

    const json = Buffer.alloc(chunkLength);
    await fh.read(json, 0, chunkLength, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    await fh.close();
  }
}

/**
 * 把 VRM 0.x 與 1.0 兩種中繼資料結構正規化成同一份摘要。
 * 兩代的授權欄位命名完全不同，此處吸收差異（FR-01-02）。
 */
function normalizeMeta(gltf) {
  const ext = gltf.extensions ?? {};

  if (ext.VRMC_vrm) {
    const m = ext.VRMC_vrm.meta ?? {};
    return {
      specVersion: '1.0',
      title: m.name ?? '(未命名)',
      version: m.version ?? '',
      author: (m.authors ?? []).join('、') || '(未署名)',
      contact: m.contactInformation ?? '',
      reference: (m.references ?? []).join(' '),
      license: {
        avatarPermission: m.avatarPermission ?? 'onlyAuthor',
        commercialUsage: m.commercialUsage ?? 'personalNonProfit',
        allowRedistribution: m.allowRedistribution ?? false,
        modification: m.modification ?? 'prohibited',
        licenseUrl: m.licenseUrl ?? '',
      },
    };
  }

  if (ext.VRM) {
    const m = ext.VRM.meta ?? {};
    return {
      specVersion: '0.x',
      title: m.title ?? '(未命名)',
      version: m.version ?? '',
      author: m.author ?? '(未署名)',
      contact: m.contactInformation ?? '',
      reference: m.reference ?? '',
      license: {
        allowedUserName: m.allowedUserName ?? 'OnlyAuthor',
        commercialUssageName: m.commercialUssageName ?? 'Disallow',
        violentUssageName: m.violentUssageName ?? 'Disallow',
        sexualUssageName: m.sexualUssageName ?? 'Disallow',
        licenseName: m.licenseName ?? 'Other',
        otherLicenseUrl: m.otherPermissionUrl ?? m.otherLicenseUrl ?? '',
      },
    };
  }

  return null;
}

/**
 * 產生授權摘要與警語（FR-01-05、FR-01-06）。
 * 回傳的 restrictions 會在模型傳輸、截圖分享等出口顯示。
 */
function summarizeLicense(meta) {
  if (!meta) return { summary: '（無授權資訊）', restrictions: [] };

  const restrictions = [];
  let summary;

  if (meta.specVersion === '1.0') {
    const L = meta.license;
    summary = [
      `使用者：${{ onlyAuthor: '僅作者', explicitlyLicensedPerson: '獲授權者', everyone: '所有人' }[L.avatarPermission] ?? L.avatarPermission}`,
      `商業使用：${{ personalNonProfit: '個人非營利', personalProfit: '個人營利', corporation: '法人' }[L.commercialUsage] ?? L.commercialUsage}`,
    ].join('／');
    if (L.allowRedistribution === false) restrictions.push('此模型禁止再散布');
    if (L.commercialUsage === 'personalNonProfit') restrictions.push('此模型禁止商業使用');
    if (L.modification === 'prohibited') restrictions.push('此模型禁止改作');
  } else {
    const L = meta.license;
    summary = [
      `使用者：${{ Everyone: '所有人', ExplicitlyLicensedPerson: '獲授權者', OnlyAuthor: '僅作者' }[L.allowedUserName] ?? L.allowedUserName}`,
      `商業使用：${L.commercialUssageName === 'Allow' ? '允許' : '禁止'}`,
      `授權：${L.licenseName}`,
    ].join('／');
    if (/Redistribution_Prohibited/i.test(L.licenseName)) restrictions.push('此模型禁止再散布');
    if (L.commercialUssageName !== 'Allow') restrictions.push('此模型禁止商業使用');
    if (L.allowedUserName === 'OnlyAuthor') restrictions.push('此模型僅限作者本人使用');
  }

  return { summary, restrictions };
}

/**
 * 掃描 Models/ 資料夾（含子資料夾）。
 * @param {string} modelsDir
 * @returns {Promise<object[]>}
 */
async function scanModels(modelsDir) {
  const found = [];

  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.vrm')) {
        found.push(full);
      }
    }
  }

  await walk(modelsDir, 0);

  const models = [];
  for (const file of found) {
    const stat = await fsp.stat(file);
    const entry = {
      path: file,
      name: path.basename(file, path.extname(file)),
      sizeBytes: stat.size,
      meta: null,
      license: null,
      error: null,
    };

    try {
      const gltf = await readGltfJson(file);
      const meta = normalizeMeta(gltf);
      if (!meta) throw new Error('缺少 VRM 擴充，可能是一般 glTF 而非 VRM');
      entry.meta = meta;
      entry.license = summarizeLicense(meta);
      entry.stats = {
        meshes: gltf.meshes?.length ?? 0,
        materials: gltf.materials?.length ?? 0,
        textures: gltf.textures?.length ?? 0,
        nodes: gltf.nodes?.length ?? 0,
      };
      // 大型模型提示（FR-01-18）
      entry.heavy = stat.size > 50 * 1024 * 1024;
    } catch (err) {
      // 毀損檔案不得中斷整份清單（NFR-R-06）
      entry.error = err.message;
    }

    models.push(entry);
  }

  models.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return models;
}

module.exports = { scanModels, readGltfJson, normalizeMeta, summarizeLicense };
