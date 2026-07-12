// Detector-file schema registry + parser/serializer. Adding a detector type is a
// new entry in DETECTOR_BLOCKS. The form renders the params actually PRESENT in
// each block (so STARK's POS/Rotate vs Rho/Phi/Z variants both work); schema
// metadata (label/type/unit/comment) is used when a key is known. `core` fields
// are the ones a freshly-added block starts with.

// nptool material library (NPSimulation/Core/MaterialManager.cc); free text also OK.
export const MATERIALS = [
  'CH2', 'CD2', 'C', 'Mylar', 'Kapton', 'PMMA', 'PCB', 'Epoxy', 'Si', 'Au', 'Al',
  'Ti', 'Ta', 'Tantalum', 'Pb', 'Cu', 'Fe', 'Be', 'Ge', 'CsI', 'NaI', 'BGO', 'LaBr3',
  'CeBr3', 'BaF2', 'Air', 'Vacuum', 'He', '3He', 'D2', 'H2', 'LH2', 'CF4', 'CO2',
  'CH4', 'P10', 'isobutane', 'iC4H10', 'StainlessSteel', 'Havar', 'Kovar', 'Inox',
  'NaturalUranium', '238U', '235U', 'Gd', 'W', 'concrete',
]

// shown next to a chosen material so the user sees its composition
export const MATERIAL_COMPOSITION = {
  CH2: 'C H₂ · polyethylene', CD2: 'C D₂ · deuterated PE', C: 'C · carbon',
  CH4: 'C H₄ · methane (gas)', CO2: 'C O₂ (gas)', CF4: 'C F₄ (gas)',
  Mylar: 'C₁₀ H₈ O₄ · PET', Kapton: 'C₂₂ H₁₀ N₂ O₅ · polyimide',
  PMMA: 'C₅ H₈ O₂ · acrylic', PCB: 'FR4 · epoxy+glass', Epoxy: 'C₂₁ H₂₅ Cl O₅',
  Si: 'Si', Au: 'Au · gold', Al: 'Al', Ti: 'Ti', Ta: 'Ta', Tantalum: 'Ta',
  Pb: 'Pb · lead', Cu: 'Cu', Fe: 'Fe', Be: 'Be', Ge: 'Ge', W: 'W · tungsten',
  CsI: 'Cs I', NaI: 'Na I', BGO: 'Bi₄ Ge₃ O₁₂', LaBr3: 'La Br₃',
  CeBr3: 'Ce Br₃', BaF2: 'Ba F₂', Air: 'N₂ O₂ Ar', Vacuum: 'vacuum',
  He: 'He (gas)', '3He': '³He (gas)', D2: 'D₂ (gas)', H2: 'H₂ (gas)', LH2: 'liquid H₂',
  P10: 'Ar 90% + CH₄ 10%', isobutane: 'C₄ H₁₀', iC4H10: 'C₄ H₁₀',
  StainlessSteel: 'Fe Cr Ni', Havar: 'Co Cr Ni Fe', Kovar: 'Fe Ni Co', Inox: 'stainless',
  NaturalUranium: 'U (nat)', '238U': '²³⁸U', '235U': '²³⁵U', Gd: 'Gd', concrete: 'concrete',
}

const num = (key, label, n, unit, comment, core = true) =>
  ({ key, label, type: 'num', n, unit, comment, core })

export const DETECTOR_BLOCKS = {
  ATOMX: {
    label: 'ATOMX — gas TPC', single: true,
    fields: [
      num('TPC_Pos', 'TPC position', 3, 'mm', 'TPC 중심 위치 (x y z)'),
      num('TPC_Chamber_Size', 'Chamber size', 3, 'mm', '챔버 외형 크기'),
      num('TPC_Gas_Size', 'Active gas size', 3, 'mm', '활성 가스 영역 크기'),
      num('TPC_Pad_Size', 'Pad size', 3, 'mm', '읽기 패드 크기'),
      num('TPC_MMS_Size', 'Micromegas size', 3, 'mm', '마이크로메가스 영역 크기'),
      num('TPC_Mylar_Rmax', 'Window mylar radius', 1, 'cm', '입사창 마일라 반경'),
      num('TPC_Mylar_Thickness', 'Window mylar thickness', 1, 'micrometer', '마일라 두께'),
      num('Gas_EProductionCut', 'e- production cut', 1, 'mm', '2차 입자 생성 컷'),
      num('Gas_StepLimit', 'Step limit', 1, 'mm', '최대 스텝 길이'),
      { key: 'Gas_Material', label: 'Gas material', type: 'tokens', comment: '가스 성분 (예: He CO2)', core: true },
      { key: 'Gas_Fraction', label: 'Gas fraction', type: 'tokens', comment: '성분 비율 % (예: 97 3)', core: true },
      num('Gas_Temperature', 'Temperature', 1, 'kelvin', '가스 온도'),
      num('Gas_Pressure', 'Pressure', 1, 'bar', '가스 압력'),
      num('Gas_ReactionZ', 'Reaction Z range', 2, 'mm', '반응 발생 z 범위 (min max)'),
      num('Gas_ReactionBox_Size', 'Reaction box size', 1, 'mm', '반응 영역 박스 크기'),
    ],
    presets: {
      gas: [
        { label: 'He:CO2 (97:3)', set: { Gas_Material: 'He CO2', Gas_Fraction: '97 3' } },
        { label: 'P10 — Ar:CH4 (90:10)', set: { Gas_Material: 'Ar CH4', Gas_Fraction: '90 10' } },
        { label: 'isobutane (iC4H10)', set: { Gas_Material: 'iC4H10', Gas_Fraction: '100' } },
      ],
    },
  },

  Target: {
    label: 'Target', single: true,
    fields: [
      num('THICKNESS', 'Thickness', 1, 'micrometer', '표적 두께'),
      num('RADIUS', 'Radius', 1, 'mm', '표적 반경'),
      { key: 'MATERIAL', label: 'Material', type: 'material', comment: '표적 물질 (nptool 라이브러리)', core: true },
      num('ANGLE', 'Angle', 1, 'deg', '표적 기울기'),
      num('X', 'X', 1, 'mm'), num('Y', 'Y', 1, 'mm'), num('Z', 'Z', 1, 'mm'),
    ],
  },

  STARK: {
    label: 'STARK — silicon detector', repeatable: true,
    // Placement combinations from NPSimulation/Detectors/STARK/STARK.cc — the user
    // picks which set of parameters a block uses.
    combos: {
      cart: { label: 'cartesian (POS)', keys: ['Type', 'POS'] },
      car2: { label: 'cartesian + rotation', keys: ['Type', 'POS', 'RotateXYZ'] },
      cyld: { label: 'cylindrical (Rho/Phi/Z)', keys: ['Type', 'Rho', 'Phi', 'Z'] },
      sphe: { label: 'spherical (R/Theta/Phi)', keys: ['Type', 'R', 'Theta', 'Phi'] },
      reso: { label: 'resolution', keys: ['Type', 'Reso'] },
      targ: { label: 'target', keys: ['TargetMaterial', 'Pressure', 'Temperature', 'Radius', 'Z'] },
    },
    comboOrder: ['reso', 'targ', 'car2', 'cart', 'sphe', 'cyld'],   // match priority (STARK.cc)
    comboDefault: 'cart',                                           // new blocks start cartesian
    extra: ['MotherVolume', 'Group', 'Flip', 'CsI'],                // optional, kept if present
    fields: [
      { key: 'Type', label: 'Type', type: 'choice', choices: ['X6', 'BB10', 'QQQ5'], comment: '검출기 종류' },
      num('POS', 'Position', 3, 'mm', '위치 (x y z)'),
      num('RotateXYZ', 'Rotation', 3, 'deg', '회전 (x y z)'),
      num('Rho', 'Rho', 1, 'mm', '반경 (원통)'),
      num('Phi', 'Phi', 1, 'deg', '방위각'),
      num('Z', 'Z', 1, 'mm', 'z 위치'),
      num('R', 'R', 1, 'mm', '반경 (구면)'),
      num('Theta', 'Theta', 1, 'deg', '극각'),
      num('Reso', 'Resolution', 1, '', '에너지 분해능'),
      { key: 'TargetMaterial', label: 'Target material', type: 'material', comment: '표적 물질' },
      num('Pressure', 'Pressure', 1, 'bar'), num('Temperature', 'Temperature', 1, 'kelvin'),
      num('Radius', 'Radius', 1, 'mm'),
      { key: 'MotherVolume', label: 'Mother volume', type: 'text', comment: '배치될 모volume' },
      num('Group', 'Group', 1, '', '그룹 번호'),
      { key: 'Flip', label: 'Flip', type: 'choice', choices: ['0', '1'], comment: '뒤집기' },
      { key: 'CsI', label: 'CsI', type: 'choice', choices: ['0', '1'], comment: 'CsI(E) 부착' },
    ],
  },

  // CSSU is one block name with several detector shapes selected by `Type=`
  // (NPSimulation/Detectors/CSSU/CSSU.cc): a plastic scintillator bar with PMTs
  // (ScintPMT), a segmented gas box (GasCF4), a W1 silicon strip detector, and a cut
  // mask. The variant selector sets Type= and swaps in that shape's parameters; every
  // shape shares POS/Length/Width/Thickness. Length/Width map to ActiveX/ActiveY (W1)
  // or SizeX/SizeY (GasBox/Mask) in nptool.
  CSSU: {
    label: 'CSSU — scintillator / gas / W1 / mask', repeatable: true,
    variantKey: 'Type', variantDefault: 'ScintillatorBar',
    variants: {
      ScintillatorBar: {
        label: 'ScintillatorBar — 섬광체 + PMT',
        keys: ['Length', 'Width', 'Thickness', 'PMTLength', 'PMTDiameter',
          'ScintillationYield', 'AttenuationLength', 'ScintillatorRIndex', 'Envelope'],
      },
      W1: {
        label: 'W1 — 실리콘 스트립',
        keys: ['Length', 'Width', 'Thickness', 'Strips', 'EnergyThreshold', 'ResoEnergy'],
      },
      GasBox: {
        label: 'GasBox — 세그먼트 가스 챔버',
        keys: ['Length', 'Width', 'Thickness', 'Pressure', 'StepLimit',
          'SegmentsZ', 'SegmentGapZ', 'EnergyThreshold', 'ResoEnergy'],
      },
      Mask: {
        label: 'Mask — 컷 마스크',
        keys: ['Length', 'Width', 'Thickness', 'Material', 'CUT'],
      },
    },
    fields: [
      { key: 'Type', label: 'Type', type: 'choice',
        choices: ['ScintillatorBar', 'W1', 'GasBox', 'Mask'], comment: '검출기 형상', core: true },
      num('POS', 'Position', 3, 'mm', '중심 위치 (x y z)'),
      num('X', 'X', 1, 'mm', 'x 위치 (POS 대신)', false),
      num('Y', 'Y', 1, 'mm', 'y 위치 (POS 대신)', false),
      num('Z', 'Z', 1, 'mm', 'z 위치 (POS 대신)', false),
      num('Length', 'Length', 1, 'mm', '길이 (x, = ActiveX/SizeX)'),
      num('Width', 'Width', 1, 'mm', '폭 (y, = ActiveY/SizeY)'),
      num('Thickness', 'Thickness', 1, 'mm', '두께 (z)'),
      // ScintillatorBar
      num('PMTLength', 'PMT length', 1, 'mm', 'PMT 길이'),
      num('PMTDiameter', 'PMT diameter', 1, 'mm', 'PMT 지름'),
      num('ScintillationYield', 'Scint. yield', 1, '', '광자 수율 (/MeV)'),
      num('AttenuationLength', 'Attenuation length', 1, 'mm', '광 감쇠 거리'),
      num('ScintillatorRIndex', 'Refractive index', 1, '', '섬광체 굴절률'),
      { key: 'Envelope', label: 'Envelope', type: 'num', n: 1, unit: 'mm', default: '50 mm',
        comment: '진공 mother 여백 (광자 비행 공간)' },
      // W1 silicon strip
      { key: 'Strips', label: 'Strips', type: 'num', n: 1, unit: '', comment: '스트립 수 (앞/뒤 공통)', default: '16' },
      num('EnergyThreshold', 'Energy threshold', 1, 'MeV', '에너지 임계값'),
      num('ResoEnergy', 'Energy resolution', 1, 'keV', '에너지 분해능 (FWHM)'),
      // GasBox
      num('Pressure', 'Pressure', 1, '', '가스 압력 (Torr)'),
      num('StepLimit', 'Step limit', 1, 'mm', '최대 스텝 길이'),
      num('SegmentsZ', 'Segments Z', 1, '', 'z 방향 활성 분할 수'),
      num('SegmentGapZ', 'Segment gap Z', 1, 'mm', '분할 사이 간격'),
      // Mask
      { key: 'Material', label: 'Material', type: 'material', comment: '마스크 물질' },
      { key: 'CUT', label: 'Cut', type: 'text', default: 'SQUARE 0 0 10 10 mm',
        comment: 'SQUARE x y dx dy unit · CIRCLE x y r unit' },
      { key: 'CUT2', label: 'Cut 2', type: 'text', comment: '두 번째 컷 (선택)' },
    ],
  },

  // Coaxial HPGe γ-ray detector (NPSimulation/Detectors/Coaxial_Germanium). Placed
  // either cartesian (POS) or spherical (R/Theta/Phi); ResoEnergy/EnergyThreshold
  // are optional response params.
  Coaxial_Germanium: {
    label: 'Coaxial_Germanium — HPGe γ', repeatable: true,
    combos: {
      sphe: { label: 'spherical (R/Theta/Phi)', keys: ['R', 'Theta', 'Phi'] },
      cart: { label: 'cartesian (POS)', keys: ['POS'] },
    },
    comboOrder: ['sphe', 'cart'], comboDefault: 'sphe',
    extra: ['ResoEnergy', 'EnergyThreshold'],
    fields: [
      num('R', 'R', 1, 'mm', '중심 거리 (구면)'),
      num('Theta', 'Theta', 1, 'deg', '극각'),
      num('Phi', 'Phi', 1, 'deg', '방위각'),
      num('POS', 'Position', 3, 'mm', '위치 (x y z, 직교)'),
      num('ResoEnergy', 'Energy resolution', 1, 'keV', '에너지 분해능 (FWHM)', false),
      num('EnergyThreshold', 'Energy threshold', 1, 'MeV', '에너지 임계값', false),
    ],
  },

  // Plunger: a two-word block name (`Plunger Target/Stopper/Chamber`) — the part is
  // the block ARG. Fields below are the union across the three parts (each block
  // shows only the params it actually has).
  Plunger: {
    label: 'Plunger', repeatable: true, hasArg: true,
    arg: { label: 'Part', comment: '부품 (Target / Stopper / Chamber)', default: 'Target' },
    fields: [
      num('R', 'R', 1, 'mm', '반경'),
      num('Thickness', 'Thickness', 1, 'mm', '두께'),
      num('Z', 'Z', 1, 'mm', 'z 위치'),
      { key: 'Material', label: 'Material', type: 'material', comment: '물질', core: true },
      num('PipeR', 'Pipe R', 1, 'mm', '빔 파이프 반경 (Chamber)', false),
      num('PipeZ0', 'Pipe Z0', 1, 'mm', '파이프 시작 z (Chamber)', false),
      num('PipeZ1', 'Pipe Z1', 1, 'mm', '파이프 끝 z (Chamber)', false),
    ],
  },

  // ASGARD clover γ-ray detector — also a two-word block name (`ASGARD Clover`).
  ASGARD: {
    label: 'ASGARD — clover γ detector', repeatable: true, hasArg: true,
    arg: { label: 'Type', comment: '예: Clover', default: 'Clover' },
    fields: [
      num('CloverID', 'Clover ID', 1, '', '클로버 번호'),
      num('R', 'R', 1, 'cm', '중심 거리'),
      num('Theta', 'Theta', 1, 'deg', '극각'),
      num('Phi', 'Phi', 1, 'deg', '방위각'),
      num('Beta', 'Beta', 3, '', '오일러 회전 (x y z)'),
    ],
  },
}

// the gas volume STARK detectors sit in when an ATOMX TPC is present (the
// MotherVolume token the ATOMX detector file uses)
export const ATOMX_GAS_VOLUME = 'ATOMX_gas'

// which combo a block currently matches, for any type declaring `combos` (STARK,
// Coaxial_Germanium). Prefers a combo whose keys are ALL present, else one partially
// present, else the type's default.
export function detectCombo(type, block) {
  const spec = DETECTOR_BLOCKS[type]
  const present = new Set(block.params.map((p) => p.key))
  for (const k of spec.comboOrder) if (spec.combos[k].keys.every((key) => present.has(key))) return k
  return spec.comboOrder.find((k) => spec.combos[k].keys.some((key) => present.has(key)))
    || spec.comboDefault || spec.comboOrder[0]
}

const KNOWN = new Set(Object.keys(DETECTOR_BLOCKS))
export const fieldSpec = (type, key) =>
  (DETECTOR_BLOCKS[type]?.fields || []).find((f) => f.key === key)

export function parseDetector(text) {
  const blocks = []
  let buf = [], cur = null
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const t = line.trim()
    if (t === '' || t.startsWith('%')) { buf.push(line); continue }
    if (!/^\s/.test(line)) {
      const parts = t.split(/\s+/)
      // second+ words are the block ARG (e.g. `Plunger Target`, `ASGARD Clover`) —
      // kept so serialization round-trips (single-word blocks get arg '').
      cur = { type: parts[0], arg: parts.slice(1).join(' '), header: buf, params: [] }
      blocks.push(cur); buf = []
    } else if (cur && line.includes('=')) {
      const i = line.indexOf('=')
      cur.params.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
  }
  return blocks
}

export function serializeDetector(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.header) out.push(...b.header)
    out.push(b.arg ? `${b.type} ${b.arg}` : b.type)
    for (const p of b.params) out.push(`    ${p.key} = ${p.value}`)
  }
  return out.join('\n').replace(/\n*$/, '\n')
}

export const getParam = (b, key) => (b.params.find((p) => p.key === key) || {}).value ?? ''
export function setParam(b, key, value) {
  const p = b.params.find((x) => x.key === key)
  if (p) p.value = value
  else b.params.push({ key, value })
}

export function splitNum(value, n, unit) {
  const parts = String(value).trim().split(/\s+/).filter(Boolean)
  const nums = []
  for (let i = 0; i < n; i++) nums.push(parts[i] ?? '')
  const tail = parts[n]
  return { nums, unit: tail && isNaN(+tail) ? tail : unit }
}
export const composeNum = (nums, unit) =>
  nums.map((x) => (x === '' ? '0' : x)).join(' ') + (unit ? ' ' + unit : '')

function fieldDefault(f) {
  return f.default ?? (f.type === 'num' ? composeNum(Array(f.n).fill('0'), f.unit)
    : f.type === 'choice' ? f.choices[0] : '')
}

const valueForKey = (type, key) => {
  const f = fieldSpec(type, key)
  return f ? fieldDefault(f) : ''
}

// the key list for a combo. STARK optionally injects MotherVolume (so its silicon
// sits in the ATOMX gas) — only for placement combos (not the target/reso ones).
function comboKeys(type, combo, { hasATOMX = false, hasMother = false } = {}) {
  const keys = [...DETECTOR_BLOCKS[type].combos[combo].keys]
  if (type === 'STARK' && (hasATOMX || hasMother) && !keys.includes('TargetMaterial')) {
    keys.splice(1, 0, 'MotherVolume')
  }
  return keys
}

// build a combo block's params (fresh)
export function comboParams(type, combo, opts = {}) {
  return comboKeys(type, combo, opts).map((key) => ({
    key, value: key === 'MotherVolume' ? ATOMX_GAS_VOLUME : valueForKey(type, key),
  }))
}

// new params when switching a block to another combo — preserve overlapping values;
// keep MotherVolume if it was there (STARK).
export function switchCombo(type, block, combo) {
  const hasMother = block.params.some((p) => p.key === 'MotherVolume')
  const keys = comboKeys(type, combo, { hasMother })
  const old = Object.fromEntries(block.params.map((p) => [p.key, p.value]))
  return keys.map((key) => ({
    key, value: old[key] ?? (key === 'MotherVolume' ? ATOMX_GAS_VOLUME : valueForKey(type, key)),
  }))
}

// ── variant blocks: one block name, several shapes chosen by a `Type=`-style param
//    (CSSU). The variant param + POS placement are always kept; the rest come from
//    the chosen shape. ────────────────────────────────────────────────────────────
const variantKeys = (spec, variant) => ['POS', spec.variantKey, ...spec.variants[variant].keys]

// which variant a block currently is (reads the variant param value)
export function detectVariant(type, block) {
  const spec = DETECTOR_BLOCKS[type]
  const v = getParam(block, spec.variantKey)
  return spec.variants[v] ? v : spec.variantDefault
}

export function variantParams(type, variant) {
  const spec = DETECTOR_BLOCKS[type]
  return variantKeys(spec, variant).map((key) => ({
    key, value: key === spec.variantKey ? variant : valueForKey(type, key),
  }))
}

// switch a block's shape — set the variant param, keep overlapping values (POS, Length…)
export function switchVariant(type, block, variant) {
  const spec = DETECTOR_BLOCKS[type]
  const old = Object.fromEntries(block.params.map((p) => [p.key, p.value]))
  return variantKeys(spec, variant).map((key) => ({
    key, value: key === spec.variantKey ? variant : (old[key] ?? valueForKey(type, key)),
  }))
}

// a fresh block. Combo types start in their default combo (STARK: cart, +MotherVolume
// when an ATOMX TPC is present); variant types start in their default shape.
export function newBlock(type, opts = {}) {
  const spec = DETECTOR_BLOCKS[type]
  if (spec.combos) {
    return { type, header: [`%% ${type}`],
      params: comboParams(type, spec.comboDefault || spec.comboOrder[0], opts) }
  }
  if (spec.variants) {
    return { type, arg: spec.arg?.default || '', header: [`%% ${type}`],
      params: variantParams(type, spec.variantDefault) }
  }
  const params = spec.fields.filter((f) => f.core).map((f) => ({ key: f.key, value: fieldDefault(f) }))
  return { type, arg: spec.arg?.default || '', header: [`%% ${type}`], params }
}

// ── catalog bridge ─────────────────────────────────────────────────────────────
// Build a DETECTOR_BLOCKS-style spec from a detectors.json entry (the schema the
// nptool build extracts from every detector's ReadConfiguration). Hand-tuned
// entries above stay authoritative; this makes the ~95 other detectors editable
// with typed fields, units, choices and description tooltips — no hardcoding.
export function specFromCatalog(token, entry) {
  const req = new Set(entry.variants?.[0]?.requires || [])
  const fields = Object.entries(entry.fields || {}).map(([key, f]) => {
    const base = { key, label: key, comment: f.description || '', core: req.has(key) }
    if (f.choices) return { ...base, type: 'choice', choices: f.choices }
    if (f.type === 'vector3') return { ...base, type: 'num', n: 3, unit: f.unit || '' }
    if (f.type === 'double') return { ...base, type: 'num', n: 1, unit: f.unit || '' }
    if (f.type === 'int' || f.type === 'bool') return { ...base, type: 'num', n: 1, unit: '' }
    if (key === 'Material' || key === 'TargetMaterial' || key === 'GasMaterial') return { ...base, type: 'material' }
    return { ...base, type: 'text' }
  })
  fields.sort((a, b) => (req.has(b.key) ? 1 : 0) - (req.has(a.key) ? 1 : 0) || a.key.localeCompare(b.key))
  return { label: token, fields, fromCatalog: true,
    description: entry.description || '',
    variantsInfo: (entry.variants || []).map((v) => v.requires),
    requires: entry.variants?.[0]?.requires || [] }
}

// A fresh block for a catalog-only detector: the first variant's required
// tokens, with typed defaults.
export function newBlockFromSpec(type, spec) {
  const params = (spec.requires || []).map((k) => {
    const f = spec.fields.find((x) => x.key === k) || { type: 'text' }
    return { key: k, value: fieldDefault(f) }
  })
  return { type, arg: '', header: [`%% ${type}`], params }
}
