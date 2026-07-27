import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import LZString from 'lz-string'
import * as XLSX from 'xlsx'
import { ref as rtdbRef, get as rtdbGet, set as rtdbSet } from 'firebase/database'
import { rtdb } from '../lib/firebase'

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function loadClassificheFromCloud() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'classifiche_aqt'))
  if (!snap.exists()) return null
  const val = snap.val()
  const rows = JSON.parse(LZString.decompress(val.data))
  return { rows, stagione: val.stagione, timestamp: val.timestamp }
}

async function loadRinunceFromCloud(compKey) {
  const snap = await rtdbGet(rtdbRef(rtdb, `grad_posizioni/rinunce/${compKey}`))
  if (!snap.exists()) return { rinunceGrad: {}, rinunceB: {} }
  return snap.val()
}

async function saveRinunceToCloud(compKey, data) {
  await rtdbSet(rtdbRef(rtdb, `grad_posizioni/rinunce/${compKey}`), data)
}

// Stessa lista "regolamenti" (nomi estesi, es. "Campionati Nazionali Giovanili
// di Categoria") usata nella tab Qualifiche e nella tab Regolamenti, così il
// nome mostrato qui coincide con quello mostrato lì.
async function cloudLoadRegolamenti() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/meta'))
  if (!snap.exists()) return []
  const val = snap.val()
  const dec = LZString.decompressFromBase64(val.data) || LZString.decompress(val.data)
  return JSON.parse(dec) || []
}

// ── localStorage helpers ──────────────────────────────────────────────────────

const lsGet = (key, fallback = null) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const dec = LZString.decompress(raw)
    return JSON.parse(dec || raw)
  } catch { return fallback }
}
const lsSet = (key, value) => {
  try { localStorage.setItem(key, LZString.compress(JSON.stringify(value))) }
  catch (e) { console.warn('ls write failed:', e.message) }
}

// ── Configurazione competizioni (speculare a NuotoDownloader.py) ─────────────

const REG_COMPS = [
  'Criteria Giovanili',
  'C.I. di Categoria',
  'C.I. Assoluto Invernale',
  'C.I. Assoluto Primaverile',
  'Trofeo Sette Colli',
]

const REG_CAT_AMMESSE = {
  'Criteria Giovanili': {
    Femmine: ['RAGAZZI 1° Anno','RAGAZZI 2° Anno','JUNIORES 1° Anno','JUNIORES 2° Anno','CADETTI'],
    Maschi:  ['RAGAZZI 1° Anno','RAGAZZI 2° Anno','RAGAZZI 3° Anno','JUNIORES 1° Anno','JUNIORES 2° Anno','CADETTI'],
  },
  'C.I. di Categoria': {
    Femmine: ['RAGAZZI 1° Anno','RAGAZZI 2° Anno','JUNIORES 1° Anno','JUNIORES 2° Anno','CADETTI','SENIORES'],
    Maschi:  ['RAGAZZI 1° Anno','RAGAZZI 2° Anno','RAGAZZI 3° Anno','JUNIORES 1° Anno','JUNIORES 2° Anno','CADETTI','SENIORES'],
  },
  'C.I. Assoluto Invernale':   { Femmine: [], Maschi: [] },
  'C.I. Assoluto Primaverile': { Femmine: [], Maschi: [] },
  'Trofeo Sette Colli':        { Femmine: [], Maschi: [] },
}

const REG_VASCA = {
  'Criteria Giovanili':        '25',
  'C.I. di Categoria':         '50',
  'C.I. Assoluto Invernale':   '25',
  'C.I. Assoluto Primaverile': '50',
  'Trofeo Sette Colli':        '50',
}

const REG_HA_GRAD = {
  'Criteria Giovanili':        true,
  'C.I. di Categoria':         true,
  'C.I. Assoluto Invernale':   false,
  'C.I. Assoluto Primaverile': false,
  'Trofeo Sette Colli':        false,
}

const DEFAULT_TOP_N = 30

// Soglie recupero per rinunce (FIN +5): 30→41 | 20/19→30 | 15→23 | 14→22 | 13/12→21 | 10→19
const RECUPERO_MAP = { 30:41, 20:30, 19:30, 15:23, 14:22, 13:21, 12:21, 10:19 }
const DEFAULT_RECUPERO_EXTRA = 11

function getRecuperoMax(topN) {
  if (RECUPERO_MAP[topN] !== undefined) return RECUPERO_MAP[topN]
  const cands = Object.entries(RECUPERO_MAP)
    .map(([k, v]) => [Math.abs(Number(k) - topN), Number(v)])
    .sort((a, b) => a[0] - b[0])
  return cands.length && cands[0][0] <= 3 ? cands[0][1] : topN + DEFAULT_RECUPERO_EXTRA
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normVasca(v) {
  return String(v || '').includes('50') ? '50' : '25'
}

function isSuperba(r) {
  return (r.Societa || '').toLowerCase().includes('superba')
}

function posN(r) {
  const n = parseInt(String(r.Pos ?? '9999').replace('.', ''), 10)
  return isNaN(n) ? 9999 : n
}

function gara_specialita(gara) {
  const g = (gara || '').toLowerCase()
  if (g.includes('stile')) return 'Stile Libero'
  if (g.includes('dorso')) return 'Dorso'
  if (g.includes('rana'))  return 'Rana'
  if (g.includes('farfalla')) return 'Farfalla'
  if (g.includes('misti')) return 'Misti'
  return ''
}

function gara_distanza(gara) {
  const m = String(gara || '').match(/^(\d+)/)
  return m ? m[1] : ''
}

function compKey(comp) {
  return comp.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

// Mappa un nome competizione (breve, come qui, o esteso, come in Qualifiche/
// Regolamenti) alla stessa chiave canonica di REG_COMPS. Speculare a
// _reg_match_comp in NuotoDownloader.py.
function matchRegComp(nomeComp) {
  const v = (nomeComp || '').toLowerCase()
  if (v.includes('criteria')) return 'Criteria Giovanili'
  if (v.includes('assoluto') && (v.includes('invernale') || v.includes('winter'))) return 'C.I. Assoluto Invernale'
  if (v.includes('assoluto') && (v.includes('primaverile') || v.includes('spring') || v.includes('estivo'))) return 'C.I. Assoluto Primaverile'
  if (v.includes('categoria')) return 'C.I. di Categoria'
  if (v.includes('sette colli') || v.includes('settecolli')) return 'Trofeo Sette Colli'
  return null
}

// ── Color classes per tag ─────────────────────────────────────────────────────

// Usiamo stili inline per fedeltà cromatica al Windows app
const TAG_STYLE = {
  rinuncia:      { background: '#E8F5E9', color: '#2E7D32' },  // verde: entrato per rinuncia
  rinuncia_grad: { background: '#FFEBEE', color: '#B71C1C' },  // rosso: avente diritto rinuncia
  extra:         { background: '#E8EAF6', color: '#5C6BC0' },  // blu/grigio: riserve pari tempo
  estero_grad:   { background: '#F3E5F5', color: '#6A1B9A' },  // viola: estero GRAD
  top3:          { background: '#D1C4E9', color: '#311B92' },  // viola scuro: top 3
  even:          { background: '#EDE7F6', color: '#333' },
  odd:           { background: '#FAFAFA', color: '#333' },
}

// ── Componente principale ─────────────────────────────────────────────────────

export default function GradPosizioni() {
  const fileInputRef = useRef(null)

  // ── Dati sorgente ─────────────────────────────────────────────────────────
  const [allRows,      setAllRows]      = useState(() => lsGet('classifiche_allRows', []))
  const [lastUpdate,   setLastUpdate]   = useState(() => localStorage.getItem('aqt_lastupdate') || '')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [error,        setError]        = useState('')

  // ── Impostazioni ──────────────────────────────────────────────────────────
  const [competizione, setCompetizione] = useState(() => localStorage.getItem('qg_comp') || 'C.I. di Categoria')
  const [topNManuale,  setTopNManuale]  = useState(() => parseInt(localStorage.getItem('qg_topn') || '30', 10))

  // Nomi estesi (stessa fonte di Qualifiche/Regolamenti), solo per mostrare
  // nel menu la stessa dicitura vista nelle altre tab. La chiave interna
  // (competizione, usata per REG_CAT_AMMESSE/REG_VASCA/compKey) resta quella
  // breve, invariata, per non perdere rinunce già salvate.
  const [regolamenti, setRegolamenti] = useState([])
  useEffect(() => { cloudLoadRegolamenti().then(setRegolamenti).catch(() => {}) }, [])
  const nomeEsteso = useCallback((c) => {
    const match = regolamenti.find(r => matchRegComp(r.nome) === c)
    return match ? match.nome : c
  }, [regolamenti])

  // ── Risultati calcolati ───────────────────────────────────────────────────
  const [gradRows,   setGradRows]   = useState(() => lsGet('qg_grad_rows', []))
  const [calcolato,  setCalcolato]  = useState(false)
  const [badge,      setBadge]      = useState('')

  // ── Rinunce (per persistenza locale + cloud) ──────────────────────────────
  // rinunceGrad: { "atleta|gara": true } — aventi diritto che rinunciano
  // rinunceB:    { "atleta|gara": true } — riserve confermate per ingresso
  const [rinunceGrad, setRinunceGrad] = useState(() => lsGet(`qg_rin_a_${compKey(localStorage.getItem('qg_comp') || 'C.I. di Categoria')}`, {}))
  const [rinunceB,    setRinunceB]    = useState(() => lsGet(`qg_rin_b_${compKey(localStorage.getItem('qg_comp') || 'C.I. di Categoria')}`, {}))

  // ── Filtri tabella ────────────────────────────────────────────────────────
  const [filtSesso,    setFiltSesso]    = useState('')
  const [filtSpec,     setFiltSpec]     = useState('')
  const [filtDist,     setFiltDist]     = useState('')
  const [filtCat,      setFiltCat]      = useState('')

  // ── Popup rinunce ─────────────────────────────────────────────────────────
  const [showPopup,  setShowPopup]  = useState(false)
  const [popupTab,   setPopupTab]   = useState('A') // 'A' | 'B'

  // Carica da cloud al mount se non ci sono dati locali
  const handleCloudLoad = useCallback(() => {
    setCloudLoading(true); setError('')
    loadClassificheFromCloud()
      .then(data => {
        if (data?.rows?.length > 0) {
          setAllRows(data.rows)
          lsSet('classifiche_allRows', data.rows)
          const ts = data.timestamp ? new Date(data.timestamp).toLocaleString('it-IT') : ''
          setLastUpdate(`Da cloud · ${ts}`)
        } else {
          setError('Nessun dato Classifiche trovato su Firebase. Vai nella scheda Classifiche e scarica prima i dati.')
        }
      })
      .catch(e => setError(`Errore Firebase: ${e.message}`))
      .finally(() => setCloudLoading(false))
  }, [])

  useEffect(() => {
    if (allRows.length === 0) handleCloudLoad()
  }, []) // eslint-disable-line

  // Persisti competizione e top_n
  useEffect(() => { localStorage.setItem('qg_comp', competizione) }, [competizione])
  useEffect(() => { localStorage.setItem('qg_topn', String(topNManuale)) }, [topNManuale])

  // Carica rinunce quando cambia competizione
  useEffect(() => {
    const ck = compKey(competizione)
    setRinunceGrad(lsGet(`qg_rin_a_${ck}`, {}))
    setRinunceB(   lsGet(`qg_rin_b_${ck}`, {}))
  }, [competizione])

  // Stagione rilevata dai dati caricati
  const stagione = useMemo(() => {
    const stags = [...new Set(allRows.map(r => r.stagione).filter(Boolean))]
    return stags.sort().reverse()[0] || ''
  }, [allRows])

  // Categorie disponibili per il filtro
  const catsDisponibili = useMemo(() => {
    return [...new Set(allRows.map(r => r._categoria).filter(Boolean))].sort()
  }, [allRows])

  // ── Calcolo qualificati ────────────────────────────────────────────────────

  const handleCalcola = useCallback(() => {
    if (!allRows.length) {
      setError('Carica prima i dati Classifiche dalla scheda Classifiche Naz.')
      return
    }

    const catAmmesse = REG_CAT_AMMESSE[competizione] || { Femmine: [], Maschi: [] }
    const vascaComp  = REG_VASCA[competizione] || ''
    const topN       = topNManuale

    function ok(r) {
      if (!isSuperba(r)) return false
      if (vascaComp && normVasca(r.Vasca) !== vascaComp) return false
      const cat = (r._categoria || '').trim()
      const sx  = r._sesso || ''
      const ammesse = catAmmesse[sx] || []
      if (ammesse.length > 0 && !ammesse.includes(cat)) return false
      return true
    }

    // Raggruppa per (gara, categoria, sesso)
    const bucket = new Map()
    for (const r of allRows) {
      if (!ok(r)) continue
      const key = `${r._gara}||${r._categoria}||${r._sesso}`
      if (!bucket.has(key)) bucket.set(key, [])
      bucket.get(key).push(r)
    }

    const result = []
    const seen   = new Set()

    for (const [key, righe] of bucket) {
      const [gara, cat, sx] = key.split('||')
      const topNExtra = topN + 5
      const sorted    = [...righe].sort((a, b) => posN(a) - posN(b))

      for (const r of sorted) {
        const p = posN(r)
        if (p > topNExtra) break
        const atleta = (r.Atleta || '').trim()
        const dk     = `${atleta.toLowerCase()}|${gara}`
        if (seen.has(dk)) continue
        seen.add(dk)

        const isExtra = p > topN
        result.push({
          POS:       String(r.Pos || ''),
          ATLETA:    atleta,
          SEZIONE:   '—',
          CATEGORIA: cat,
          SESSO:     sx,
          GARA:      gara,
          VASCA:     r.Vasca || '',
          TEMPO:     r.Tempo || '',
          PTFINA:    r.PtFINA || '',
          DATA:      r.Data || '',
          _extra:    isExtra,
          _riserva:  isExtra,
          _estero:   false,
          _rinuncia:      false,
          _rinuncia_grad: false,
          _atleta_key: atleta.toLowerCase(),
          _gara_key:   gara,
        })
      }
    }

    // Applica rinunce salvate
    const ck = compKey(competizione)
    const rGA = lsGet(`qg_rin_a_${ck}`, {})
    const rGB = lsGet(`qg_rin_b_${ck}`, {})
    for (const r of result) {
      const k = `${r._atleta_key}|${r._gara_key}`
      if (!r._extra && rGA[k]) r._rinuncia_grad = true
      if ((r._extra || r._riserva) && rGB[k]) r._rinuncia = true
    }

    setGradRows(result)
    lsSet('qg_grad_rows', result)
    setCalcolato(true)

    const nAD    = result.filter(r => !r._extra).length
    const nRis   = result.filter(r => r._extra).length
    const nAtl   = new Set(result.map(r => r.ATLETA)).size
    const nGare  = new Set(result.map(r => `${r.GARA}|${r.CATEGORIA}|${r.SESSO}`)).size
    setBadge(`${nAD} qualificati  ·  ${nRis} riserve pari tempo  ·  ${nAtl} atleti  ·  Top N: ${topN}  ·  ${nGare} combinazioni gara/cat`)
    setError('')
  }, [allRows, competizione, topNManuale])

  // ── Ricalcola se cambiano rinunce ─────────────────────────────────────────

  const gradRowsWithRinunce = useMemo(() => {
    return gradRows.map(r => {
      const k = `${r._atleta_key}|${r._gara_key}`
      return {
        ...r,
        _rinuncia_grad: !r._extra && !!rinunceGrad[k],
        _rinuncia:      (r._extra || r._riserva) && !!rinunceB[k],
      }
    })
  }, [gradRows, rinunceGrad, rinunceB])

  // ── Filtri ────────────────────────────────────────────────────────────────

  const displayRows = useMemo(() => {
    let rows = gradRowsWithRinunce
    if (filtSesso && filtSesso !== '— Tutti —') rows = rows.filter(r => r.SESSO === filtSesso)
    if (filtSpec  && filtSpec  !== '— Tutte —') rows = rows.filter(r => gara_specialita(r.GARA) === filtSpec)
    if (filtDist  && filtDist  !== '— Tutte —') rows = rows.filter(r => gara_distanza(r.GARA) === filtDist)
    if (filtCat   && filtCat   !== '— Tutte —') rows = rows.filter(r => r.CATEGORIA === filtCat)

    return [...rows].sort((a, b) => {
      const gruA = a._rinuncia ? 0 : a._rinuncia_grad ? 1 : (!a._extra && !a._riserva) ? 2 : 3
      const gruB = b._rinuncia ? 0 : b._rinuncia_grad ? 1 : (!b._extra && !b._riserva) ? 2 : 3
      if (gruA !== gruB) return gruA - gruB
      return a.ATLETA.localeCompare(b.ATLETA, 'it')
    })
  }, [gradRowsWithRinunce, filtSesso, filtSpec, filtDist, filtCat])

  // ── Tag per colore ────────────────────────────────────────────────────────

  function rowTag(r, idx) {
    if (r._rinuncia)      return 'rinuncia'
    if (r._rinuncia_grad) return 'rinuncia_grad'
    if (r._extra || r._riserva) return 'extra'
    if (r._estero)        return 'estero_grad'
    const p = posN({ Pos: r.POS })
    if (p <= 3)           return 'top3'
    return idx % 2 === 0 ? 'even' : 'odd'
  }

  function statoLabel(r) {
    if (r._rinuncia)      return '✅ Per rinuncia'
    if (r._rinuncia_grad) return '🚫 Rinuncia'
    if (r._extra || r._riserva) return '⏳ Riserva'
    if (r._estero)        return '🌍 Estero'
    return '✔ Di diritto'
  }

  // ── Export XLSX ───────────────────────────────────────────────────────────

  const handleExportXLSX = () => {
    if (!displayRows.length) return
    const cols = ['POS','ATLETA','STATO','SEZIONE','CATEGORIA','SESSO','GARA','VASCA','TEMPO','PT.FINA','DATA']
    const wsData = [
      cols,
      ...displayRows.map(r => [
        r.POS, r.ATLETA, statoLabel(r), r.SEZIONE, r.CATEGORIA, r.SESSO,
        r.GARA, r.VASCA, r.TEMPO, r.PTFINA, r.DATA,
      ]),
    ]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    ws['!cols'] = [6, 22, 16, 16, 18, 10, 22, 10, 10, 8, 12].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Qualificati')
    const ck = compKey(competizione)
    XLSX.writeFile(wb, `qualificati_graduatoria_${ck}.xlsx`)
  }

  // ── Salva rinunce ─────────────────────────────────────────────────────────

  function saveRinunce(newA, newB) {
    const ck = compKey(competizione)
    setRinunceGrad(newA)
    setRinunceB(newB)
    lsSet(`qg_rin_a_${ck}`, newA)
    lsSet(`qg_rin_b_${ck}`, newB)
    saveRinunceToCloud(ck, { rinunceGrad: newA, rinunceB: newB }).catch(e => console.warn('[RTDB rinunce]', e))
  }

  // ── Popup rinunce ─────────────────────────────────────────────────────────

  const aventiDiritto = useMemo(() =>
    gradRows
      .filter(r => !r._extra && !r._riserva && !r._estero)
      .sort((a, b) => a.ATLETA.localeCompare(b.ATLETA, 'it')),
  [gradRows])

  const tutteRiserve = useMemo(() => {
    const present = new Set(gradRows.filter(r => r._extra || r._riserva).map(r => `${r._atleta_key}|${r._gara_key}`))
    const base = gradRows.filter(r => r._extra || r._riserva)

    const topN       = topNManuale
    const topNExtra  = topN + 5
    const maxRecupero = getRecuperoMax(topN)
    const catAmmesse = REG_CAT_AMMESSE[competizione] || { Femmine: [], Maschi: [] }
    const vascaComp  = REG_VASCA[competizione] || ''

    // Candidati aggiuntivi da allRows (oltre top_n+5, fino a max_recupero)
    const extra = []
    const seenAD = new Set(gradRows.filter(r => !r._extra && !r._riserva).map(r => `${r._atleta_key}|${r._gara_key}`))

    for (const r of allRows) {
      if (!isSuperba(r)) continue
      if (vascaComp && normVasca(r.Vasca) !== vascaComp) continue
      const cat = (r._categoria || '').trim()
      const sx  = r._sesso || ''
      const ammesse = catAmmesse[sx] || []
      if (ammesse.length > 0 && !ammesse.includes(cat)) continue
      const p = posN(r)
      if (p <= topNExtra || p > maxRecupero) continue
      const atleta = (r.Atleta || '').trim()
      const dk = `${atleta.toLowerCase()}|${r._gara}`
      if (present.has(dk) || seenAD.has(dk)) continue
      extra.push({
        POS: String(r.Pos || ''), TOP_N: String(topN), POS_MAX: String(maxRecupero),
        ATLETA: atleta, CATEGORIA: cat, SESSO: sx,
        GARA: r._gara, VASCA: r.Vasca || '', TEMPO: r.Tempo || '', PTFINA: r.PtFINA || '',
        _atleta_key: atleta.toLowerCase(), _gara_key: r._gara,
        _extra_candidato: true,
      })
    }

    // Merge + dedup
    const seen2 = new Set()
    const merged = []
    for (const r of [...base, ...extra]) {
      const dk = `${r._atleta_key}|${r._gara_key}`
      if (!seen2.has(dk)) { seen2.add(dk); merged.push(r) }
    }
    return merged.sort((a, b) => a.ATLETA.localeCompare(b.ATLETA, 'it'))
  }, [gradRows, allRows, competizione, topNManuale])

  // ── Contatori badge popup ─────────────────────────────────────────────────

  const nRinA = useMemo(() => aventiDiritto.filter(r => rinunceGrad[`${r._atleta_key}|${r._gara_key}`]).length, [aventiDiritto, rinunceGrad])
  const nRinB = useMemo(() => tutteRiserve.filter(r => rinunceB[`${r._atleta_key}|${r._gara_key}`]).length, [tutteRiserve, rinunceB])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 min-h-0">

      {/* Header ============================================================ */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-sb-text">Qualificati per Graduatoria</h1>
          <p className="text-xs text-sb-muted mt-0.5">
            {cloudLoading ? '☁ Caricamento classifiche...'
              : allRows.length > 0
                ? `${allRows.length.toLocaleString('it-IT')} righe classifiche${stagione ? ` · Stagione ${stagione}` : ''}${lastUpdate ? ` · ${lastUpdate}` : ''}`
                : 'Nessun dato classifiche caricato'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleCloudLoad} disabled={cloudLoading}
            className="px-3 py-1.5 text-sm text-sb-blue border border-sb-blue/30 rounded-lg hover:bg-sb-blue/10 disabled:opacity-50 transition-colors">
            {cloudLoading ? '⏳' : '☁'} Da cloud
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
      )}

      {/* Card impostazioni ================================================= */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl overflow-hidden">
        <div className="bg-[#26C6DA] px-4 py-2 flex items-center gap-2">
          <span className="text-white text-xs font-bold uppercase tracking-widest">⚙  IMPOSTAZIONI</span>
        </div>
        <div className="px-4 py-3 flex flex-wrap gap-5 items-center">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-sb-muted">Stagione:</span>
            <span className="font-bold text-sb-blue">{stagione || '—'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-sb-muted">Competizione:</span>
            <select value={competizione} onChange={e => setCompetizione(e.target.value)}
              className="border border-sb-sep rounded-md px-2 py-1 text-sm bg-white text-sb-text font-semibold text-[#5C6BC0]">
              {REG_COMPS.filter(c => REG_HA_GRAD[c]).map(c => (
                <option key={c} value={c}>{nomeEsteso(c)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-sb-muted">Top N (default):</span>
            <input
              type="number" min={1} max={200} value={topNManuale}
              onChange={e => setTopNManuale(Number(e.target.value) || DEFAULT_TOP_N)}
              className="w-16 border border-sb-sep rounded-md px-2 py-1 text-sm text-center"
            />
          </div>
          <span className="text-xs text-sb-muted">
            Solo atleti Superba  |  Vasca: {REG_VASCA[competizione] || '?'}m  |  Riserve: Top N +5
          </span>
        </div>
      </div>

      {/* Bottoni =========================================================== */}
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={handleCalcola} disabled={!allRows.length}
          className="flex items-center gap-2 px-5 py-2 bg-[#5C6BC0] text-white font-bold rounded-lg hover:bg-[#3F51B5] disabled:opacity-40 transition-colors text-sm">
          📋 CALCOLA QUALIFICATI PER GRADUATORIA
        </button>
        <button onClick={handleExportXLSX} disabled={!displayRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-sb-blue text-white text-sm font-medium rounded-lg hover:bg-sb-blue/90 disabled:opacity-40 transition-colors">
          💾 Esporta XLSX
        </button>
        <button onClick={() => { if (!gradRows.length) { setError('Calcola prima i qualificati.'); return } setShowPopup(true) }}
          disabled={!gradRows.length}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#E65100] text-white text-sm font-medium rounded-lg hover:bg-[#BF360C] disabled:opacity-40 transition-colors">
          🔄 Iscrivibili per Rinunce
        </button>
      </div>

      {/* Card risultati ===================================================== */}
      <div className="bg-sb-panel border border-[#5C6BC0] rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">

        {/* Header card */}
        <div className="bg-[#5C6BC0] px-4 py-2 flex items-center gap-3">
          <span className="text-white text-xs font-bold uppercase tracking-wide">
            📋 Risultati — Top N Superba per gara/categoria/sesso
          </span>
          {badge && (
            <span className="text-white/90 text-xs ml-auto">{badge}</span>
          )}
        </div>

        {/* Legenda colori */}
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-sb-sep">
          {[
            ['#D1C4E9', '#311B92', '🏆 Top 3'],
            ['#EDE7F6', '#5C6BC0', 'Qualificati'],
            ['#E8EAF6', '#5C6BC0', 'Riserve pari tempo (+5)'],
            ['#F3E5F5', '#6A1B9A', '🌍 Estero GRAD'],
            ['#E8F5E9', '#2E7D32', '✅ Entrato per rinuncia'],
            ['#FFEBEE', '#B71C1C', '🚫 Rinuncia avente diritto'],
          ].map(([bg, fg, label]) => (
            <span key={label} className="text-xs px-2 py-0.5 rounded font-medium border border-black/10"
              style={{ background: bg, color: fg }}>{label}</span>
          ))}
        </div>

        {/* Filtri */}
        <div className="flex flex-wrap gap-4 px-4 py-2 border-b border-sb-sep items-center text-sm">
          <span className="text-sb-muted text-xs">Sesso:</span>
          <select value={filtSesso} onChange={e => setFiltSesso(e.target.value)}
            className="border border-sb-sep rounded px-2 py-1 text-xs bg-white">
            <option value="">— Tutti —</option>
            <option>Maschi</option>
            <option>Femmine</option>
          </select>
          <span className="text-sb-muted text-xs">Specialità:</span>
          <select value={filtSpec} onChange={e => setFiltSpec(e.target.value)}
            className="border border-sb-sep rounded px-2 py-1 text-xs bg-white">
            <option value="">— Tutte —</option>
            {['Stile Libero','Dorso','Rana','Farfalla','Misti'].map(s => <option key={s}>{s}</option>)}
          </select>
          <span className="text-sb-muted text-xs">Distanza:</span>
          <select value={filtDist} onChange={e => setFiltDist(e.target.value)}
            className="border border-sb-sep rounded px-2 py-1 text-xs bg-white">
            <option value="">— Tutte —</option>
            {['50','100','200','400','800','1500'].map(d => <option key={d}>{d}</option>)}
          </select>
          <span className="text-sb-muted text-xs">Categoria:</span>
          <select value={filtCat} onChange={e => setFiltCat(e.target.value)}
            className="border border-sb-sep rounded px-2 py-1 text-xs bg-white min-w-[180px]">
            <option value="">— Tutte —</option>
            {catsDisponibili.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>

        {/* Tabella */}
        <div className="overflow-auto flex-1" style={{ maxHeight: 'calc(100vh - 460px)' }}>
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-sb-bg border-b border-sb-sep z-10">
              <tr>
                {['POS','ATLETA','STATO','SEZIONE','CATEGORIA','SESSO','GARA','VASCA','TEMPO','PT.FINA','DATA'].map(col => (
                  <th key={col}
                    className={`px-2 py-2 font-semibold text-sb-muted uppercase tracking-wide whitespace-nowrap
                      ${['POS','SESSO','VASCA','TEMPO','PT.FINA','DATA'].includes(col) ? 'text-center' : 'text-left'}`}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-16 text-sb-muted">
                    {!allRows.length
                      ? '📂 Carica i dati nella scheda Classifiche Naz., poi torna qui e premi CALCOLA'
                      : calcolato
                        ? 'Nessun risultato per i filtri selezionati'
                        : 'Imposta la competizione e premi CALCOLA QUALIFICATI PER GRADUATORIA'}
                  </td>
                </tr>
              ) : displayRows.map((r, i) => {
                const tag = rowTag(r, i)
                const st  = TAG_STYLE[tag] || {}
                return (
                  <tr key={`${r.ATLETA}-${r.GARA}-${r.CATEGORIA}-${i}`}
                    style={st}
                    className="border-b border-black/5 hover:brightness-95 transition-all">
                    <td className="px-2 py-1.5 text-center font-bold w-10">{r.POS}</td>
                    <td className="px-2 py-1.5 font-medium max-w-[160px] truncate" title={r.ATLETA}>{r.ATLETA}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{statoLabel(r)}</td>
                    <td className="px-2 py-1.5 text-xs opacity-70 max-w-[140px] truncate" title={r.SEZIONE}>{r.SEZIONE}</td>
                    <td className="px-2 py-1.5 max-w-[130px] truncate" title={r.CATEGORIA}>{r.CATEGORIA}</td>
                    <td className="px-2 py-1.5 text-center">{r.SESSO}</td>
                    <td className="px-2 py-1.5 max-w-[150px] truncate" title={r.GARA}>{r.GARA}</td>
                    <td className="px-2 py-1.5 text-center">{r.VASCA}</td>
                    <td className="px-2 py-1.5 text-center font-mono">{r.TEMPO}</td>
                    <td className="px-2 py-1.5 text-center font-semibold">{r.PTFINA}</td>
                    <td className="px-2 py-1.5 text-center whitespace-nowrap">{r.DATA}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Popup rinunce ─────────────────────────────────────────────────── */}
      {showPopup && (
        <PopupRinunce
          aventiDiritto={aventiDiritto}
          tutteRiserve={tutteRiserve}
          rinunceGrad={rinunceGrad}
          rinunceB={rinunceB}
          popupTab={popupTab}
          setPopupTab={setPopupTab}
          nRinA={nRinA}
          nRinB={nRinB}
          onConferma={(newA, newB) => { saveRinunce(newA, newB); setShowPopup(false) }}
          onClose={() => setShowPopup(false)}
        />
      )}

    </div>
  )
}

// ── Popup Rinunce ─────────────────────────────────────────────────────────────

function PopupRinunce({ aventiDiritto, tutteRiserve, rinunceGrad, rinunceB,
                        popupTab, setPopupTab, nRinA, nRinB, onConferma, onClose }) {

  const [selA, setSelA] = useState(() => {
    const s = {}
    aventiDiritto.forEach((r, i) => { s[i] = !!rinunceGrad[`${r._atleta_key}|${r._gara_key}`] })
    return s
  })
  const [selB, setSelB] = useState(() => {
    const s = {}
    tutteRiserve.forEach((r, i) => { s[i] = !!rinunceB[`${r._atleta_key}|${r._gara_key}`] })
    return s
  })

  const cntA = useMemo(() => Object.values(selA).filter(Boolean).length, [selA])
  const cntB = useMemo(() => Object.values(selB).filter(Boolean).length, [selB])

  function handleConferma() {
    const newA = {}
    aventiDiritto.forEach((r, i) => { if (selA[i]) newA[`${r._atleta_key}|${r._gara_key}`] = true })
    const newB = {}
    tutteRiserve.forEach((r, i) => { if (selB[i]) newB[`${r._atleta_key}|${r._gara_key}`] = true })
    onConferma(newA, newB)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 1050, maxWidth: '96vw', maxHeight: '90vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3" style={{ background: '#E65100' }}>
          <div>
            <p className="text-white font-bold text-base">🔄 GESTIONE RINUNCE — GRADUATORIA</p>
            <p className="text-orange-100 text-xs">Tutte le modifiche sono reversibili riaprendo questo popup</p>
          </div>
          <button onClick={onClose} className="text-white text-2xl leading-none px-2 hover:opacity-70">×</button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-4 pt-3 bg-[#1A1A2E]">
          <button
            onClick={() => setPopupTab('A')}
            className="px-5 py-2 rounded-t-lg text-sm font-semibold transition-colors"
            style={popupTab === 'A'
              ? { background: '#B71C1C', color: 'white' }
              : { background: '#2D2D44', color: '#aaa' }}>
            🚫 Sezione A — Rinunce aventi diritto ({cntA} segnate)
          </button>
          <button
            onClick={() => setPopupTab('B')}
            className="px-5 py-2 rounded-t-lg text-sm font-semibold transition-colors"
            style={popupTab === 'B'
              ? { background: '#E65100', color: 'white' }
              : { background: '#2D2D44', color: '#aaa' }}>
            ✅ Sezione B — Iscrivibili per rinuncia ({cntB} confermati)
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col bg-[#1A1A2E] px-4 pb-4">

          {/* Sezione A */}
          {popupTab === 'A' && (
            <div className="flex flex-col flex-1 gap-2 pt-3">
              <p className="text-gray-300 text-xs">
                ℹ Spunta gli atleti aventi diritto che hanno rinunciato. Rimarranno visibili con 🚫 RINUNCIA (rosso)
                ma esclusi dalla Griglia Gare. Rimuovi la spunta per annullare.
              </p>
              <div className="flex-1 overflow-auto rounded-lg border border-red-900 bg-white">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-gray-100">
                    <tr>
                      {['✓','POS','ATLETA','CATEGORIA','SESSO','GARA','VASCA','TEMPO','PT.FINA'].map(h => (
                        <th key={h} className="px-2 py-1.5 font-semibold text-gray-600 text-center border-b border-gray-200">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {aventiDiritto.length === 0 ? (
                      <tr><td colSpan={9} className="text-center py-8 text-gray-400">Nessun atleta avente diritto</td></tr>
                    ) : aventiDiritto.map((r, i) => {
                      const rin = selA[i]
                      return (
                        <tr key={i} className="cursor-pointer hover:brightness-95 border-b border-gray-100"
                          style={rin ? { background: '#FFEBEE', color: '#B71C1C' } : { background: i%2===0 ? '#FAFAFA' : '#F0F4F8' }}
                          onClick={() => setSelA(s => ({ ...s, [i]: !s[i] }))}>
                          <td className="px-2 py-1.5 text-center text-base">{rin ? '☑' : '☐'}</td>
                          <td className="px-2 py-1.5 text-center">{r.POS}</td>
                          <td className="px-2 py-1.5 font-medium max-w-[180px] truncate">{r.ATLETA}</td>
                          <td className="px-2 py-1.5 max-w-[130px] truncate">{r.CATEGORIA}</td>
                          <td className="px-2 py-1.5 text-center">{r.SESSO}</td>
                          <td className="px-2 py-1.5 max-w-[130px] truncate">{r.GARA}</td>
                          <td className="px-2 py-1.5 text-center">{r.VASCA}</td>
                          <td className="px-2 py-1.5 text-center font-mono">{r.TEMPO}</td>
                          <td className="px-2 py-1.5 text-center">{r.PTFINA}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-red-400 text-xs font-bold">{cntA} rinunce segnate</p>
            </div>
          )}

          {/* Sezione B */}
          {popupTab === 'B' && (
            <div className="flex flex-col flex-1 gap-2 pt-3">
              <p className="text-gray-300 text-xs">
                ℹ Spunta gli atleti che entrano per rinuncia. Verranno aggiunti in graduatoria (verde).
                Rimuovi la spunta per annullare.{' '}
                Soglie (FIN +5): 30→41 | 20/19→30 | 15→23 | 14→22 | 12/13→21 | 10→19
              </p>
              <div className="flex-1 overflow-auto rounded-lg border border-orange-900 bg-white">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-gray-100">
                    <tr>
                      {['✓','POS','Top N','Max','ATLETA','CATEGORIA','SESSO','GARA','VASCA','TEMPO','PT.FINA'].map(h => (
                        <th key={h} className="px-2 py-1.5 font-semibold text-gray-600 text-center border-b border-gray-200">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tutteRiserve.length === 0 ? (
                      <tr><td colSpan={11} className="text-center py-8 text-gray-400">Nessuna riserva disponibile</td></tr>
                    ) : tutteRiserve.map((r, i) => {
                      const conf = selB[i]
                      return (
                        <tr key={i} className="cursor-pointer hover:brightness-95 border-b border-gray-100"
                          style={conf ? { background: '#FFF3E0', color: '#E65100' }
                                     : { background: i%2===0 ? '#E8EAF6' : '#EDE7F6', color: '#5C6BC0' }}
                          onClick={() => setSelB(s => ({ ...s, [i]: !s[i] }))}>
                          <td className="px-2 py-1.5 text-center text-base">{conf ? '☑' : '☐'}</td>
                          <td className="px-2 py-1.5 text-center">{r.POS}</td>
                          <td className="px-2 py-1.5 text-center">{r.TOP_N || '—'}</td>
                          <td className="px-2 py-1.5 text-center">{r.POS_MAX || '—'}</td>
                          <td className="px-2 py-1.5 font-medium max-w-[165px] truncate">{r.ATLETA}</td>
                          <td className="px-2 py-1.5 max-w-[125px] truncate">{r.CATEGORIA}</td>
                          <td className="px-2 py-1.5 text-center">{r.SESSO}</td>
                          <td className="px-2 py-1.5 max-w-[120px] truncate">{r.GARA}</td>
                          <td className="px-2 py-1.5 text-center">{r.VASCA}</td>
                          <td className="px-2 py-1.5 text-center font-mono">{r.TEMPO}</td>
                          <td className="px-2 py-1.5 text-center">{r.PTFINA}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-orange-400 text-xs font-bold">{cntB} atleti confermati per ingresso</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-white gap-4">
          <p className="text-xs text-gray-500">
            Sezione A: {cntA} rinunce segnate  ·  Sezione B: {cntB} ingressi confermati
          </p>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-5 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors">
              Annulla
            </button>
            <button onClick={handleConferma}
              className="px-6 py-2 text-sm font-bold text-white rounded-lg transition-colors"
              style={{ background: '#E65100' }}>
              ✔ Conferma e chiudi
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
