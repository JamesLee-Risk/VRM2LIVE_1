/**
 * 讀取 --selftest 的輸出並印出摘要。
 *
 * 獨立成檔而非寫在命令列，是因為解析用的正規表示式含有會被
 * 外層 shell 誤判的字元序列。
 *
 * 用法：node scripts/read-selftest.mjs <log 檔> [--all]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'st.log';
const showAll = process.argv.includes('--all');

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.log(`讀不到 ${file}`);
  process.exit(1);
}

const start = text.indexOf('===== SELFTEST RESULT =====');
const end = text.indexOf('===== END SELFTEST =====');

if (start < 0 || end < 0) {
  console.log('沒有找到自我測試結果。輸出結尾：');
  console.log(text.slice(-800));
  process.exit(1);
}

let result;
try {
  result = JSON.parse(text.slice(start + '===== SELFTEST RESULT ====='.length, end).trim());
} catch (err) {
  console.log(`結果無法解析：${err.message}`);
  process.exit(1);
}

const passed = result.checks.filter((c) => c.ok).length;
console.log(`selftest: ${passed}/${result.checks.length} 通過`);

const rows = showAll ? result.checks : result.checks.filter((c) => !c.ok);
for (const c of rows) {
  console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${String(c.id).padEnd(14)} ${c.detail ?? ''}`);
}

const warns = (text.match(/\[WARN\]/g) ?? []).length;
const errs = (text.match(/\[ERROR\]/g) ?? []).length;
console.log(`WARN=${warns} ERROR=${errs}`);

process.exit(result.pass ? 0 : 1);
