import { useState, useRef, useCallback } from 'react'
import { extractPDF } from '../lib/pdfExtractor'
import { db } from '../lib/firebase'
import { collection, doc, writeBatch, getDocs } from 'firebase/firestore'

// Colonne chiave sempre visibili nella tabella interna
const COLS_KEY = ['gara', 'sesso', 'data_gara', 'posizione', 'atleta', 'societa', 'tempo_finale']
const isParziale = c => /^\d+m$/.test(String(c || ''))

// Colonne parziali template (50m, 100m, ... 1500m)
const SPLIT_COLS = Array.from({ length: 30 }, (_, i) => ((i + 1) * 50) + 'm')

// Mappa campo interno → nome colonna template Excel
const COL_MAP = {
  data_gara:    'DATA',
  sesso:        'SESSO',
  gara:         'GARA',
  posizione:    'POS.T',
  atleta:       'ATLETA/SQUADRA',
  societa:      'SOCIETA',
  tempo_finale: 'TEMPO',
}

// Tutte le colonne del template nell'ordine corretto
const TEMPLATE_COLS = [
  'DATA','LUOGO','VASCA','CATEG','SESSO','AGEGROUP','GARA',
  'POS.T','BATT','CORSIA','POS.B','CODICE','ATLETA/SQUADRA','Staf',
  'ANNO','NAZ','CODSOC','SOCIETA','ISCRIZ','ISCRIZ_MILL',
  'TEMPO','TEMPO_MILL','DIFF','DIFF2','RT',
  ...SPLIT_COLS,
]

function rowsToCSV(rows) {
  if (!rows.length) return ''
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  // Inverti la mappa per lookup veloce
  const inv = Object.fromEntries(Object.entries(COL_MAP).map(([k,v]) => [v, k]))
  const lines = rows.map(r => {
    return TEMPLATE_COLS.map(col => {
      const internalKey = inv[col] || col  // prova la mappa inversa, poi il nome diretto
      return esc(r[internalKey] ?? '')
    }).join(';')
  })
  return [TEMPLATE_COLS.join(';'), ...lines].join('\n')
}

function StatChip({ label, value, color = 'text-sb-blue' }) {
  return (
    <div className="bg-sb-bg rounded-xl px-4 py-3 text-center min-w-20">
      <p className={'text-2xl font-bold ' + color}>{value}</p>
      <p className="text-xs text-sb-muted mt-0.5">{label}</p>
    </div>
  )
}

const TAG_COLORS = {
  ok:   'text-green-400',
  err:  'text-red-400',
  warn: 'text-yellow-400',
  info: 'text-blue-300',
  head: 'text-white font-bold',
}

export default function Estrazione() {
  const [rows, setRows]         = useState([])
  const [headers, setHeaders]   = useState([])
  const [fileName, setFileName] = useState('')
  const [stagione, setStagione] = useState('2025/2026')
  const [splitBase, setSplitBase] = useState(50)
  const [filter, setFilter]     = useState({ atleta: '', gara: '', societa: '' })
  const [saving, setSaving]     = useState(false)
  const [savedCount, setSaved]  = useState(null)
  const [dragging, setDragging] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [log, setLog]           = useState([])
  const [progress, setProgress] = useState({ cur: 0, tot: 0 })
  const fileRef   = useRef()
  const logEndRef = useRef()

  const addLog = useCallback((msg, tag = 'info') => {
    setLog(prev => [...prev, { msg, tag, id: Date.now() + Math.random() }])
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 30)
  }, [])

  async function loadFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      addLog('Seleziona un file PDF.', 'warn'); return
    }
    setExtracting(true)
    setSaved(null)
    setLog([])
    setRows([])
    setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      const extracted = await extractPDF({
        arrayBuffer: buf,
        filename: file.name,
        splitBase: Number(splitBase),
        maxParziali: 30,
        onLog: msg => {
          const tag = msg.startsWith('✓') ? 'ok'
                    : msg.startsWith('▶') ? 'head'
                    : msg.toLowerCase().includes('gara:') ? 'info'
                    : 'info'
          addLog(msg, tag)
        },
        onProgress: (p, tot) => setProgress({ cur: p, tot }),
      })
      if (extracted.length === 0) {
        addLog('Nessun risultato estratto. Verifica che il PDF contenga "Superba Nuoto" come testo selezionabile.', 'warn')
      }
      setRows(extracted)
      // Raccogli TUTTE le colonne da tutti i risultati (non solo il primo)
      if (extracted.length) {
        const allKeys = new Set()
        extracted.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)))
        setHeaders([...allKeys])
      } else {
        setHeaders([])
      }
    } catch (e) {
      addLog('Errore estrazione: ' + e.message, 'err')
    } finally {
      setExtracting(false)
      setProgress({ cur: 0, tot: 0 })
    }
  }

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }, [splitBase]) // eslint-disable-line

  const parzialiCols = headers.filter(isParziale).sort((a,b) => parseInt(a) - parseInt(b))
  const keyCols      = headers.filter(h => COLS_KEY.includes(h))

  const filtered = rows.filter(r => {
    const a = filter.atleta.toLowerCase()
    const g = filter.gara.toLowerCase()
    const s = filter.societa.toLowerCase()
    return (!a || (r.atleta || '').toLowerCase().includes(a))
        && (!g || (r.gara   || '').toLowerCase().includes(g))
        && (!s || (r.societa|| '').toLowerCase().includes(s))
  })

  const uniqueAtleti  = [...new Set(rows.map(r => r.atleta).filter(Boolean))].length
  const uniqueGare    = [...new Set(rows.map(r => r.gara).filter(Boolean))].length

  async function saveToFirebase() {
    if (!rows.length) return
    setSaving(true)
    try {
      const colRef = collection(db, 'risultati', stagione, 'righe')
      const snap = await getDocs(colRef)
      let del = writeBatch(db); let dc = 0
      for (const d of snap.docs) {
        del.delete(d.ref); dc++
        if (dc === 400) { await del.commit(); del = writeBatch(db); dc = 0 }
      }
      if (dc > 0) await del.commit()
      let wb = writeBatch(db); let wc = 0
      for (const row of rows) {
        wb.set(doc(colRef), { ...row, _stagione: stagione })
        wc++
        if (wc === 400) { await wb.commit(); wb = writeBatch(db); wc = 0 }
      }
      if (wc > 0) await wb.commit()
      setSaved(rows.length)
    } catch (e) { alert('Errore Firebase: ' + e.message) }
    finally { setSaving(false) }
  }

  function downloadCSV() {
    const csv = '﻿' + rowsToCSV(rows)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName.replace(/\.pdf$/i, '') + '_superba.csv'
    a.click(); URL.revokeObjectURL(a.href)
  }

  const progressPct = progress.tot > 0 ? Math.round((progress.cur / progress.tot) * 100) : 0

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      {/* Header opzioni */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua" />
        <div className="px-5 py-4 flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-sb-text mb-0.5">Estrazione da PDF</p>
            <p className="text-xs text-sb-muted">
              Carica il PDF scaricato da genovagare.it — estrarrà i risultati di <strong>Superba Nuoto ssd</strong>
            </p>
          </div>

          {/* Stagione */}
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Stagione</label>
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {['2025/2026','2024/2025','2023/2024','2026/2027'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          {/* Split base */}
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Parziali ogni</label>
            <select value={splitBase} onChange={e => setSplitBase(Number(e.target.value))}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              <option value={50}>50 m</option>
              <option value={25}>25 m</option>
            </select>
          </div>

          <button onClick={() => fileRef.current?.click()} disabled={extracting}
            className="px-5 py-2 bg-sb-blue text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
            {extracting ? '⏳ Estrazione…' : '📂 Scegli PDF'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf" className="hidden"
            onChange={e => loadFile(e.target.files[0])} />
        </div>
      </div>

      {/* Drop zone (solo se niente caricato e non in estrazione) */}
      {rows.length === 0 && !extracting && log.length === 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed cursor-pointer transition-all py-20 '
            + (dragging ? 'border-sb-blue bg-blue-50' : 'border-sb-sep bg-sb-panel hover:border-sb-blue/50')}>
          <p className="text-4xl mb-3 opacity-30">📄</p>
          <p className="text-sb-muted font-medium text-sm">Trascina il PDF qui o clicca per sceglierlo</p>
          <p className="text-sb-muted text-xs mt-1">PDF da genovagare.it — estrae automaticamente i risultati Superba Nuoto</p>
        </div>
      )}

      {/* Log estrazione */}
      {(extracting || log.length > 0) && rows.length === 0 && (
        <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm flex flex-col" style={{ maxHeight: '340px' }}>
          <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-sb-sep">
            <p className="text-xs font-bold text-sb-aqua uppercase tracking-wider">Log Estrazione</p>
            {extracting && progress.tot > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-sb-dark rounded-full overflow-hidden">
                  <div className="h-full bg-sb-blue rounded-full transition-all" style={{ width: progressPct + '%' }} />
                </div>
                <span className="text-xs text-sb-muted">{progressPct}%</span>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
            {log.map(entry => (
              <p key={entry.id} className={TAG_COLORS[entry.tag] ?? 'text-sb-muted'}>{entry.msg}</p>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Risultati */}
      {rows.length > 0 && (
        <>
          {/* Stats + azioni */}
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-sb-text truncate">📄 {fileName}</p>
                <p className="text-xs text-sb-muted">{rows.length} righe · {parzialiCols.length} colonne parziali · split {splitBase}m</p>
              </div>
              {savedCount !== null && (
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-3 py-1 rounded-full">
                  ✓ {savedCount} righe su Firebase
                </span>
              )}
              <button onClick={() => setLog(l => l.length ? [] : log)}
                className="px-3 py-2 border border-sb-sep text-xs font-medium text-sb-muted rounded-lg hover:bg-sb-bg">
                📋 Log
              </button>
              <button onClick={downloadCSV}
                className="px-4 py-2 border border-sb-sep text-sm font-medium text-sb-text rounded-lg hover:bg-sb-bg">
                ⬇ CSV
              </button>
              <button onClick={saveToFirebase} disabled={saving}
                className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                {saving ? '⏳ Salvataggio…' : '🔥 Salva su Firebase'}
              </button>
              <button onClick={() => { setRows([]); setFileName(''); setSaved(null); setLog([]) }}
                className="px-3 py-2 text-sm text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg">
                Svuota
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatChip label="Risultati" value={rows.length}   color="text-sb-blue" />
              <StatChip label="Atleti"    value={uniqueAtleti}  color="text-sb-aqua" />
              <StatChip label="Gare"      value={uniqueGare}    color="text-sb-green" />
            </div>
          </div>

          {/* Log toggle */}
          {log.length > 0 && (
            <div className="bg-sb-panel rounded-xl border border-sb-sep overflow-auto font-mono text-xs p-3 space-y-0.5" style={{ maxHeight: '180px' }}>
              {log.map(entry => (
                <p key={entry.id} className={TAG_COLORS[entry.tag] ?? 'text-sb-muted'}>{entry.msg}</p>
              ))}
            </div>
          )}

          {/* Filtri */}
          <div className="bg-sb-panel rounded-xl border border-sb-sep px-4 py-3 flex flex-wrap gap-3 items-end">
            {[['atleta','Atleta'],['gara','Gara'],['societa','Società']].map(([k, lbl]) => (
              <div key={k} className="flex-1 min-w-32">
                <label className="block text-xs text-sb-muted font-medium mb-1">{lbl}</label>
                <input value={filter[k]} onChange={e => setFilter(p => ({ ...p, [k]: e.target.value }))}
                  placeholder="Filtra…"
                  className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
              </div>
            ))}
            {Object.values(filter).some(Boolean) && (
              <button onClick={() => setFilter({ atleta: '', gara: '', societa: '' })}
                className="px-3 py-1.5 text-xs text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg">
                ✕ Reset
              </button>
            )}
            <span className="text-xs text-sb-muted ml-auto">{filtered.length}/{rows.length}</span>
          </div>

          {/* Tabella */}
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-auto" style={{ maxHeight: '460px' }}>
            <table className="w-full text-xs min-w-max">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-sb-sep bg-sb-bg">
                  {keyCols.map(c => (
                    <th key={c} className="px-3 py-2 text-left font-semibold text-sb-muted whitespace-nowrap uppercase tracking-wide">{c}</th>
                  ))}
                  {parzialiCols.map(c => (
                    <th key={c} className="px-2 py-2 text-center font-semibold text-sb-aqua whitespace-nowrap">
                      {c.replace('parziale_', '')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r, i) => (
                  <tr key={i} className={'border-b border-sb-sep/50 ' + (i % 2 === 0 ? 'bg-white' : 'bg-sb-panel')}>
                    {keyCols.map(c => (
                      <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                        {c === 'posizione'   ? <span className="font-bold text-sb-blue">{r[c]}</span>
                        : c === 'tempo_finale' ? <span className="font-mono font-semibold text-sb-text">{r[c]}</span>
                        : c === 'atleta'      ? <span className="font-medium text-sb-text">{r[c]}</span>
                        : c === 'gara'        ? <span className="text-xs font-bold bg-sb-bg px-2 py-0.5 rounded text-sb-blue">{r[c]}</span>
                        : <span className="text-sb-muted">{r[c] || '—'}</span>}
                      </td>
                    ))}
                    {parzialiCols.map(c => (
                      <td key={c} className="px-2 py-1.5 text-center whitespace-nowrap">
                        {r[c]
                          ? <span className="font-mono text-sb-text">{r[c]}</span>
                          : <span className="text-sb-sep">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
                {filtered.length > 500 && (
                  <tr><td colSpan={keyCols.length + parzialiCols.length}
                    className="px-3 py-3 text-center text-xs text-sb-muted">
                    Mostrate 500/{filtered.length} — usa i filtri
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
