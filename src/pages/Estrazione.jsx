import { useState, useRef, useCallback } from 'react'
import { db } from '../lib/firebase'
import { collection, doc, writeBatch, getDocs } from 'firebase/firestore'

const COLS_BASE = ['fonte_pdf', 'gara', 'sesso', 'data_gara', 'fase', 'posizione', 'atleta', 'societa', 'tempo_finale']

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const sep = lines[0].includes(';') ? ';' : ','
  const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g, '').trim())
  return lines.slice(1).map(line => {
    const vals = line.split(sep).map(v => v.replace(/^"|"$/g, '').trim())
    const row = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  }).filter(r => r.atleta || r.gara)
}

function StatChip({ label, value, color = 'text-sb-blue' }) {
  return (
    <div className="bg-sb-bg rounded-xl px-4 py-3 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-sb-muted mt-0.5">{label}</p>
    </div>
  )
}

export default function Estrazione() {
  const [rows, setRows]             = useState([])
  const [fileName, setFileName]     = useState('')
  const [filter, setFilter]         = useState({ atleta: '', gara: '', societa: '', fase: '' })
  const [saving, setSaving]         = useState(false)
  const [savedCount, setSavedCount] = useState(null)
  const [dragging, setDragging]     = useState(false)
  const [stagione, setStagione]     = useState('2025/2026')
  const fileRef = useRef()

  function loadFile(file) {
    if (!file) return
    setFileName(file.name)
    setSavedCount(null)
    const reader = new FileReader()
    reader.onload = e => setRows(parseCSV(e.target.result))
    reader.readAsText(file, 'utf-8')
  }

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.name.endsWith('.csv')) loadFile(file)
  }, [])

  const filtered = rows.filter(r => {
    const a = filter.atleta.toLowerCase()
    const g = filter.gara.toLowerCase()
    const s = filter.societa.toLowerCase()
    const f = filter.fase.toLowerCase()
    return (!a || r.atleta?.toLowerCase().includes(a))
        && (!g || r.gara?.toLowerCase().includes(g))
        && (!s || r.societa?.toLowerCase().includes(s))
        && (!f || r.fase?.toLowerCase().includes(f))
  })

  const uniqueAtleti  = [...new Set(rows.map(r => r.atleta).filter(Boolean))].length
  const uniqueGare    = [...new Set(rows.map(r => r.gara).filter(Boolean))].length
  const uniqueSocieta = [...new Set(rows.map(r => r.societa).filter(Boolean))].length
  const nFinali       = rows.filter(r => /finale/i.test(r.fase)).length

  const visibleCols = rows.length > 0
    ? Object.keys(rows[0]).filter(c => COLS_BASE.includes(c))
    : COLS_BASE

  async function saveToFirebase() {
    if (!rows.length) return
    setSaving(true)
    try {
      const colRef = collection(db, 'risultati', stagione, 'righe')
      // Cancella dati precedenti
      const snap = await getDocs(colRef)
      let delBatch = writeBatch(db); let dc = 0
      for (const d of snap.docs) {
        delBatch.delete(d.ref); dc++
        if (dc === 400) { await delBatch.commit(); delBatch = writeBatch(db); dc = 0 }
      }
      if (dc > 0) await delBatch.commit()
      // Scrivi nuovi dati
      let wb = writeBatch(db); let wc = 0
      for (const row of rows) {
        wb.set(doc(colRef), { ...row, _stagione: stagione })
        wc++
        if (wc === 400) { await wb.commit(); wb = writeBatch(db); wc = 0 }
      }
      if (wc > 0) await wb.commit()
      setSavedCount(rows.length)
    } catch (e) {
      alert('Errore Firebase: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 flex flex-col" style={{ minHeight: 0 }}>

      {/* Header */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua" />
        <div className="px-5 py-4 flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-sb-text mb-0.5">Carica CSV estratto</p>
            <p className="text-xs text-sb-muted">
              File <code className="bg-sb-bg px-1 rounded">*_superba.csv</code> generato dall'app Python
            </p>
          </div>
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Stagione</label>
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {['2025/2026','2024/2025','2023/2024','2026/2027'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={() => fileRef.current?.click()}
            className="px-5 py-2 bg-sb-blue text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors">
            📂 Scegli file CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden"
            onChange={e => loadFile(e.target.files[0])} />
        </div>
      </div>

      {/* Drop zone vuota */}
      {rows.length === 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed cursor-pointer transition-all py-20
            ${dragging ? 'border-sb-blue bg-blue-50' : 'border-sb-sep bg-sb-panel hover:border-sb-blue/50'}`}
        >
          <p className="text-4xl mb-3 opacity-30">📄</p>
          <p className="text-sb-muted font-medium text-sm">Trascina il CSV qui oppure clicca per sceglierlo</p>
          <p className="text-sb-muted text-xs mt-1">Formato: <code>*_superba.csv</code> con delimitatore <code>;</code></p>
        </div>
      )}

      {/* Dati caricati */}
      {rows.length > 0 && (
        <>
          {/* Stats + azioni */}
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm px-5 py-4">
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-sb-text truncate">📄 {fileName}</p>
                <p className="text-xs text-sb-muted">{rows.length} righe caricate</p>
              </div>
              {savedCount !== null && (
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-3 py-1 rounded-full">
                  ✓ {savedCount} righe salvate su Firebase
                </span>
              )}
              <button onClick={saveToFirebase} disabled={saving}
                className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
                {saving ? '⏳ Salvataggio…' : '🔥 Salva su Firebase'}
              </button>
              <button onClick={() => { setRows([]); setFileName(''); setSavedCount(null) }}
                className="px-3 py-2 text-sm text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg">
                Svuota
              </button>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <StatChip label="Atleti unici"   value={uniqueAtleti}  color="text-sb-blue" />
              <StatChip label="Gare"           value={uniqueGare}    color="text-sb-aqua" />
              <StatChip label="Società"        value={uniqueSocieta} color="text-sb-muted" />
              <StatChip label="Righe finali"   value={nFinali}       color="text-sb-green" />
            </div>
          </div>

          {/* Filtri */}
          <div className="bg-sb-panel rounded-xl border border-sb-sep px-4 py-3 flex flex-wrap gap-3 items-end">
            {[['atleta','Atleta'],['gara','Gara'],['societa','Società'],['fase','Fase']].map(([k, lbl]) => (
              <div key={k} className="flex-1 min-w-32">
                <label className="block text-xs text-sb-muted font-medium mb-1">{lbl}</label>
                <input value={filter[k]} onChange={e => setFilter(p => ({ ...p, [k]: e.target.value }))}
                  placeholder={`Filtra…`}
                  className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
              </div>
            ))}
            {Object.values(filter).some(Boolean) && (
              <button onClick={() => setFilter({ atleta: '', gara: '', societa: '', fase: '' })}
                className="px-3 py-1.5 text-xs text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg whitespace-nowrap">
                ✕ Reset
              </button>
            )}
            <span className="text-xs text-sb-muted ml-auto whitespace-nowrap">
              {filtered.length} / {rows.length} righe
            </span>
          </div>

          {/* Tabella */}
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-auto" style={{ maxHeight: '420px' }}>
            <table className="w-full text-sm min-w-max">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-sb-sep bg-sb-bg">
                  {visibleCols.map(c => (
                    <th key={c} className="px-3 py-2 text-left text-xs font-semibold text-sb-muted whitespace-nowrap uppercase tracking-wide">
                      {c.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r, i) => (
                  <tr key={i} className={`border-b border-sb-sep/50 ${i % 2 === 0 ? 'bg-white' : 'bg-sb-panel'}`}>
                    {visibleCols.map(c => (
                      <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                        {c === 'posizione'    ? <span className="font-bold text-sb-blue">{r[c]}</span>
                        : c === 'tempo_finale' ? <span className="font-mono font-semibold text-sb-text">{r[c]}</span>
                        : c === 'atleta'       ? <span className="font-medium text-sb-text">{r[c]}</span>
                        : c === 'gara'         ? <span className="text-xs font-bold bg-sb-bg px-2 py-0.5 rounded text-sb-blue">{r[c]}</span>
                        : <span className="text-sb-muted">{r[c] || '—'}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
                {filtered.length > 500 && (
                  <tr>
                    <td colSpan={visibleCols.length} className="px-3 py-3 text-center text-xs text-sb-muted">
                      Mostrate 500 di {filtered.length} righe — usa i filtri per restringere
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
