/**
 * 熱鍵引擎測試 — 驗證 src/shared/hotkeys.js。
 *
 * 純邏輯測試，不需要 Electron 也不需要鍵盤：時間由參數注入，
 * 動作執行以假的 executor 記錄呼叫。
 *
 * 執行：node scripts/test-hotkeys.mjs
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'build', '.test-hk');
const bundle = path.join(tmpDir, 'hotkeys.mjs');

await mkdir(tmpDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/hotkeys.js')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
});

const H = await import(pathToFileURL(bundle).href);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, got, want) =>
  record(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}`);

console.log('\n熱鍵引擎測試\n' + '='.repeat(60));

// 1. Accelerator 轉換（FR-07-01）
console.log('');
console.log('[1] 按鍵組合轉 Electron accelerator');
eq('字母鍵', H.toAccelerator(['KeyA']), 'A');
eq('修飾鍵 + 字母', H.toAccelerator(['Ctrl', 'KeyA']), 'Ctrl+A');
eq('修飾鍵順序自動修正', H.toAccelerator(['KeyA', 'Ctrl']), 'Ctrl+A');
eq('功能鍵', H.toAccelerator(['F5']), 'F5');
eq('兩個修飾鍵', H.toAccelerator(['Ctrl', 'Shift', 'KeyA']), 'Ctrl+Shift+A');
record('只有修飾鍵應拒絕', H.toAccelerator(['Ctrl']) === null);
record('空陣列應拒絕', H.toAccelerator([]) === null);
record('超過兩個修飾鍵應拒絕', H.toAccelerator(['Ctrl', 'Shift', 'Alt', 'KeyA']) === null);

// 小鍵盤與數字列必須產生不同的 accelerator。
// 先前以 event.key 記錄時兩者都是 "1"，導致綁定小鍵盤其實註冊到數字列，
// 按小鍵盤毫無反應——這正是使用者回報的問題。
console.log('');
console.log('[1b] 小鍵盤與主鍵盤數字列的區隔');
eq('數字列 1', H.toAccelerator(['Digit1']), '1');
eq('小鍵盤 1', H.toAccelerator(['Numpad1']), 'num1');
record(
  '兩者的 accelerator 不同',
  H.toAccelerator(['Digit1']) !== H.toAccelerator(['Numpad1']),
  `${H.toAccelerator(['Digit1'])} vs ${H.toAccelerator(['Numpad1'])}`
);
eq('Ctrl + 小鍵盤 1', H.toAccelerator(['Ctrl', 'Numpad1']), 'Ctrl+num1');
eq('小鍵盤加號', H.toAccelerator(['NumpadAdd']), 'numadd');
eq('舊版設定檔的裸鍵名仍可用', H.toAccelerator(['Ctrl', '1']), 'Ctrl+1');

console.log('');
console.log('[1c] 介面顯示名稱');
eq('小鍵盤顯示為中文', H.comboLabel(['Ctrl', 'Numpad1']), 'Ctrl + 小鍵盤1');
eq('數字列顯示為數字', H.comboLabel(['Digit1']), '1');
eq('字母顯示為字母', H.comboLabel(['Ctrl', 'KeyA']), 'Ctrl + A');

console.log('');
console.log('[1d] 由 KeyboardEvent 擷取按鍵（以實體按鍵 code 為準）');
const ev = (code, key, mods = {}) => ({
  code, key,
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
});
eq('小鍵盤 1（其 key 同為 "1"）', H.keysFromEvent(ev('Numpad1', '1')), ['Numpad1']);
eq('數字列 1', H.keysFromEvent(ev('Digit1', '1')), ['Digit1']);
eq('Ctrl + 小鍵盤 1', H.keysFromEvent(ev('Numpad1', '1', { ctrl: true })), ['Ctrl', 'Numpad1']);
eq('Ctrl + Shift + A', H.keysFromEvent(ev('KeyA', 'A', { ctrl: true, shift: true })), ['Ctrl', 'Shift', 'KeyA']);
record('只按修飾鍵時回傳 null（繼續等待主鍵）', H.keysFromEvent(ev('ControlLeft', 'Control', { ctrl: true })) === null);

// ── 2. 衝突偵測（FR-07-08）──
console.log('\n[2] FR-07-08 衝突偵測');
const conflicting = [
  H.createHotkey('a', { name: '揮手', trigger: { keys: ['Ctrl', '1'], mouse: null, screenButton: 1 } }),
  H.createHotkey('b', { name: '微笑', trigger: { keys: ['Ctrl', '1'], mouse: null, screenButton: 2 } }),
  H.createHotkey('c', { name: '截圖', trigger: { keys: ['F9'], mouse: null, screenButton: 1 } }),
  H.createHotkey('d', { name: '停用中', enabled: false, trigger: { keys: ['Ctrl', '1'], mouse: null, screenButton: null } }),
];
const conflicts = H.detectConflicts(conflicting);
record(
  '偵測到鍵盤與畫面按鈕各一組衝突',
  conflicts.length === 2,
  conflicts.map((c) => `${c.kind}=${c.value}(${c.names.join('/')})`).join('；')
);
record(
  '停用的熱鍵不列入衝突',
  !conflicts.some((c) => c.names.includes('停用中')),
  '停用中未出現於衝突清單'
);
record('無衝突時回傳空陣列', H.detectConflicts([conflicting[0]]).length === 0);

// ── 3. 觸發與串接（FR-07-24）──
console.log('\n[3] 動作串接');
const calls = [];
const executor = {
  ToggleExpression: (a, phase) => calls.push(`expr:${a.target}:${phase}`),
  TriggerAnimation: (a, phase) => calls.push(`anim:${a.target}:${phase}`),
  TakeScreenshot: (a, phase) => calls.push(`shot:${phase}`),
  Explodes: () => { throw new Error('故意失敗'); },
};

const engine = new H.HotkeyEngine({ executor });
engine.setHotkeys([
  H.createHotkey('chain', {
    name: '串接',
    trigger: { keys: ['Ctrl', '1'], mouse: null, screenButton: null },
    actions: [
      { type: 'TriggerAnimation', target: '揮手' },
      { type: 'ToggleExpression', target: 'happy' },
      { type: 'TakeScreenshot' },
    ],
  }),
]);
engine.fire('chain', 'down', 100);
eq('三個動作依序執行', calls, ['anim:揮手:start', 'expr:happy:start', 'shot:start']);

// 超過上限應截斷
calls.length = 0;
engine.setHotkeys([
  H.createHotkey('many', {
    trigger: { keys: ['Ctrl', '2'], mouse: null, screenButton: null },
    actions: Array.from({ length: 6 }, (_, i) => ({ type: 'TakeScreenshot', target: i })),
  }),
]);
engine.fire('many', 'down', 200);
record(
  `串接動作上限為 ${H.MAX_CHAINED_ACTIONS} 個`,
  calls.length === H.MAX_CHAINED_ACTIONS,
  `執行了 ${calls.length} 個`
);

// 單一動作失敗不應中斷其餘動作
calls.length = 0;
const errs = [];
const engine2 = new H.HotkeyEngine({ executor, log: (lv, m) => lv === 'error' && errs.push(m) });
engine2.setHotkeys([
  H.createHotkey('mixed', {
    trigger: { keys: ['Ctrl', '3'], mouse: null, screenButton: null },
    actions: [{ type: 'Explodes' }, { type: 'TakeScreenshot' }],
  }),
]);
engine2.fire('mixed', 'down', 300);
record('單一動作丟例外不影響後續動作', calls.includes('shot:start') && errs.length === 1, errs[0] ?? '');

// ── 4. 冷卻（FR-07-23）──
console.log('\n[4] FR-07-23 冷卻時間');
calls.length = 0;
const cd = new H.HotkeyEngine({ executor });
cd.setHotkeys([
  H.createHotkey('cd', {
    trigger: { keys: ['F1'], mouse: null, screenButton: null },
    cooldown: 5,
    actions: [{ type: 'TakeScreenshot' }],
  }),
]);
record('首次觸發成功', cd.fire('cd', 'down', 1000).fired === true);
const blocked = cd.fire('cd', 'down', 1002);
record('冷卻中被忽略', blocked.fired === false && blocked.reason === 'cooldown', `剩餘 ${blocked.remaining?.toFixed(1)} 秒`);
record('冷卻剩餘秒數正確', Math.abs(cd.cooldownRemaining('cd', 1002) - 3) < 1e-6);
record('冷卻結束後可再次觸發', cd.fire('cd', 'down', 1006).fired === true);
record('冷卻期間不排入佇列（只執行 2 次）', calls.length === 2, `實際 ${calls.length} 次`);

// ── 5. 自動停止與放開即停（FR-07-21）──
console.log('\n[5] FR-07-21 自動停止 / 放開即停');
calls.length = 0;
const st = new H.HotkeyEngine({ executor });
st.setHotkeys([
  H.createHotkey('auto', {
    trigger: { keys: ['F2'], mouse: null, screenButton: null },
    autoStopSeconds: 1,
    actions: [{ type: 'ToggleExpression', target: 'happy' }],
  }),
  H.createHotkey('hold', {
    trigger: { keys: ['F3'], mouse: null, screenButton: null },
    stopOnRelease: true,
    actions: [{ type: 'ToggleExpression', target: 'angry' }],
  }),
]);

st.fire('auto', 'down', 2000);
st.update(0.5, 2000.5);
record('0.5 秒時尚未自動停止', !calls.includes('expr:happy:stop'));
st.update(0.6, 2001.1);
record('1 秒後自動停止', calls.includes('expr:happy:stop'), calls.join(' '));

calls.length = 0;
st.fire('hold', 'down', 3000);
record('按下時執行 start', calls.includes('expr:angry:start'));
st.fire('hold', 'up', 3000.4);
record('放開時執行 stop', calls.includes('expr:angry:stop'), calls.join(' '));

// ── 6. 查找與全域註冊 ──
console.log('\n[6] 觸發來源查找與全域註冊');
const lookup = new H.HotkeyEngine({ executor });
lookup.setHotkeys([
  H.createHotkey('k', { trigger: { keys: ['Ctrl', 'KeyS'], mouse: null, screenButton: null } }),
  H.createHotkey('m', { trigger: { keys: [], mouse: 'middle', screenButton: null } }),
  H.createHotkey('s', { trigger: { keys: [], mouse: null, screenButton: 3 } }),
  H.createHotkey('off', { enabled: false, trigger: { keys: ['Ctrl', 'KeyQ'], mouse: null, screenButton: null } }),
]);
record('依 accelerator 查找', lookup.findByAccelerator('Ctrl+S')?.id === 'k');
record('依滑鼠鍵查找', lookup.findByMouse('middle')?.id === 'm');
record('依畫面按鈕查找', lookup.findByScreenButton(3)?.id === 's');
record('停用的熱鍵查不到', lookup.findByAccelerator('Ctrl+Q') === null);
eq('全域註冊清單只含有效鍵盤組合', lookup.globalBindings(), [{ id: 'k', accelerator: 'Ctrl+S' }]);

// ── 7. 動作清單完整性（FR-07-B）──
console.log('\n[7] FR-07-B 動作清單');
const codes = Object.values(H.HOTKEY_ACTIONS).map((a) => a.code).sort((a, b) => a - b);
record(
  '共 14 種動作且編號 0–13 連續',
  codes.length === 14 && codes.every((c, i) => c === i),
  `編號 ${codes[0]}–${codes[codes.length - 1]}`
);

// ────────────────────────────────────────────────────────────────

await rm(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(`結果：${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n失敗項目：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log();

process.exit(failed.length ? 1 : 0);
