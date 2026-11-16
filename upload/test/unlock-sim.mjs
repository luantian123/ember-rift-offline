/**
 * 全解锁补丁的功能验证（不需要浏览器）
 * 从构建产物里按**代码形状**抽出被改过的两个判定函数，喂假数据跑一遍。
 * 因为官方每次更新都会换压缩变量名（Kl→jf、wo→cn、p→m），这里一律按结构匹配。
 *
 * 跑法：node test/unlock-sim.mjs [产物路径]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || join(here, '..', 'dist', 'index.html');
const html = readFileSync(target, 'utf8');

/* --- 按形状抽出补丁后的两段代码 --- */
const petM = html.match(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>!!([A-Za-z_$][\w$]*)\[\2\]/);
const cosM = html.match(
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return!([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)\(\2\)\[\3\]\?!1:!0\}/
);

if (!petM || !cosM) {
  console.error('✗ 没找到补丁后的判定函数，这个产物可能是未打补丁的版本');
  console.error('  pet:', petM && petM[0]);
  console.error('  cos:', cosM && cosM[0]);
  process.exit(1);
}

const [, petFn, petArg, petCat] = petM;
const [, cosFn, aArg, bArg, stateVar, cosCat] = cosM;

console.log('抽到补丁后代码：');
console.log('  ' + petM[0]);
console.log('  ' + cosM[0]);

/* --- 假数据：一个什么都没解锁的新角色 --- */
const pets = {
  wisp: { n: '烬灵', free: true },
  dragon: { n: '千烬游龙', lim: '群破 1000 限定' },
  eye: { n: '虚空之眼', lim: '第 90 层' },
  taisui: { n: '符镇太岁', lim: 'V20 限时', r: '绝版' },
};
const state = { pets: [], cos: {}, titles: [], look: {} };
const catalog = (kind) =>
  ({
    title: { t1: {}, t2: {} },
    pet: { wisp: {}, dragon: {}, eye: {}, taisui: {} },
    mount: { steed: {}, qilin: {} },
    wings: { w1: {} },
    aura: { a1: {} },
  })[kind] || {};

/* 用真实变量名当形参注入，避免依赖任何固定标识符 */
const build = new Function(
  petCat,
  cosCat,
  stateVar,
  `
  var ${petFn};
  ${petM[0]};
  ${cosM[0]};
  return { pet: ${petFn}, cos: ${cosFn} };
  `
);
const { pet, cos } = build(pets, catalog, state);

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label);
  }
};

console.log('\n[宠物]');
ok(pet('wisp') === true, '默认宠物 烬灵 可用');
ok(pet('dragon') === true, '群限定 千烬游龙 已解锁');
ok(pet('eye') === true, '第 90 层 虚空之眼 已解锁');
ok(pet('taisui') === true, '绝版 符镇太岁 已解锁');
ok(pet('nope') === false, '不存在的 id 仍然是 false');

console.log('\n[外观 / 称号 / 坐骑]');
ok(cos('pet', 'dragon') === true, 'pet 可装备');
ok(cos('mount', 'qilin') === true, 'mount 可装备');
ok(cos('wings', 'w1') === true, 'wings 可装备');
ok(cos('title', 't2') === true, 'title 可装备');
ok(cos('aura', 'a1') === true, 'aura 可装备');
ok(cos('wings', 'not-exist') === false, '不存在/不属于该职业的 id 仍被拦住');

console.log('\n[存档未被写入]');
ok(state.pets.length === 0 && Object.keys(state.cos).length === 0, '判定全程没有往存档里塞东西');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
