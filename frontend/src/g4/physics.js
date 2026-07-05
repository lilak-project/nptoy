// PhysicsListOption.txt: flat `Key   Value   % comment` lines (mostly 0/1 toggles).
export const PHYSICS_SCHEMA = {
  EmPhysicsList: {
    type: 'choice',
    choices: ['Standard', 'Option1', 'Option2', 'Option3', 'Option4', 'Livermore', 'Penelope', 'INCLXX_EM'],
    label: 'EM physics list', comment: '전자기 물리 모델',
  },
  DefaultCutOff: { type: 'num', unit: 'mm', label: 'Default cut-off', comment: '기본 생성 컷' },
}

export function parsePhysics(text) {
  return (text || '').split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '')
    const t = line.trim()
    const m = (t && !t.startsWith('%')) ? line.match(/^(\S+)\s+(\S+)\s*(%.*)?$/) : null
    return m
      ? { kind: 'opt', key: m[1], value: m[2], comment: (m[3] || '').trim() }
      : { kind: 'raw', text: line }
  })
}

export function serializePhysics(rows) {
  return rows.map((r) => r.kind === 'raw'
    ? r.text
    : `${r.key.padEnd(31)} ${r.value}${r.comment ? '  ' + r.comment : ''}`
  ).join('\n').replace(/\n*$/, '\n')
}

// classify an option row for rendering
export function control(r) {
  const sp = PHYSICS_SCHEMA[r.key]
  if (sp) return sp.type            // 'choice' | 'num'
  if (r.value === '0' || r.value === '1') return 'toggle'
  return 'text'
}
