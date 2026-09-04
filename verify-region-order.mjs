// verify-region-order.mjs — 行为级回归验证脚本（非插件源码，可随时重跑）
//
// 目标：在 `session.surface.nodes` 乱序（检查点大 seq 居前）的桩下，验证
// region.js 三个压缩 selector 的返回改为"按位置序 {start, end}"后：
//   (1) 全部非 null（旧实现该面因 value 折叠恒 null/被 validate 拒绝）；
//   (2) 返回的 start/end 按 surface 位置成立（indexOf(start) < indexOf(end)），
//       即使数值上 start > end（值倒置可接受）；
//   (3) 消费者解析（validateSurfaceRegionSafe / index 切片投影）全部通过；
//   (4) 诊断字段（retainedTokens / crossing* / boundaryKind）保留；
//   (5) 配对账本在乱序面上 fold 正常（toolPairingBalanced* 非 SAFE 不抛）。
//
// 运行：node verify-region-order.mjs（工作目录 dsh-force-compact）

import {
  selectRegion,
  selectEarliestByMeasurements,
  selectRetainingLatestTokens,
  selectEarliestByTokens,
  validateSurfaceRegionSafe,
} from './src/engine/region.js'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from './src/core/pairing.js'

// ---------------------------------------------------------------- 桩构造

// 实证形状：一次已提交压缩把检查点 user/message 拼到 surface 头部，于是
// `surface.nodes` 位置序与 seq 值序相反 —— idx0 是检查点大 seq，其后是幸存
// 旧节点（小 seq 递增）。这里 60710 为检查点，60696..60709 为幸存节点。
const SURFACE = [60710]
for (let s = 60696; s <= 60709; s += 1) SURFACE.push(s)
const TOTAL = SURFACE.length // 15

// 事件日志：seq == 数组下标（现代 snapshotEvents 的连续契约）。全
// `user/message`（eventDelta=0）→ 所有切点配对平衡，账本桩完备。
const MAX_SEQ = 60710
const EVENTS = []
for (let i = 0; i <= MAX_SEQ; i += 1) {
  EVENTS.push({
    seq: i,
    time: new Date(0).toISOString(),
    type: 'user/message',
    data: { content: [{ type: 'text', text: `m${i}` }] },
  })
}

const session = {
  surface: { nodes: SURFACE, replaceGeneration: 0 },
  snapshotEvents: () => EVENTS,
}

// tokenMeter.measure 快照：逐节点价与 surface 同序（每个 200 tokens）。
const measurement = { nodes: SURFACE.map(seq => ({ seq, tokens: 200 })), totalTokens: 3000 }

// ---------------------------------------------------------------- 断言机

let failed = 0
function assert(cond, label, extra) {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${extra !== undefined ? `  →  ${JSON.stringify(extra)}` : ''}`)
  }
}
const positionOf = seq => SURFACE.indexOf(seq)
const positionalOrder = r => r !== null && positionOf(r.start) < positionOf(r.end)
const consumerProjection = r => SURFACE.slice(positionOf(r.start), positionOf(r.end) + 1)

console.log(`桩: total=${TOTAL} nodes=${JSON.stringify(SURFACE)}`)
console.log('（注：idx0=60710 为检查点大 seq，值序与位置序相反 —— 实证 60698@idx12..60702@idx0 的同构）')

// ---------------------------------------------------------------- 配对账本健康性

console.log('\n[0] 配对账本在乱序面上的 fold 健康性（非 SAFE 直调）:')
try {
  assert(toolPairingBalancedBefore(session, 60710) === true, 'toolPairingBalancedBefore(60710@idx0) === true（不抛）')
  assert(toolPairingBalancedAfter(session, 60706) === true, 'toolPairingBalancedAfter(60706) === true（不抛）')
} catch (e) {
  failed += 1
  console.log(`  FAIL  账本抛异常: ${e.message}`)
}

// ---------------------------------------------------------------- [1] selectRegion（检查点路径）

console.log('\n[1] selectRegion（session/flush 检查点路径）:')
{
  const config = { minNodes: 2, retainRatio: 0.2, minCompactableNodes: 2 }
  const r = selectRegion(session, config)
  assert(r !== null, ` 非 null（旧实现该面因值比较恒 null）`, r)
  if (r !== null) {
    assert(positionalOrder(r), ` 位置序成立: start=${r.start}@${positionOf(r.start)} < end=${r.end}@${positionOf(r.end)}`, r)
    assert(consumerProjection(r).length === 11, ` 消费者投影段长 == 11（keepFromIdx-1）`, consumerProjection(r).map(n => ({ seq: n, idx: positionOf(n) })))
    const v = validateSurfaceRegionSafe(session, r.start, r.end)
    assert(v !== null, ' validateSurfaceRegionSafe(start, end) 非 null', v)
  }
}

// ---------------------------------------------------------------- [2] selectEarliestByMeasurements

console.log('\n[2] selectEarliestByMeasurements(session, 0.5, measurement):')
{
  const r = selectEarliestByMeasurements(session, 0.5, measurement)
  assert(r !== null, ' 非 null', r)
  if (r !== null) {
    assert(positionalOrder(r), ` 位置序成立: start=${r.start}@${positionOf(r.start)} < end=${r.end}@${positionOf(r.end)}`, r)
    assert(consumerProjection(r).length === 8, ` 消费者投影段长 == 8（预算 1500 跨界于 idx7）`, consumerProjection(r))
    const v = validateSurfaceRegionSafe(session, r.start, r.end)
    assert(v !== null, ' validateSurfaceRegionSafe(start, end) 非 null', v)
  }
}

// ---------------------------------------------------------------- [3] selectRetainingLatestTokens

console.log('\n[3] selectRetainingLatestTokens(session, 500, measurement):')
{
  const r = selectRetainingLatestTokens(session, 500, measurement)
  assert(r !== null, ' 非 null', r)
  if (r !== null) {
    assert(positionalOrder(r), ` 位置序成立: start=${r.start}@${positionOf(r.start)} < end=${r.end}@${positionOf(r.end)}`, r)
    assert(consumerProjection(r).length === 12, ` 消费者投影段长 == 12（尾保留 3 节点 600 >= 500）`, consumerProjection(r))
    assert(r.retainedTokens === 600, ` retainedTokens == 600（诊断字段保留）`, r.retainedTokens)
    assert(r.crossingAccBefore === 400 && r.crossingNodeSize === 200 && r.crossingAccAfter === 600,
      ' crossingAccBefore=400 / crossingNodeSize=200 / crossingAccAfter=600（crossing* 诊断保留）',
      { crossingAccBefore: r.crossingAccBefore, crossingNodeSize: r.crossingNodeSize, crossingAccAfter: r.crossingAccAfter })
    assert(r.boundaryKind === 'crossing-fallback', ` boundaryKind='crossing-fallback'（诊断保留）`, r.boundaryKind)
    const v = validateSurfaceRegionSafe(session, r.start, r.end)
    assert(v !== null, ' validateSurfaceRegionSafe(start, end) 非 null', v)
  }
}

// ---------------------------------------------------------------- [4] selectEarliestByTokens（回归护栏）

console.log('\n[4] selectEarliestByTokens(session, 1500)（原样位置序，回归护栏）:')
{
  const r = selectEarliestByTokens(session, 1500)
  assert(r !== null, ' 非 null', r)
  if (r !== null) {
    assert(positionalOrder(r), ` 位置序成立: start=${r.start}@${positionOf(r.start)} < end=${r.end}@${positionOf(r.end)}`, r)
    const v = validateSurfaceRegionSafe(session, r.start, r.end)
    assert(v !== null, ' validateSurfaceRegionSafe(start, end) 非 null', v)
  }
}

// ---------------------------------------------------------------- 旧实现对照（实证复现）

console.log('\n[5] 修复前 value 折叠的对照（实证复现）:')
{
  // 旧逻辑 Math.min/max 折叠 → {start: 60696, end: 60710}；60710@idx0 居前，
  // indexOf(60696)=1 > lastIndexOf(60710)=0 → validateSurfaceRegionSafe 判倒置拒绝。
  const v = validateSurfaceRegionSafe(session, 60696, 60710)
  assert(v === null, ' validateSurfaceRegionSafe(60696, 60710) === null（旧折叠产物被消费者拒绝）', v)
  // 未折叠的数值倒置对：值上 start>end 但位置序成立 —— 修复后契约允许并接受。
  const w = validateSurfaceRegionSafe(session, 60710, 60702)
  assert(w !== null, ' validateSurfaceRegionSafe(60710, 60702) 非 null（值倒置但位置序成立 → 接受）', w)
}

// ---------------------------------------------------------------- 汇总

console.log('')
if (failed === 0) {
  console.log(`全部 ${7} 组断言通过 ✅`)
  process.exitCode = 0
} else {
  console.log(`存在 ${failed} 个 FAIL ❌`)
  process.exitCode = 1
}