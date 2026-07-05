// Reaction-file schema registry + parser/serializer. Same block format as the
// detector file, plus a block "argument" (e.g. `Decay 12C`).
import { composeNum } from './detector.js'

export const REACTION_BLOCKS = {
  Beam: {
    label: 'Beam', single: true,
    fields: [
      { key: 'Particle', label: 'Particle', type: 'text', comment: '빔 입자 (예: 1H, 34Ar)' },
      { key: 'Energy', label: 'Energy', type: 'num', n: 1, unit: 'MeV' },
      { key: 'SigmaEnergy', label: 'σ Energy', type: 'num', n: 1, unit: 'MeV', comment: '에너지 퍼짐' },
      { key: 'SigmaThetaX', label: 'σ θx', type: 'num', n: 1, unit: 'deg' },
      { key: 'SigmaPhiY', label: 'σ φy', type: 'num', n: 1, unit: 'deg' },
      { key: 'SigmaX', label: 'σ x', type: 'num', n: 1, unit: 'mm' },
      { key: 'SigmaY', label: 'σ y', type: 'num', n: 1, unit: 'mm' },
      { key: 'MeanThetaX', label: 'mean θx', type: 'num', n: 1, unit: 'deg' },
      { key: 'MeanPhiY', label: 'mean φy', type: 'num', n: 1, unit: 'deg' },
      { key: 'MeanX', label: 'mean x', type: 'num', n: 1, unit: 'mm' },
      { key: 'MeanY', label: 'mean y', type: 'num', n: 1, unit: 'mm' },
      { key: 'ZEmission', label: 'Z emission', type: 'num', n: 1, unit: 'mm', comment: '빔 출발 z 위치' },
    ],
  },
  TwoBodyReaction: {
    label: 'Two-body reaction',
    fields: [
      { key: 'Beam', label: 'Beam', type: 'text' },
      { key: 'Target', label: 'Target', type: 'text', comment: '표적 핵 (예: 12C, 4He)' },
      { key: 'Light', label: 'Light ejectile', type: 'text', comment: '가벼운 방출 입자' },
      { key: 'Heavy', label: 'Heavy recoil', type: 'text', comment: '무거운 잔류핵' },
      { key: 'ExcitationEnergyLight', label: 'Ex (light)', type: 'num', n: 1, unit: 'MeV' },
      { key: 'ExcitationEnergyHeavy', label: 'Ex (heavy)', type: 'num', n: 1, unit: 'MeV' },
      { key: 'CrossSectionPath', label: 'Cross-section', type: 'text', comment: '미분단면적 파일 (예: flat.txt CS)' },
      { key: 'ShootLight', label: 'Shoot light', type: 'choice', choices: ['0', '1'], comment: 'light 입자 추적' },
      { key: 'ShootHeavy', label: 'Shoot heavy', type: 'choice', choices: ['0', '1'], comment: 'heavy 핵 추적' },
    ],
  },
  // nptool's Isotropic event generator (EventGeneratorIsotropic) — an isotropic
  // source, no beam/two-body kinematics. Used by e.g. STARK.
  Isotropic: {
    label: 'Isotropic source', optional: true,
    fields: [
      { key: 'EnergyLow', label: 'Energy low', type: 'num', n: 1, unit: 'MeV', comment: '최소 방출 에너지' },
      { key: 'EnergyHigh', label: 'Energy high', type: 'num', n: 1, unit: 'MeV', comment: '최대 방출 에너지' },
      { key: 'EnergyDistribution', label: 'Energy dist.', type: 'choice', choices: ['Flat', 'FromHisto'],
        comment: '에너지 분포: Flat(균일) 또는 FromHisto(ROOT 히스토그램에서 샘플링)' },
      { key: 'EnergyDistributionHist', label: 'Energy histo', type: 'text',
        comment: 'FromHisto일 때 사용할 ROOT 파일과 히스토그램 이름 (예: spectrum.root h_gamma)' },
      { key: 'HalfOpenAngleMin', label: 'Half angle min', type: 'num', n: 1, unit: 'deg', comment: '방출 극각(θ) 최소' },
      { key: 'HalfOpenAngleMax', label: 'Half angle max', type: 'num', n: 1, unit: 'deg', comment: '방출 극각(θ) 최대 (등방이면 180)' },
      { key: 'Direction', label: 'Direction', type: 'choice', choices: ['x', 'y', 'z'],
        comment: '방출 원뿔의 중심축 방향 (콜리메이션 축)' },
      { key: 'x0', label: 'x0', type: 'num', n: 1, unit: 'mm', comment: '소스 위치 x' },
      { key: 'y0', label: 'y0', type: 'num', n: 1, unit: 'mm', comment: '소스 위치 y' },
      { key: 'z0', label: 'z0', type: 'num', n: 1, unit: 'mm', comment: '소스 위치 z' },
      { key: 'Multiplicity', label: 'Multiplicity', type: 'num', n: 1, comment: '이벤트당 방출 입자 수' },
      { key: 'Particle', label: 'Particle', type: 'choice',
        choices: ['gamma', 'proton', 'neutron', 'deuton', 'triton', 'He3', 'alpha', 'e-', 'e+'],
        comment: '방출 입자 종류' },
    ],
  },
  Decay: {
    label: 'Decay', repeatable: true, optional: true,
    arg: { label: 'Nucleus', comment: '붕괴하는 핵 (예: 12C)' },
    fields: [
      { key: 'Threshold', label: 'Threshold', type: 'num', n: 1, unit: 'MeV', comment: '붕괴 임계 들뜸에너지' },
      { key: 'Daughter', label: 'Daughters', type: 'tokens', comment: '붕괴 생성핵 (예: 4He 4He 4He)' },
      { key: 'ExcitationEnergy', label: 'Ex energies', type: 'tokens', comment: '각 생성핵 들뜸 (예: 0 0 0 MeV)' },
      { key: 'BranchingRatio', label: 'Branching ratio', type: 'num', n: 1 },
      { key: 'LifeTime', label: 'Lifetime', type: 'num', n: 1, unit: 'ns' },
      { key: 'Shoot', label: 'Shoot', type: 'tokens', comment: '각 생성핵 추적 여부 (예: 1 1 1)' },
    ],
  },
}

export function parseReaction(text) {
  const blocks = []
  let buf = [], cur = null
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const t = line.trim()
    if (t === '' || t.startsWith('%')) { buf.push(line); continue }
    if (!/^\s/.test(line)) {
      const parts = t.split(/\s+/)
      cur = { type: parts[0], arg: parts.slice(1).join(' '), header: buf, params: [] }
      blocks.push(cur); buf = []
    } else if (cur && line.includes('=')) {
      const i = line.indexOf('=')
      cur.params.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
  }
  return blocks
}

export function serializeReaction(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.header) out.push(...b.header)
    out.push(b.arg ? `${b.type} ${b.arg}` : b.type)
    for (const p of b.params) out.push(`    ${p.key} = ${p.value}`)
  }
  return out.join('\n').replace(/\n*$/, '\n')
}

export function newReactionBlock(type) {
  const spec = REACTION_BLOCKS[type]
  const params = spec.fields.map((f) => ({
    key: f.key,
    value: f.default ?? (f.type === 'num' ? composeNum(Array(f.n).fill('0'), f.unit)
      : f.type === 'choice' ? f.choices[0] : ''),
  }))
  return { type, arg: spec.arg ? '12C' : '', header: [`%% ${type}`], params }
}
