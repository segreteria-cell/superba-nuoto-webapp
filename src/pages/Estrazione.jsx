import { useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { db } from '../lib/firebase'
import { collection, doc, writeBatch, getDocs } from 'firebase/firestore'

// Colonne chiave sempre visibili
const COLS_KEY = ['DATA','GARA','SESSO','POS.T','ATLETA/SQUADRA','ANNO','SOCIETA','TEMPO']
// Colonne parziali: finiscono in 'm'
const isParziale = c => /^\d+m$/.test(String(c||''))

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellText: true, raw: false })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
        resolve(rows)
      } catch(err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

function rowsToCSV(rows) {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const esc = v => `"${String(v??'').replace(/"/g,'""')}"`
  return [keys.join(';'), ...rows.map(r => keys.map(k => esc(r[k])).join(';'))].join('\n')
}

function StatChip({ label, value, color = 'text-sb-blue' }) {
  return (
    <div className="bg-sb-bg rounded-xl px-4 py-3 text-center min-w-20">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-sb-muted mt-0.5">{label}</p>
    </div>
  )
}

export default function Estrazione() {
  const [rows, setRows]           = useState([])
  const [headers, setHeaders]     = useState([])
  const [fileName, setFileName]   = useState('')
  const [stagione, setStagione]   = useState('2025/2026')
  const [filter, setFilter]       = useState({ atleta: '', gara: '', societa: '' })
  const [saving, setSaving]       = useState(false)
  const [savedCount, setSaved]    = useState(null)
  const [dragging, setDragging]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const fileRef = useRef()

  async function loadFile(file) {
    if (!file) return
    setLoading(true)
    setSaved(null)
    try {
      const data = await readFile(file)
      setFileName(file.name)
      setRows(data)
      setHeaders(data.length ? Object.keys(data[0]) : [])
    } catch(e) {
      alert('Errore lettura file: ' + e.message)
    } finally { setLoading(false) }
  }

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }, [])

  // Colonne parziali presenti nel file
  const parzialiCols = headers.filter(isParziale)
  const keyCols      = headers.filter(h => COLS_KEY.includes(h))

  // Filtro
  const filtered = rows.filter(r => {
    const a = filter.atleta.toLowerCase()
    const g = filter.gara.toLowerCase()
    const s = filter.societa.toLowerCase()
    const atleta = String(r['ATLETA/SQUADRA'] || '').toLowerCase()
    const gara   = String(r['GARA'] || '').toLowerCase()
    const soc    = String(r['SOCIETA'] || '').toLowerCase()
    return (!a || atleta.includes(a)) && (!g || gara.includes(g)) && (!s || soc.includes(s))
  })

  const uniqueAtleti  = [...new Set(rows.map(r => r['ATLETA/SQUADRA']).filter(Boolean))].length
  const uniqueGare    = [...new Set(rows.map(r => r['GARA']).filter(Boolean))].length
  const uniqueSocieta = [...new Set(rows.map(r => r['SOCIETA']).filter(Boolean))].length

  async function saveToFirebase() {
    if (!rows.length) return
    setSaving(true)
    try {
      const colRef = collection(db, 'risultati', stagione, 'righe')
      // Cancella vecchi dati
      const snap = await getDocs(colRef)
      let del = writeBatch(db); let dc = 0
      for (const d of snap.docs) {
        del.delete(d.ref); dc++
        if (dc === 400) { await del.commit(); del = writeBatch(db); dc = 0 }
      }
      if (dc > 0) await del.commit()
      // Scrivi nuovi
      let wb = writeBatch(db); let wc = 0
      for (const row of rows) {
        wb.set(doc(colRef), { ...row, _stagione: stagione })
        wc++
        if (wc === 400) { await wb.commit(); wb = writeBatch(db); wc = 0 }
      }
      if (wc > 0) await wb.commit()
      setSaved(rows.length)
    } catch(e) { alert('Errore Firebase: ' + e.message) }
    finally { setSaving(false) }
  }

  function downloadCSV() {
    const csv = '﻿' + rowsToCSV(rows)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName.replace(/\.(xlsx|xls)$/i, '') + '_export.csv'
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      {/* Header */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua" />
        <div className="px-5 py-4 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-sb-text mb-0.5">Carica file estratto dal Python</p>
            <p className="text-xs text-sb-muted">
              File <code className="bg-sb-bg px-1 rounded">.xlsx</code> o <code className="bg-sb-bg px-1 rounded">.csv</code> prodotto dall'app locale
            </p>
          </div>
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Stagione</label>
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {['2025/2026','2024/2025','2023/2024','2026/2027'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={loading}
            className="px-5 py-2 bg-sb-blue text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
            {loading ? '⏳ Caricamento…' : '📂 Scegli file'}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => loadFile(e.target.files[0])} />
        </div>
      </div>

      {/* Drop zone */}
      {rows.length === 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed cursor-pointer transition-all py-20
            ${dragging ? 'border-sb-blue bg-blue-50' : 'border-sb-sep bg-sb-panel hover:border-sb-blue/50'}`}
        >
          <p className="text-4xl mb-3 opacity-30">📊</p>
          <p className="text-sb-muted font-medium text-sm">Trascina il file xlsx qui o clicca per sceglierlo</p>
          <p className="text-sb-muted text-xs mt-1">Output dell'app Python — contiene parziali e tutti i dati di gara</p>
        </div>
      )}

      {/* Dati */}
      {rows.length > 0 && (
        <>
          {/* Stats + azioni */}
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-sb-text truncate">📊 {fileName}</p>
                <p className="text-xs text-sb-muted">{rows.length} righe · {parzialiCols.length} colonne parziali</p>
              </div>
              {savedCount !== null && (
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-3 py-1 rounded-full">
                  ✓ {savedCount} righe su Firebase
                </span>
              )}
              <button onClick={downloadCSV}
                className="px-4 py-2 border border-sb-sep text-sm font-medium text-sb-text rounded-lg hover:bg-sb-bg">
                ⬇ CSV
              </button>
              <button onClick={saveToFirebase} disabled={saving}
                className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                {saving ? '⏳ Salvataggio…' : '🔥 Salva su Firebase'}
              </button>
              <button onClick={() => { setRows([]); setFileName(''); setSaved(null) }}
                className="px-3 py-2 text-sm text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg">
                Svuota
              </button>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <StatChip label="Righe"    value={rows.length}    color="text-sb-blue" />
              <StatChip label="Atleti"   value={uniqueAtleti}   color="text-sb-aqua" />
              <StatChip label="Gare"     value={uniqueGare}     color="text-sb-green" />
              <StatChip label="Società"  value={uniqueSocieta}  color="text-sb-muted" />
            </div>
          </div>

          {/* Filtri */}
          <div className="bg-sb-panel rounded-xl border border-sb-sep px-4 py-3 flex flex-wrap gap-3 items-end">
            {[['atleta','Atleta'],['gara','Gara'],['societa','Società']].map(([k,lbl]) => (
              <div key={k} className="flex-1 min-w-32">
                <label className="block text-xs text-sb-muted font-medium mb-1">{lbl}</label>
                <input value={filter[k]} onChange={e => setFilter(p => ({ ...p, [k]: e.target.value }))}
                  placeholder="Filtra…"
                  className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
              </div>
            ))}
            {Object.values(filter).some(Boolean) && (
              <button onClick={() => setFilter({ atleta:'', gara:'', societa:'' })}
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
                    <th key={c} className="px-2 py-2 text-center font-semibold text-sb-aqua whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r, i) => (
                  <tr key={i} className={`border-b border-sb-sep/50 ${i%2===0?'bg-white':'bg-sb-panel'}`}>
                    {keyCols.map(c => (
                      <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                        {c === 'POS.T'
                          ? <span className="font-bold text-sb-blue">{r[c]}</span>
                          : c === 'TEMPO'
                          ? <span className="font-mono font-semibold text-sb-text">{r[c]}</span>
                          : c === 'ATLETA/SQUADRA'
                          ? <span className="font-medium text-sb-text">{r[c]}</span>
                          : c === 'GARA'
                          ? <span className="text-xs font-bold bg-sb-bg px-2 py-0.5 rounded text-sb-blue">{r[c]}</span>
                          : <span className="text-sb-muted">{r[c] || '—'}</span>}
                      </td>
                    ))}
                    {parzialiCols.map(c => (
                      <td key={c} className="px-2 py-1.5 text-center whitespace-nowrap">
                        {r[c]
                          ? <span className="font-mono text-sb-text text-xs">{r[c]}</span>
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
