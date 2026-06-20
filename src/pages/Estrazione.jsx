import { useState, useRef, useCallback } from 'react'
import { extractPDF }    from '../lib/pdfExtractor'
import { extractPDFFIN, detectFormat } from '../lib/pdfExtractorFIN'
import { db } from '../lib/firebase'
import { collection, doc, writeBatch, getDocs } from 'firebase/firestore'

const COLS_KEY_FICR = ['gara', 'sesso', 'data_gara', 'posizione', 'atleta', 'societa', 'tempo_finale']
const COLS_KEY_FIN  = ['gara', 'sesso', 'categoria', 'anno', 'posizione', 'stato', 'atleta', 'societa', 'tempo_finale']

const isParziale = c => /^\d+m$/.test(String(c || ''))
const SPLIT_COLS  = Array.from({ length: 30 }, (_, i) => ((i + 1) * 50) + 'm')

const COL_MAP = {
  data_gara:    'DATA',
  sesso:        'SESSO',
  gara:         'GARA',
  posizione:    'POS.T',
  atleta:       'ATLETA/SQUADRA',
  societa:      'SOCIETA',
  tempo_finale: 'TEMPO',
}

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
  const inv = Object.fromEntries(Object.entries(COL_MAP).map(([k, v]) => [v, k]))
  const lines = rows.map(r =>
    TEMPLATE_COLS.map(col => {
      const key = inv[col] || col
      return esc(r[key] ?? '')
    }).join(';')
  )
  return [TEMPLATE_COLS.join(';'), ...lines].join('\n')
}

// ── Componenti UI ─────────────────────────────────────────────────────────────

function StatChip({ label, value, color = 'text-sb-blue', onClick, subtitle }) {
  const base  = 'bg-sb-bg rounded-xl px-4 py-3 text-center min-w-20'
  const extra = onClick ? ' cursor-pointer hover:ring-2 hover:ring-sb-aqua transition-all select-none' : ''
  return (
    <div className={base + extra} onClick={onClick}>
      <p className={'text-2xl font-bold ' + color}>{value}</p>
      <p className="text-xs text-sb-muted mt-0.5">{label}</p>
      {subtitle && <p className="text-[10px] text-sb-aqua mt-0.5">{subtitle}</p>}
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

function FormatBadge({ format }) {
  if (!format) return null
  const isFinFormat = format === 'FIN'
  return (
    <span className={
      'inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full ' +
      (isFinFormat
        ? 'bg-orange-100 text-orange-700 border border-orange-200'
        : 'bg-blue-100 text-blue-700 border border-blue-200')
    }>
      {isFinFormat ? '🏊 FIN' : '⚓ genovagare.it'}
    </span>
  )
}

function AtletiModal({ rows, onClose }) {
  const atletiMF = rows.reduce((acc, r) => {
    if (!r.atleta) return acc
    const s = r.sesso || '?'
    if (!acc[s]) acc[s] = new Set()
    acc[s].add(r.atleta)
    return acc
  }, {})

  const gruppi = ['M', 'F', '?'].map(s => ({
    sesso: s,
    label: s === 'M' ? '♂ Maschile' : s === 'F' ? '♀ Femminile' : '? Sconosciuto',
    lista: [...(atletiMF[s] || new Set())].sort(),
  })).filter(g => g.lista.length > 0)

  const totale = gruppi.reduce((n, g) => n + g.lista.length, 0)

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-sb-sep">
          <div>
            <p className="font-bold text-sb-text text-base">Atleti estratti</p>
            <p className="text-xs text-sb-muted mt-0.5">{totale} atleti unici</p>
          </div>
          <button onClick={onClose} className="text-sb-muted hover:text-sb-text text-xl leading-none px-2">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {gruppi.map(({ sesso, label, lista }) => (
              <div key={sesso}>
                <p className="text-xs font-bold text-sb-muted uppercase tracking-wider mb-2 flex items-center gap-2">
                  {label}
                  <span className="bg-sb-bg text-sb-aqua font-bold rounded-full px-2 py-0.5 text-[10px]">{lista.length}</span>
                </p>
                <ul className="space-y-0">
                  {lista.map(a => (
                    <li key={a} className="text-sm text-sb-text py-1 border-b border-sb-sep/40 last:border-0">{a}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Pagina principale ─────────────────────────────────────────────────────────

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
  const [showAtletiModal, setShowAtletiModal] = useState(false)
  const [showLog, setShowLog]   = useState(false)
  const [format, setFormat]     = useState(null)   // 'FIN' | 'FICR' | null

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
    setFormat(null)
    setFileName(file.name)

    try {
      const buf = await file.arrayBuffer()

      // ── Auto-detect formato ──────────────────────────────────────────────
      addLog('Rilevamento formato PDF…')
      const fmt = await detectFormat(buf)
      setFormat(fmt)
      addLog(
        fmt === 'FIN'
          ? '✓ Formato rilevato: FIN (gare regionali)'
          : '✓ Formato rilevato: FICR (genovagare.it)',
        'ok'
      )

      // ── Estrazione ──────────────────────────────────────────────────────
      let extracted = []

      if (fmt === 'FIN') {
        extracted = await extractPDFFIN({
          arrayBuffer:  buf,
          filename:     file.name,
          filterClub:   'SUPERBA NUOTO',
          onLog: msg => {
            const tag = msg.startsWith('✓') ? 'ok'
                      : msg.startsWith('▶') ? 'head'
                      : 'info'
            addLog(msg, tag)
          },
          onProgress: (p, tot) => setProgress({ cur: p, tot }),
        })
      } else {
        extracted = await extractPDF({
          arrayBuffer:  buf,
          filename:     file.name,
          splitBase:    Number(splitBase),
          maxParziali:  30,
          onLog: msg => {
            const tag = msg.startsWith('✓') ? 'ok'
                      : msg.startsWith('▶') ? 'head'
                      : msg.toLowerCase().includes('gara:') ? 'info'
                      : 'info'
            addLog(msg, tag)
          },
          onProgress: (p, tot) => setProgress({ cur: p, tot }),
        })
      }

      if (extracted.length === 0) {
        addLog(
          fmt === 'FIN'
            ? 'Nessun risultato Superba Nuoto trovato. Verifica che il PDF contenga gare FIN regionali.'
            : 'Nessun risultato estratto. Verifica che il PDF contenga "Superba Nuoto" come testo selezionabile.',
          'warn'
        )
      }

      setRows(extracted)
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

  // Colonne chiave dipendenti dal formato
  const COLS_KEY = format === 'FIN' ? COLS_KEY_FIN : COLS_KEY_FICR

  const parzialiCols = headers.filter(isParziale).sort((a, b) => parseInt(a) - parseInt(b))
  const keyCols      = COLS_KEY.filter(c => headers.includes(c))

  const filtered = rows.filter(r => {
    const a = filter.atleta.toLowerCase()
    const g = filter.gara.toLowerCase()
    const s = filter.societa.toLowerCase()
    return (!a || (r.atleta  || '').toLowerCase().includes(a))
        && (!g || (r.gara    || '').toLowerCase().includes(g))
        && (!s || (r.societa || '').toLowerCase().includes(s))
  })

  const uniqueAtleti = [...new Set(rows.map(r => r.atleta).filter(Boolean))].length
  const uniqueGare   = [...new Set(rows.map(r => r.gara).filter(Boolean))].length
  const atletiM = [...new Set(rows.filter(r => r.sesso === 'M').map(r => r.atleta).filter(Boolean))].length
  const atletiF = [...new Set(rows.filter(r => r.sesso === 'F').map(r => r.atleta).filter(Boolean))].length

  async function saveToFirebase() {
    if (!rows.length) return
    setSaving(true)
    try {
      const colRef = collection(db, 'risultati', stagione.replace(/\//g, '-'), 'righe')
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
    const a   = document.createElement('a')
    a.href    = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName.replace(/\.pdf$/i, '') + '_superba.csv'
    a.click(); URL.revokeObjectURL(a.href)
  }

  const progressPct = progress.tot > 0 ? Math.round((progress.cur / progress.tot) * 100) : 0

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      {/* Header opzioni */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-aqua" />
        <div className="px-5 py-4 flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-sm font-bold text-sb-text">Estrazione da PDF</p>
              <FormatBadge format={format} />
            </div>
            <p className="text-xs text-sb-muted">
              {format === 'FIN'
                ? 'PDF risultati FIN (gare regionali) — estrae i risultati di Superba Nuoto'
                : 'Carica il PDF scaricato da genovagare.it oppure un PDF FIN — formato rilevato automaticamente'}
            </p>
          </div>

          {/* Stagione */}
          <div>
            <label className="block text-xs text-sb-muted font-medium mb-1">Stagione</label>
            <select value={stagione} onChange={e => setStagione(e.target.value)}
              className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
              {['2026/2027','2025/2026','2024/2025','2023/2024'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          {/* Parziali — solo FICR */}
          {format !== 'FIN' && (
            <div>
              <label className="block text-xs text-sb-muted font-medium mb-1">Parziali ogni</label>
              <select value={splitBase} onChange={e => setSplitBase(Number(e.target.value))}
                className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
                <option value={50}>50 m</option>
                <option value={25}>25 m</option>
              </select>
            </div>
          )}

          <button onClick={() => fileRef.current?.click()} disabled={extracting}
            className="px-5 py-2 bg-sb-blue text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50">
            {extracting ? '⏳ Estrazione…' : '📂 Scegli PDF'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf" className="hidden"
            onChange={e => loadFile(e.target.files[0])} />
        </div>
      </div>

      {/* Drop zone */}
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
          <p className="text-sb-muted text-xs mt-1">
            Supporta PDF <strong>FIN</strong> (gare regionali) e <strong>genovagare.it</strong> — formato rilevato automaticamente
          </p>
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
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-sb-text truncate">📄 {fileName}</p>
                  <FormatBadge format={format} />
                </div>
                <p className="text-xs text-sb-muted">
                  {rows.length} righe · {parzialiCols.length} colonne parziali
                  {format !== 'FIN' && ` · split ${splitBase}m`}
                </p>
              </div>
              {savedCount !== null && (
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-3 py-1 rounded-full">
                  ✓ {savedCount} righe su Firebase
                </span>
              )}
              <button onClick={() => setShowLog(v => !v)}
                className={'px-3 py-2 border border-sb-sep text-xs font-medium rounded-lg hover:bg-sb-bg ' + (showLog ? 'text-sb-blue border-sb-blue' : 'text-sb-muted')}>
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
              <button onClick={() => { setRows([]); setFileName(''); setSaved(null); setLog([]); setFormat(null) }}
                className="px-3 py-2 text-sm text-sb-muted border border-sb-sep rounded-lg hover:bg-sb-bg">
                Svuota
              </button>
            </div>

            {/* Breakdown per gara */}
            {(() => {
              const byGara = {}
              rows.forEach(r => { byGara[r.gara] = (byGara[r.gara] || 0) + 1 })
              const sorted = Object.keys(byGara).sort()
              if (!sorted.length) return null
              return (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {sorted.map(g => (
                    <span key={g} className="text-[11px] font-mono bg-sb-bg border border-sb-sep rounded px-2 py-0.5 text-sb-text">
                      <span className="font-bold text-sb-blue">{g}</span>
                      <span className="text-sb-muted ml-1">{byGara[g]}</span>
                    </span>
                  ))}
                </div>
              )
            })()}

            <div className="grid grid-cols-3 gap-3">
              <StatChip label="Risultati" value={rows.length}    color="text-sb-blue" />
              <StatChip label="Atleti"    value={uniqueAtleti}   color="text-sb-aqua"
                subtitle={atletiM && atletiF ? `♂ ${atletiM}  ♀ ${atletiF}` : undefined}
                onClick={() => setShowAtletiModal(true)} />
              <StatChip label="Gare"      value={uniqueGare}     color="text-sb-green" />
            </div>
          </div>

          {/* Log toggle */}
          {showLog && log.length > 0 && (
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
                    <th key={c} className="px-2 py-2 text-center font-semibold text-sb-aqua whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r, i) => (
                  <tr key={i} className={'border-b border-sb-sep/50 ' + (i % 2 === 0 ? 'bg-white' : 'bg-sb-panel')}>
                    {keyCols.map(c => (
                      <td key={c} className="px-3 py-1.5 whitespace-nowrap">
                        {c === 'posizione'    ? <span className="font-bold text-sb-blue">{r[c]}</span>
                        : c === 'tempo_finale' ? <span className="font-mono font-semibold text-sb-text">{r[c]}</span>
                        : c === 'atleta'      ? <span className="font-medium text-sb-text">{r[c]}</span>
                        : c === 'gara'        ? <span className="text-xs font-bold bg-sb-bg px-2 py-0.5 rounded text-sb-blue">{r[c]}</span>
                        : c === 'stato'       ? (r[c]
                            ? <span className={'text-xs font-bold px-1.5 py-0.5 rounded ' + (r[c] === 'SQ' ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-700')}>{r[c]}</span>
                            : <span className="text-sb-sep">·</span>)
                        : c === 'categoria'   ? <span className="font-mono text-sb-text">{r[c]}</span>
                        : c === 'anno'        ? <span className="font-mono text-sb-muted">{r[c]}</span>
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
                  <tr>
                    <td colSpan={keyCols.length + parzialiCols.length}
                      className="px-3 py-3 text-center text-xs text-sb-muted">
                      Mostrate 500/{filtered.length} — usa i filtri
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Modal atleti */}
      {showAtletiModal && (
        <AtletiModal rows={rows} onClose={() => setShowAtletiModal(false)} />
      )}
    </div>
  )
}
