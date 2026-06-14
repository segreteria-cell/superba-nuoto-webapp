import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import LZString from 'lz-string'
import * as XLSX from 'xlsx'
import XLSXStyle from 'xlsx-js-style'
import { ref as rtdbRef, set as rtdbSet, get as rtdbGet } from 'firebase/database'
import { rtdb } from '../lib/firebase'
import { ELENCO_ATLETI } from '../lib/elencoAtleti'
import { extractPdfText, parseProgramma, parseGraduatoriaLimiti } from '../lib/parseProgramma'

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SEZIONE_FULL_TO_ABBR = {
  'NUOTATORI GENOVESI':    'NG',
  'IDEA SPORT':            'IS',
  'CROCERA STADIUM':       'CR',
  'RAPALLO NUOTO':         'RN',
  'LAVAGNA 90':            'LA',
  'AQUARIUM VALLESCRIVIA': 'AV',
  'AQUARIUM':              'AQ',
  'RARI NANTES SPEZIA':    'SP',
  'SUPERBANUOTO':          'AS',
}
const SEZIONE_ORDER    = ['NG', 'IS', 'SP', 'CR', 'RN', 'AQ', 'AV', 'LA', 'AS']
const SPEC_ABBR        = { STILE: 'SL', DORSO: 'DO', RANA: 'RA', FARFALLA: 'FA', MISTI: 'MX' }
const SPEC_LABEL       = { SL: 'STILE', DO: 'DORSO', RA: 'RANA', FA: 'FARFALLA', MX: 'MISTI' }
const SPEC_ORDER       = ['SL', 'DO', 'RA', 'FA', 'MX']
const CAT_ORDER        = ['RAGAZZI', 'JUNIORES', 'CADETTI', 'SENIORES', 'ASSOLUTI']
const CATEGORIE_ATLETA = [
  'RAGAZZI 1 Anno','RAGAZZI 2 Anno',
  'JUNIORES 1 Anno','JUNIORES 2 Anno',
  'CADETTI 1 Anno','CADETTI 2 Anno',
  'SENIORES','ASSOLUTI',
]
const SPECIALITA_LIST = ['Stile Libero','Dorso','Rana','Farfalla','Misti']
const DISTANZE        = [50, 100, 200, 400, 800, 1500]
const VASCHE          = ['25 metri','50 metri']

// ═══════════════════════════════════════════════════════════════════════════════
// FIREBASE
// ═══════════════════════════════════════════════════════════════════════════════

async function cloudSave(payload) {
  const compressed = LZString.compressToBase64(JSON.stringify(payload))
  await rtdbSet(rtdbRef(rtdb, 'qualifiche/current'), {
    timestamp: new Date().toISOString(),
    data: compressed,
  })
}

async function cloudLoad() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'qualifiche/current'))
  if (!snap.exists()) return null
  const val = snap.val()
  return { payload: JSON.parse(LZString.decompressFromBase64(val.data)), timestamp: val.timestamp }
}

async function cloudLoadRegolamenti() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/meta'))
  if (!snap.exists()) return []
  const val = snap.val()
  const dec = LZString.decompressFromBase64(val.data) || LZString.decompress(val.data)
  return JSON.parse(dec) || []
}

async function cloudLoadPdf(id) {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/files/' + id))
  if (!snap.exists()) return null
  return LZString.decompressFromBase64(snap.val()) // base64 del PDF
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function deriveSezione(atleta) {
  const sezFull = ELENCO_ATLETI[atleta] || ''
  return SEZIONE_FULL_TO_ABBR[sezFull] || (sezFull ? sezFull.slice(0, 3) : '?')
}

function normCat(cat) {
  const c = (cat || '').toUpperCase()
  for (const k of CAT_ORDER) { if (c.includes(k)) return k }
  return 'ALTRI'
}

function normalizeSpec(s) {
  const up = (s || '').toUpperCase()
  if (up.includes('STILE') || up === 'SL')     return 'STILE'
  if (up.includes('DORSO') || up === 'DO')     return 'DORSO'
  if (up.includes('RANA')  || up === 'RA')     return 'RANA'
  if (up.includes('FARFALLA') || up === 'FA')  return 'FARFALLA'
  if (up.includes('MISTI') || up === 'MX')     return 'MISTI'
  return s
}

function normalizeTime(val) {
  if (val == null || val === '') return ''
  const txt = String(val).replace(',', '.').trim()
  const parts = txt.split(':')
  try {
    if (parts.length === 3) {
      const mm = parseInt(parts[0]) * 60 + parseInt(parts[1])
      return mm === 0 ? parts[2] : `${mm}:${parts[2]}`
    }
    if (parts.length === 2) {
      const mm = parseInt(parts[0])
      return mm === 0 ? parts[1] : `${mm}:${parts[1]}`
    }
  } catch { /**/ }
  return txt
}

function timeToSecs(val) {
  if (!val) return Infinity
  const t = String(val).replace(',', '.').trim()
  if (t.includes(':')) {
    const [m, s] = t.split(':')
    return (parseInt(m) || 0) * 60 + (parseFloat(s) || 0)
  }
  return parseFloat(t) || Infinity
}

function normKey(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
}

function getVal(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k]
    const nk = normKey(k)
    const found = Object.keys(row).find(rk => normKey(rk) === nk)
    if (found !== undefined && row[found] !== undefined && row[found] !== '') return row[found]
  }
  return ''
}

function parseExcelBuffer(buffer) {
  const wb  = XLSX.read(buffer, { type: 'array', cellDates: false })
  const ws  = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
  return raw.map((r, idx) => {
    const nome    = String(getVal(r, 'Nome', 'nome') || '').trim()
    const cognome = String(getVal(r, 'Cognome', 'cognome') || '').trim()
    const atleta  = (cognome + ' ' + nome).trim()
    const spec    = normalizeSpec(String(getVal(r, 'Specialita', 'SPECIALITA') || '').trim())
    const dist    = parseInt(getVal(r, 'Distanza', 'DISTANZA', 'Dist') || 0)
    const vasca   = String(getVal(r, 'Vasca', 'VASCA') || '').trim()
    const sesso   = String(getVal(r, 'Sesso', 'SESSO') || '').trim()
    const cat     = String(getVal(r, 'Categoria Atleta', 'CategoriaAtleta', 'CATEGORIA') || '').trim()
    const tempo   = normalizeTime(getVal(r, 'Tempo', 'TEMPO') || '')
    const fina    = parseFloat(getVal(r, 'FINA', 'Fina', 'fina') || 0) || 0
    const id      = String(getVal(r, 'ID', 'Id', 'id') || ('row_' + idx))
    const societa = String(getVal(r, 'Societa', 'SOCIETA') || '').trim()
    return { _id: id, _source: 'xlsx', atleta, nome, cognome, societa,
      categoria: cat, sesso, vasca, specialita: spec, distanza: dist,
      tempo, fina, sezione: deriveSezione(atleta) }
  }).filter(r => r.atleta && r.atleta.trim() !== '')
}

function applyFilters(rows, { vasca, sesso, soloUnNome, rinunce }) {
  let res = rows.filter(r => !rinunce.has(r._id))
  if (vasca !== 'Tutte') res = res.filter(r => r.vasca === vasca)
  if (sesso !== 'Tutti') res = res.filter(r => r.sesso === sesso)
  if (soloUnNome) {
    const best = {}
    for (const r of res) {
      const key = r.atleta + '|' + r.specialita + '|' + r.distanza + '|' + r.vasca
      if (!best[key] || r.fina > best[key].fina ||
        (r.fina === best[key].fina && timeToSecs(r.tempo) < timeToSecs(best[key].tempo)))
        best[key] = r
    }
    return Object.values(best)
  }
  return res
}

function computeStats(rows) {
  const male  = rows.filter(r => r.sesso === 'Male')
  const female = rows.filter(r => r.sesso === 'Female')
  const atletiM = new Set(male.map(r => r.atleta))
  const atletiF = new Set(female.map(r => r.atleta))
  const perSez = {}
  for (const r of rows) {
    const s = r.sezione || '?'
    if (!perSez[s]) perSez[s] = { gare: 0, atleti: new Set() }
    perSez[s].gare++; perSez[s].atleti.add(r.atleta)
  }
  const perSezFin = {}
  for (const [k, v] of Object.entries(perSez)) perSezFin[k] = { gare: v.gare, atleti: v.atleti.size }
  const perCat = {}
  for (const c of CAT_ORDER) perCat[c] = { M: 0, F: 0 }
  for (const r of rows) {
    const c = normCat(r.categoria)
    if (perCat[c]) { if (r.sesso === 'Male') perCat[c].M++; else if (r.sesso === 'Female') perCat[c].F++ }
  }
  const perSpec = {}
  for (const s of SPEC_ORDER) perSpec[s] = { M: 0, F: 0 }
  for (const r of rows) {
    const abbr = SPEC_ABBR[r.specialita] || r.specialita
    if (perSpec[abbr]) { if (r.sesso === 'Male') perSpec[abbr].M++; else perSpec[abbr].F++ }
  }
  return {
    totGare:    { M: male.length, F: female.length, total: rows.length },
    totAtleti:  { M: atletiM.size, F: atletiF.size, total: atletiM.size + atletiF.size },
    perSezione: perSezFin, perCat, perSpec,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function exportExcel(rows, competizione) {
  const headers = ['Atleta','Sesso','Cat.','Sezione','Specialità','Dist.','Vasca','Tempo','FINA']
  const data = rows.map(r => [
    r.atleta, r.sesso === 'Male' ? 'M' : 'F', normCat(r.categoria),
    r.sezione, r.specialita, r.distanza, r.vasca, r.tempo, r.fina,
  ])
  const ws = XLSXStyle.utils.aoa_to_sheet([headers, ...data])
  const hStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0077C8' } },
    alignment: { horizontal: 'center' }, border: { bottom: { style: 'thin', color: { rgb: 'B8D8EC' } } } }
  headers.forEach((_, ci) => {
    const addr = XLSXStyle.utils.encode_cell({ r: 0, c: ci })
    if (!ws[addr]) ws[addr] = {}
    ws[addr].s = hStyle
  })
  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, ws, 'Qualifiche')
  XLSXStyle.writeFile(wb, `Qualifiche_${(competizione || 'export').replace(/\s+/g, '_')}.xlsx`)
}

function exportGrigliaGare(rows, competizione, programma) {
  // Build lookup: spec|dist|sesso|cat → atleti
  const lookup = {}
  for (const r of rows) {
    const catN = normCat(r.categoria)
    const key  = `${r.specialita}|${r.distanza}|${r.sesso}|${catN}`
    if (!lookup[key]) lookup[key] = []
    lookup[key].push(r)
  }
  for (const v of Object.values(lookup))
    v.sort((a, b) => b.fina - a.fina || timeToSecs(a.tempo) - timeToSecs(b.tempo))

  const wb  = XLSXStyle.utils.book_new()
  const hStyle = { font:{bold:true,color:{rgb:'FFFFFF'}}, fill:{fgColor:{rgb:'0077C8'}}, alignment:{horizontal:'center'} }
  const dayStyle = { font:{bold:true,sz:13}, fill:{fgColor:{rgb:'071422'}}, font:{bold:true,color:{rgb:'FFFFFF'}} }

  if (programma && programma.length > 0) {
    // Organizza per giornata
    for (const giorno of programma) {
      const sheetName = `G${giorno.giornata} - ${giorno.data}`.slice(0, 31)
      const aoa = []
      aoa.push([`${giorno.giornata}ª Giornata – ${giorno.data}`, '', '', '', ''])
      for (const sess of giorno.sessioni) {
        aoa.push([sess.nome.toUpperCase(), '', '', '', ''])
        for (const gara of sess.gare) {
          const sessoLabel = gara.sesso === 'Female' ? 'Femminile' : gara.sesso === 'Male' ? 'Maschile' : 'M+F'
          const catLabel   = gara.cat || gara.catRaw || ''
          const garaLabel  = `${gara.dist}m ${gara.spec} – ${sessoLabel} ${catLabel} (${gara.tipo})`
          aoa.push([garaLabel, '', '', '', ''])
          aoa.push(['Pos.', 'Atleta', 'Sez.', 'Cat.', 'Tempo', 'FINA', 'Tipo'])
          const atl = gara.sesso
            ? (lookup[`${gara.spec}|${gara.dist}|${gara.sesso}|${gara.cat || normCat(gara.catRaw)}`] || [])
            : []
          if (atl.length === 0) {
            // Cerca senza categoria (gare J/C/S combinate)
            const combined = Object.entries(lookup)
              .filter(([k]) => k.startsWith(`${gara.spec}|${gara.dist}|${gara.sesso || ''}`))
              .flatMap(([, v]) => v)
            combined.sort((a, b) => b.fina - a.fina || timeToSecs(a.tempo) - timeToSecs(b.tempo))
            combined.forEach((a, i) => aoa.push([i+1, a.atleta, a.sezione, normCat(a.categoria), a.tempo, a.fina, a._source === 'xlsx' ? 'TL' : a._source]))
          } else {
            atl.forEach((a, i) => aoa.push([i+1, a.atleta, a.sezione, normCat(a.categoria), a.tempo, a.fina, a._source === 'xlsx' ? 'TL' : a._source]))
          }
          aoa.push(['', '', '', '', '', ''])
        }
      }
      const ws = XLSXStyle.utils.aoa_to_sheet(aoa)
      XLSXStyle.utils.book_append_sheet(wb, ws, sheetName)
    }
  } else {
    // Fallback: senza programma, ordine per specialità
    const garaMap = {}
    for (const r of rows) {
      const key = `${r.specialita}|${r.distanza}|${r.sesso}|${normCat(r.categoria)}`
      if (!garaMap[key]) garaMap[key] = { spec:r.specialita, dist:r.distanza, sesso:r.sesso, cat:normCat(r.categoria), atleti:[] }
      garaMap[key].atleti.push(r)
    }
    const aoa = []
    for (const g of Object.values(garaMap)) {
      const label = `${g.dist}m ${g.spec} – ${g.sesso === 'Male' ? 'M' : 'F'} ${g.cat}`
      aoa.push([label,'','','','',''])
      aoa.push(['Pos.','Atleta','Sez.','Cat.','Tempo','FINA','Tipo'])
      g.atleti.sort((a,b) => b.fina-a.fina).forEach((a,i) =>
        aoa.push([i+1,a.atleta,a.sezione,normCat(a.categoria),a.tempo,a.fina,a._source==='xlsx'?'TL':a._source]))
      aoa.push(['','','','','',''])
    }
    const ws = XLSXStyle.utils.aoa_to_sheet(aoa)
    XLSXStyle.utils.book_append_sheet(wb, ws, 'Griglia Gare')
  }

  XLSXStyle.writeFile(wb, `GrigliaGare_${(competizione || 'export').replace(/\s+/g, '_')}.xlsx`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: AGGIUNGI ATLETA ESTERO
// ═══════════════════════════════════════════════════════════════════════════════

function ModalAggiungiEstero({ onClose, onAdd }) {
  const [tipo, setTipo]       = useState('TL')
  const [nome, setNome]       = useState('')
  const [cognome, setCognome] = useState('')
  const [societa, setSocieta] = useState('')
  const [sesso, setSesso]     = useState('Male')
  const [cat, setCat]         = useState('JUNIORES')
  const [spec, setSpec]       = useState('Stile Libero')
  const [dist, setDist]       = useState(100)
  const [vasca, setVasca]     = useState('25 metri')
  const [tempo, setTempo]     = useState('')
  const [fina, setFina]       = useState('')

  function handleAdd() {
    if (!nome || !cognome) return
    const atleta = (cognome.trim() + ' ' + nome.trim()).toUpperCase()
    const entry = {
      _id: 'est_' + Date.now(),
      _source: tipo,
      atleta, nome: nome.trim(), cognome: cognome.trim(), societa,
      categoria: cat, sesso, vasca, specialita: normalizeSpec(spec),
      distanza: parseInt(dist), tempo: normalizeTime(tempo),
      fina: parseFloat(fina) || 0, sezione: deriveSezione(atleta),
    }
    onAdd(entry)
    onClose()
  }

  const inp = 'w-full bg-sb-bg border border-sb-sep rounded px-3 py-1.5 text-sm text-sb-text focus:outline-none focus:border-sb-blue'
  const lbl = 'block text-xs font-semibold text-sb-muted mb-1'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Aggiungi Atleta Estero</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="p-6 space-y-4">
          {/* Tipo */}
          <div>
            <label className={lbl}>Tipo qualifica</label>
            <div className="flex gap-4">
              {['TL', 'GRAD'].map(t => (
                <label key={t} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="radio" name="tipo" value={t} checked={tipo === t} onChange={() => setTipo(t)} className="accent-sb-blue" />
                  {t === 'TL' ? 'Tempo Limite' : 'Graduatoria'}
                </label>
              ))}
            </div>
          </div>
          {/* Nome/Cognome */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Cognome *</label><input className={inp} value={cognome} onChange={e => setCognome(e.target.value)} /></div>
            <div><label className={lbl}>Nome *</label><input className={inp} value={nome} onChange={e => setNome(e.target.value)} /></div>
          </div>
          <div><label className={lbl}>Società</label><input className={inp} value={societa} onChange={e => setSocieta(e.target.value)} /></div>
          {/* Sesso / Cat */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Sesso</label>
              <select className={inp} value={sesso} onChange={e => setSesso(e.target.value)}>
                <option value="Male">Maschile</option>
                <option value="Female">Femminile</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Categoria</label>
              <select className={inp} value={cat} onChange={e => setCat(e.target.value)}>
                {CATEGORIE_ATLETA.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          {/* Gara */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={lbl}>Specialità</label>
              <select className={inp} value={spec} onChange={e => setSpec(e.target.value)}>
                {SPECIALITA_LIST.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Distanza</label>
              <select className={inp} value={dist} onChange={e => setDist(e.target.value)}>
                {DISTANZE.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Vasca</label>
              <select className={inp} value={vasca} onChange={e => setVasca(e.target.value)}>
                {VASCHE.map(v => <option key={v}>{v}</option>)}
              </select>
            </div>
          </div>
          {/* Tempo / FINA */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={lbl}>Tempo</label><input className={inp} value={tempo} onChange={e => setTempo(e.target.value)} placeholder="es. 1:02.34" /></div>
            <div><label className={lbl}>Punti FINA</label><input className={inp} type="number" value={fina} onChange={e => setFina(e.target.value)} /></div>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-bg text-sb-muted hover:bg-sb-sep">Annulla</button>
          <button onClick={handleAdd} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Aggiungi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: GESTISCI ESTERI
// ═══════════════════════════════════════════════════════════════════════════════

function ModalGestisciEsteri({ esteri, onClose, onRemove }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Gestisci Atleti Esteri ({esteri.length})</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4">
          {esteri.length === 0 ? (
            <p className="text-center text-sb-muted py-8">Nessun atleta estero aggiunto</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-sb-muted border-b border-sb-sep">
                  <th className="pb-2 font-semibold">Atleta</th>
                  <th className="pb-2 font-semibold">Tipo</th>
                  <th className="pb-2 font-semibold">Gara</th>
                  <th className="pb-2 font-semibold">Tempo</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {esteri.map(e => (
                  <tr key={e._id} className="border-b border-sb-sep/50 hover:bg-sb-bg/50">
                    <td className="py-2 font-medium text-sb-text">{e.atleta}</td>
                    <td className="py-2"><span className={`px-1.5 py-0.5 rounded text-xs font-bold ${e._source === 'TL' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>{e._source}</span></td>
                    <td className="py-2 text-sb-muted">{e.distanza}m {e.specialita}</td>
                    <td className="py-2 text-sb-muted">{e.tempo}</td>
                    <td className="py-2">
                      <button onClick={() => onRemove(e._id)} className="text-red-400 hover:text-red-600 text-xs font-semibold">Rimuovi</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex justify-end px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Chiudi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: RINUNCE TL
// ═══════════════════════════════════════════════════════════════════════════════

function ModalRinunce({ allRows, rinunce, onClose, onSave }) {
  const [sel, setSel] = useState(new Set(rinunce))
  const tlRows = allRows.filter(r => r._source === 'xlsx' || r._source === 'TL')

  function toggle(id) {
    setSel(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[660px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Rinunce TL</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <p className="px-6 py-2 text-xs text-sb-muted">Seleziona gli atleti qualificati per TL che hanno rinunciato alla partecipazione.</p>
        <div className="overflow-y-auto flex-1 px-4 pb-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-sb-muted border-b border-sb-sep sticky top-0 bg-white">
                <th className="py-2 w-8"></th>
                <th className="py-2">Atleta</th>
                <th className="py-2">Gara</th>
                <th className="py-2">Vasca</th>
                <th className="py-2">Tempo</th>
              </tr>
            </thead>
            <tbody>
              {tlRows.map(r => (
                <tr key={r._id} className={`border-b border-sb-sep/50 hover:bg-sb-bg/30 cursor-pointer ${sel.has(r._id) ? 'bg-red-50' : ''}`} onClick={() => toggle(r._id)}>
                  <td className="py-1.5 pl-2"><input type="checkbox" checked={sel.has(r._id)} onChange={() => toggle(r._id)} className="accent-red-500" /></td>
                  <td className="py-1.5 font-medium text-sb-text">{r.atleta}</td>
                  <td className="py-1.5 text-sb-muted">{r.distanza}m {r.specialita}</td>
                  <td className="py-1.5 text-sb-muted text-xs">{r.vasca}</td>
                  <td className="py-1.5 text-sb-muted">{r.tempo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t border-sb-sep">
          <span className="text-sm text-sb-muted">{sel.size} rinuncia/e selezionate</span>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-bg text-sb-muted hover:bg-sb-sep">Annulla</button>
            <button onClick={() => { onSave(sel); onClose() }} className="px-4 py-2 text-sm rounded bg-red-500 text-white hover:bg-red-600 font-semibold">Salva Rinunce</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: ANALISI SEZIONE
// ═══════════════════════════════════════════════════════════════════════════════

function ModalAnalisiSezione({ rows, onClose }) {
  const bySezione = {}
  for (const r of rows) {
    const s = r.sezione || '?'
    if (!bySezione[s]) bySezione[s] = { atleti: new Set(), gare: [], M: new Set(), F: new Set() }
    bySezione[s].atleti.add(r.atleta)
    bySezione[s].gare.push(r)
    r.sesso === 'Male' ? bySezione[s].M.add(r.atleta) : bySezione[s].F.add(r.atleta)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-[700px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-sb-sep">
          <h2 className="text-lg font-bold text-sb-text">Analisi per Sezione</h2>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {SEZIONE_ORDER.filter(s => bySezione[s]).map(s => {
            const d = bySezione[s]
            return (
              <div key={s} className="rounded-lg border border-sb-sep overflow-hidden">
                <div className="flex items-center justify-between bg-sb-blue/10 px-4 py-2">
                  <span className="font-bold text-sb-blue text-sm">{s}</span>
                  <div className="flex gap-4 text-xs text-sb-muted">
                    <span><strong className="text-sb-text">{d.atleti.size}</strong> atleti</span>
                    <span><strong className="text-sb-text">{d.gare.length}</strong> gare</span>
                    <span>M: <strong className="text-sb-text">{d.M.size}</strong></span>
                    <span>F: <strong className="text-sb-text">{d.F.size}</strong></span>
                  </div>
                </div>
                <div className="px-4 py-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-sb-muted border-b border-sb-sep">
                        <th className="text-left py-1">Atleta</th>
                        <th className="text-left py-1">Sesso</th>
                        <th className="text-left py-1">Gara</th>
                        <th className="text-left py-1">Tempo</th>
                        <th className="text-right py-1">FINA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.gare.sort((a, b) => b.fina - a.fina).map((r, i) => (
                        <tr key={r._id + i} className="border-b border-sb-sep/30">
                          <td className="py-0.5 font-medium text-sb-text">{r.atleta}</td>
                          <td className="py-0.5 text-sb-muted">{r.sesso === 'Male' ? 'M' : 'F'}</td>
                          <td className="py-0.5 text-sb-muted">{r.distanza}m {r.specialita}</td>
                          <td className="py-0.5 text-sb-muted">{r.tempo}</td>
                          <td className="py-0.5 text-right text-sb-muted">{r.fina}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end px-6 py-4 border-t border-sb-sep">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-sb-blue text-white hover:bg-sb-hover font-semibold">Chiudi</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function Qualifiche() {
  const fileInputRef = useRef(null)

  // core state
  const [xlsxRows, setXlsxRows]         = useState([])   // raw from Excel
  const [esteri, setEsteri]              = useState([])   // manually added foreign athletes
  const [rinunce, setRinunce]            = useState(new Set())
  const [competizione, setCompetizione]  = useState('')
  const [regolamenti, setRegolamenti]    = useState([])
  const [fileName, setFileName]          = useState('')

  // programma dal PDF del regolamento
  const [programma, setProgramma]               = useState([])   // [{giornata,data,sessioni}]
  const [graduatoriaLimiti, setGraduatoriaLimiti] = useState({}) // {dist|spec|sesso: max}
  const [pdfLoading, setPdfLoading]             = useState(false)
  const [inclusiGraduatoria, setInclusiGraduatoria] = useState(false)

  // filters
  const [filterVasca, setFilterVasca]     = useState('Tutte')
  const [filterSesso, setFilterSesso]     = useState('Tutti')
  const [soloUnNome, setSoloUnNome]       = useState(true)

  // modals
  const [showAggEstero, setShowAggEstero]       = useState(false)
  const [showGestEsteri, setShowGestEsteri]     = useState(false)
  const [showRinunce, setShowRinunce]           = useState(false)
  const [showAnalisi, setShowAnalisi]           = useState(false)

  // ui status
  const [status, setStatus]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [loading, setLoading] = useState(false)

  // Load regolamenti + last saved session on mount
  useEffect(() => {
    cloudLoadRegolamenti()
      .then(regs => setRegolamenti(regs))
      .catch(() => {})

    cloudLoad().then(res => {
      if (!res) return
      const p = res.payload
      setCompetizione(p.competizione || '')
      setXlsxRows(p.xlsxRows || [])
      setEsteri(p.esteri || [])
      setRinunce(new Set(p.rinunce || []))
      setFilterVasca(p.filterVasca || 'Tutte')
      setFilterSesso(p.filterSesso || 'Tutti')
      setSoloUnNome(p.soloUnNome ?? true)
      if (p.xlsxRows?.length) setFileName('(sessione salvata)')
    }).catch(() => {})
  }, [])

  // Carica e parsa il PDF del regolamento quando cambia la competizione
  useEffect(() => {
    if (!competizione || regolamenti.length === 0) return
    const reg = regolamenti.find(r => r.nome === competizione)
    if (!reg) return
    setPdfLoading(true)
    setProgramma([])
    setGraduatoriaLimiti({})
    cloudLoadPdf(reg.id).then(async base64 => {
      if (!base64) return
      try {
        const text = await extractPdfText(base64)
        setProgramma(parseProgramma(text))
        setGraduatoriaLimiti(parseGraduatoriaLimiti(text))
      } catch (e) { console.warn('Errore parsing PDF:', e) }
    }).catch(e => console.warn('Errore caricamento PDF:', e))
      .finally(() => setPdfLoading(false))
  }, [competizione, regolamenti])

  // Derived: all rows merged (xlsx + esteri), then filtered
  const allRows = useMemo(() => [...xlsxRows, ...esteri], [xlsxRows, esteri])
  const filtered = useMemo(
    () => applyFilters(allRows, { vasca: filterVasca, sesso: filterSesso, soloUnNome, rinunce }),
    [allRows, filterVasca, filterSesso, soloUnNome, rinunce]
  )
  const stats = useMemo(() => computeStats(filtered), [filtered])

  // ── FILE IMPORT ──────────────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      const parsed = parseExcelBuffer(new Uint8Array(buf))
      setXlsxRows(parsed)
      setStatus(`Importati ${parsed.length} record da ${file.name}`)
    } catch (e) {
      setStatus('Errore lettura file: ' + e.message)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (f) handleFile(f)
  }

  // ── CLOUD SAVE / LOAD ────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true); setStatus('')
    try {
      await cloudSave({ competizione, xlsxRows, esteri, rinunce: [...rinunce],
        filterVasca, filterSesso, soloUnNome })
      setStatus('Sessione salvata su cloud.')
    } catch (e) { setStatus('Errore salvataggio: ' + e.message) }
    finally { setSaving(false) }
  }

  async function handleLoad() {
    setLoading(true); setStatus('')
    try {
      const res = await cloudLoad()
      if (!res) { setStatus('Nessuna sessione trovata.'); return }
      const p = res.payload
      setCompetizione(p.competizione || '')
      setXlsxRows(p.xlsxRows || [])
      setEsteri(p.esteri || [])
      setRinunce(new Set(p.rinunce || []))
      setFilterVasca(p.filterVasca || 'Tutte')
      setFilterSesso(p.filterSesso || 'Tutti')
      setSoloUnNome(p.soloUnNome ?? true)
      setStatus(`Sessione caricata (${new Date(res.timestamp).toLocaleString('it-IT')})`)
    } catch (e) { setStatus('Errore caricamento: ' + e.message) }
    finally { setLoading(false) }
  }

  // ── RENDER ───────────────────────────────────────────────────────────────────
  const btnBase   = 'px-3 py-1.5 rounded text-sm font-semibold transition-colors'
  const btnPrimary = `${btnBase} bg-sb-blue text-white hover:bg-sb-hover`
  const btnSecond  = `${btnBase} bg-sb-panel text-sb-text border border-sb-sep hover:bg-sb-bg`
  const btnDanger  = `${btnBase} bg-red-500 text-white hover:bg-red-600`

  return (
    <div className="p-6 space-y-5">
      {/* ── TOP BAR ── */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-sb-text flex-1">Qualifiche</h1>
        {/* Competizione */}
        <div className="flex items-center gap-2">
          <select
            className="bg-sb-bg border border-sb-sep rounded px-3 py-1.5 text-sm text-sb-text focus:outline-none focus:border-sb-blue"
            value={competizione} onChange={e => setCompetizione(e.target.value)}
          >
            <option value="">— Seleziona competizione —</option>
            {regolamenti.map(r => <option key={r.id} value={r.nome}>{r.nome}</option>)}
          </select>
          {pdfLoading && <span className="text-xs text-sb-muted animate-pulse">⏳ Caricamento PDF…</span>}
          {!pdfLoading && programma.length > 0 && <span className="text-xs text-sb-green">✓ Programma ({programma.length} giorni)</span>}
          {!pdfLoading && competizione && programma.length === 0 && <span className="text-xs text-sb-muted">⚠ Nessun programma nel PDF</span>}
        </div>
      </div>

      {/* ── IMPORT AREA ── */}
      <div
        className="border-2 border-dashed border-sb-sep rounded-xl p-6 text-center cursor-pointer hover:border-sb-blue hover:bg-sb-bg/50 transition-colors"
        onDragOver={e => e.preventDefault()} onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={e => handleFile(e.target.files?.[0])} />
        {fileName ? (
          <p className="text-sb-blue font-semibold text-sm">📂 {fileName}</p>
        ) : (
          <>
            <p className="text-sb-muted text-sm">Trascina qui il file Excel delle qualifiche</p>
            <p className="text-sb-muted/60 text-xs mt-1">oppure clicca per selezionare</p>
          </>
        )}
      </div>

      {/* ── FILTER BAR ── */}
      <div className="flex flex-wrap items-center gap-4 bg-sb-panel rounded-xl px-4 py-3 border border-sb-sep">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-sb-text">
          <input type="checkbox" checked={soloUnNome} onChange={e => setSoloUnNome(e.target.checked)} className="accent-sb-blue w-4 h-4" />
          Un nome per atleta
        </label>
        <div className="flex items-center gap-2 text-sm text-sb-muted">
          Vasca:
          {['Tutte', '25 metri', '50 metri'].map(v => (
            <button key={v} onClick={() => setFilterVasca(v)}
              className={`px-2 py-0.5 rounded text-xs font-semibold ${filterVasca === v ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep'}`}>
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-sb-muted">
          Sesso:
          {['Tutti', 'Male', 'Female'].map(s => (
            <button key={s} onClick={() => setFilterSesso(s)}
              className={`px-2 py-0.5 rounded text-xs font-semibold ${filterSesso === s ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep'}`}>
              {s === 'Male' ? 'M' : s === 'Female' ? 'F' : 'Tutti'}
            </button>
          ))}
        </div>
        <div className="flex gap-2 ml-auto">
          <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-sb-text">
            <input type="checkbox" checked={inclusiGraduatoria} onChange={e => setInclusiGraduatoria(e.target.checked)} className="accent-sb-green w-4 h-4" />
            <span className="text-sb-green font-semibold">Includi Graduatoria</span>
            {Object.keys(graduatoriaLimiti).length > 0 && (
              <span className="text-xs text-sb-muted">(limiti caricati)</span>
            )}
          </label>
          <button onClick={() => setShowAggEstero(true)} className={btnSecond}>+ Aggiungi Estero</button>
          {esteri.length > 0 && (
            <button onClick={() => setShowGestEsteri(true)} className={btnSecond}>
              Gestisci Esteri ({esteri.length})
            </button>
          )}
          <button onClick={() => setShowRinunce(true)} className={`${btnBase} bg-orange-100 text-orange-700 border border-orange-200 hover:bg-orange-200`}>
            Rinunce TL {rinunce.size > 0 && `(${rinunce.size})`}
          </button>
        </div>
      </div>

      {/* ── STATS CARDS ── */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Total gare */}
          <div className="bg-sb-panel rounded-xl p-4 border border-sb-sep">
            <div className="text-xs font-semibold text-sb-muted uppercase mb-1">Totale Gare</div>
            <div className="text-3xl font-bold text-sb-text">{stats.totGare.total}</div>
            <div className="text-xs text-sb-muted mt-1">M: {stats.totGare.M} · F: {stats.totGare.F}</div>
          </div>
          {/* Total atleti */}
          <div className="bg-sb-panel rounded-xl p-4 border border-sb-sep">
            <div className="text-xs font-semibold text-sb-muted uppercase mb-1">Totale Atleti</div>
            <div className="text-3xl font-bold text-sb-text">{stats.totAtleti.total}</div>
            <div className="text-xs text-sb-muted mt-1">M: {stats.totAtleti.M} · F: {stats.totAtleti.F}</div>
          </div>
          {/* Per sezione */}
          <div className="bg-sb-panel rounded-xl p-4 border border-sb-sep col-span-2 md:col-span-1">
            <div className="text-xs font-semibold text-sb-muted uppercase mb-2">Per Sezione</div>
            <div className="space-y-0.5">
              {SEZIONE_ORDER.filter(s => stats.perSezione[s]).map(s => (
                <div key={s} className="flex justify-between text-xs">
                  <span className="font-bold text-sb-blue w-6">{s}</span>
                  <span className="text-sb-muted">{stats.perSezione[s].gare} gare / {stats.perSezione[s].atleti} atleti</span>
                </div>
              ))}
            </div>
          </div>
          {/* Per specialità */}
          <div className="bg-sb-panel rounded-xl p-4 border border-sb-sep">
            <div className="text-xs font-semibold text-sb-muted uppercase mb-2">Per Specialità</div>
            <div className="space-y-0.5">
              {SPEC_ORDER.map(s => {
                const d = stats.perSpec[s] || { M: 0, F: 0 }
                return d.M + d.F > 0 ? (
                  <div key={s} className="flex justify-between text-xs">
                    <span className="font-bold text-sb-aqua w-6">{s}</span>
                    <span className="text-sb-muted">M:{d.M} F:{d.F}</span>
                  </div>
                ) : null
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── PER CATEGORIA ── */}
      {filtered.length > 0 && (
        <div className="bg-sb-panel rounded-xl p-4 border border-sb-sep">
          <div className="text-xs font-semibold text-sb-muted uppercase mb-3">Per Categoria</div>
          <div className="flex flex-wrap gap-3">
            {CAT_ORDER.map(c => {
              const d = stats.perCat[c] || { M: 0, F: 0 }
              return d.M + d.F > 0 ? (
                <div key={c} className="text-center min-w-[70px]">
                  <div className="text-xs font-bold text-sb-text">{c}</div>
                  <div className="text-lg font-bold text-sb-blue">{d.M + d.F}</div>
                  <div className="text-xs text-sb-muted">M:{d.M} F:{d.F}</div>
                </div>
              ) : null
            })}
          </div>
        </div>
      )}

      {/* ── TABLE ── */}
      {filtered.length > 0 && (
        <div className="rounded-xl border border-sb-sep overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-sb-blue text-white text-xs">
                  {['Atleta','Sez.','Cat.','S','Vasca','Specialità','Dist.','Tempo','FINA','Tipo'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r._id + i} className={`border-b border-sb-sep/50 ${i % 2 === 0 ? 'bg-white' : 'bg-sb-bg/30'} hover:bg-sb-hover/5`}>
                    <td className="px-3 py-1.5 font-medium text-sb-text">{r.atleta}</td>
                    <td className="px-3 py-1.5 font-bold text-sb-blue text-xs">{r.sezione}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{normCat(r.categoria)}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{r.sesso === 'Male' ? 'M' : 'F'}</td>
                    <td className="px-3 py-1.5 text-sb-muted text-xs">{r.vasca?.replace(' metri', 'm')}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.specialita}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.distanza}</td>
                    <td className="px-3 py-1.5 font-mono text-sb-text">{r.tempo}</td>
                    <td className="px-3 py-1.5 text-sb-muted">{r.fina}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${r._source === 'xlsx' ? 'bg-blue-100 text-blue-600' : r._source === 'TL' ? 'bg-purple-100 text-purple-600' : 'bg-green-100 text-green-600'}`}>
                        {r._source === 'xlsx' ? 'TL' : r._source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length === 0 && xlsxRows.length === 0 && (
        <div className="text-center py-16 text-sb-muted">
          <p className="text-4xl mb-3">🏊</p>
          <p className="font-semibold">Nessuna qualifica caricata</p>
          <p className="text-xs mt-1">Importa un file Excel o carica una sessione salvata</p>
        </div>
      )}

      {/* ── ACTION BUTTONS ── */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-sb-sep">
        <button onClick={() => exportExcel(filtered, competizione)} disabled={filtered.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
          📊 Esporta Excel
        </button>
        <button onClick={() => exportGrigliaGare(filtered, competizione, programma)} disabled={filtered.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
          📋 Genera Griglia Gare {programma.length > 0 && <span className="text-xs opacity-70">({programma.length}gg)</span>}
        </button>
        <button onClick={() => setShowAnalisi(true)} disabled={filtered.length === 0} className={btnSecond + ' disabled:opacity-40'}>
          📈 Analisi Sezione
        </button>
        <div className="flex-1" />
        <button onClick={handleLoad} disabled={loading} className={btnSecond + ' disabled:opacity-40'}>
          {loading ? '⏳ Caricamento…' : '☁️ Carica Sessione'}
        </button>
        <button onClick={handleSave} disabled={saving || allRows.length === 0} className={btnPrimary + ' disabled:opacity-40'}>
          {saving ? '⏳ Salvataggio…' : '💾 Salva'}
        </button>
        <a
          href="https://aqt.ficr.it"
          target="_blank" rel="noopener noreferrer"
          className={`${btnSecond} no-underline inline-flex items-center gap-1`}
        >
          🔍 Verifica su AQT
        </a>
      </div>

      {/* ── STATUS ── */}
      {status && (
        <div className={`text-sm px-4 py-2 rounded-lg ${status.startsWith('Errore') ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
          {status}
        </div>
      )}

      {/* ── MODALS ── */}
      {showAggEstero && (
        <ModalAggiungiEstero
          onClose={() => setShowAggEstero(false)}
          onAdd={e => setEsteri(prev => [...prev, e])}
        />
      )}
      {showGestEsteri && (
        <ModalGestisciEsteri
          esteri={esteri}
          onClose={() => setShowGestEsteri(false)}
          onRemove={id => setEsteri(prev => prev.filter(e => e._id !== id))}
        />
      )}
      {showRinunce && (
        <ModalRinunce
          allRows={allRows}
          rinunce={rinunce}
          onClose={() => setShowRinunce(false)}
          onSave={sel => setRinunce(sel)}
        />
      )}
      {showAnalisi && (
        <ModalAnalisiSezione
          rows={filtered}
          onClose={() => setShowAnalisi(false)}
        />
      )}
    </div>
  )
}
