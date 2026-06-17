import { useState, useEffect, useCallback, useRef } from 'react'
import LZString from 'lz-string'
import { ref as rtdbRef, set as rtdbSet, get as rtdbGet, remove as rtdbRemove } from 'firebase/database'
import { extractPdfText, parseProgramma } from '../lib/parseProgramma'
import { rtdb } from '../lib/firebase'

// ── Pattern identico a Graduatorie ───────────────────────────────────────────
// - FileReader legge il PDF → base64
// - Metadati lista: LZString → RTDB path "regolamenti/meta"
// - Dati PDF:       LZString → RTDB path "regolamenti/files/<id>"
// - localStorage come cache locale

const LS_META = 'reg_meta'

// Lettura PDF come base64 (FileReader, stesso approccio di Graduatorie con xlsx)
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => {
      const bytes  = new Uint8Array(e.target.result)
      let binary   = ''
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      resolve(btoa(binary))
    }
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// RTDB: salva metadati lista — compressToBase64 = ASCII puro, sicuro per Firebase
async function cloudSaveMeta(list) {
  await rtdbSet(rtdbRef(rtdb, 'regolamenti/meta'), {
    timestamp: new Date().toISOString(),
    data: LZString.compressToBase64(JSON.stringify(list)),
  })
}

// RTDB: carica metadati lista — fallback su entrambi i metodi di compressione
async function cloudLoadMeta() {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/meta'))
  if (!snap.exists()) return []
  const val = snap.val()
  const dec = LZString.decompressFromBase64(val.data) || LZString.decompress(val.data)
  return JSON.parse(dec) || []
}

// RTDB: salva PDF — compressToBase64 produce ASCII puro, sicuro per Firebase
async function cloudSaveFile(id, base64) {
  const compressed = LZString.compressToBase64(base64)
  await rtdbSet(rtdbRef(rtdb, 'regolamenti/files/' + id), compressed)
}

// RTDB: carica PDF per visualizzazione
async function cloudLoadFile(id) {
  const snap = await rtdbGet(rtdbRef(rtdb, 'regolamenti/files/' + id))
  if (!snap.exists()) {
    console.warn('[Regolamenti] file non trovato in RTDB per id:', id)
    return null
  }
  const decompressed = LZString.decompressFromBase64(snap.val())
  console.log('[Regolamenti] decompressed length:', decompressed?.length)
  return decompressed || null
}

// RTDB: elimina PDF
async function cloudDeleteFile(id) {
  await rtdbRemove(rtdbRef(rtdb, 'regolamenti/files/' + id))
}

// localStorage (stesso helper di Classifiche/Graduatorie)
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

// ── Costanti UI ───────────────────────────────────────────────────────────────

const CATEGORIE  = ['Tutti', 'Nazionali FIN', 'Regionali', 'CSI', 'Master', 'Altro']
const CAT_COLORS = {
  'Nazionali FIN': 'bg-blue-100 text-blue-700',
  'Regionali':     'bg-purple-100 text-purple-700',
  'CSI':           'bg-green-100 text-green-700',
  'Master':        'bg-orange-100 text-orange-700',
  'Altro':         'bg-gray-100 text-gray-600',
}

function formatDate(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleDateString('it-IT') } catch { return '' }
}

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function Regolamenti() {
  const [meta,         setMeta]         = useState(() => lsGet(LS_META, []))
  const [lastUpdate,   setLastUpdate]   = useState('')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [uploading,    setUploading]    = useState(false)
  const [uploadPct,    setUploadPct]    = useState(0)
  const [catFilter,    setCatFilter]    = useState('Tutti')
  const [search,       setSearch]       = useState('')
  const [viewer,       setViewer]       = useState(null)   // { id, nome, base64 }
  const [viewLoading,  setViewLoading]  = useState(false)
  const [programma,    setProgramma]    = useState(null)   // { id, nome, giorni }
  const [progLoading,  setProgLoading]  = useState(null)   // id in caricamento
  const [progGiornata, setProgGiornata] = useState(0)      // indice giornata attiva nel popup
  const [deleting,     setDeleting]     = useState(null)
  const [error,        setError]        = useState('')

  // Form
  const [nome,      setNome]      = useState('')
  const [categoria, setCategoria] = useState('Nazionali FIN')
  const [note,      setNote]      = useState('')
  const [file,      setFile]      = useState(null)
  const fileRef = useRef()

  // Carica metadati da cloud al mount se cache vuota
  const handleCloudLoad = useCallback(() => {
    setCloudLoading(true); setError('')
    cloudLoadMeta()
      .then(list => {
        setMeta(list)
        lsSet(LS_META, list)
        setLastUpdate('Da cloud · ' + new Date().toLocaleString('it-IT'))
      })
      .catch(e => setError('Errore Firebase: ' + e.message))
      .finally(() => setCloudLoading(false))
  }, [])

  useEffect(() => {
    if (meta.length === 0) handleCloudLoad()
    else setLastUpdate('Da cache locale')
  }, []) // eslint-disable-line

  // Upload PDF: legge file → base64 → RTDB
  async function handleUpload() {
    if (!nome.trim()) { setError('Inserisci un nome.'); return }
    if (!file)        { setError('Seleziona un file PDF.'); return }
    if (file.type !== 'application/pdf') { setError('Il file deve essere un PDF.'); return }

    setError(''); setUploading(true); setUploadPct(10)
    try {
      // 1. Leggi PDF come base64 (FileReader)
      setUploadPct(20)
      const base64 = await readFileAsBase64(file)

      // 2. Genera ID e metadato
      const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const item = { id, nome: nome.trim(), categoria, note: note.trim(), size: file.size, caricato: new Date().toISOString() }

      // 3. Salva PDF su RTDB (base64 compresso)
      setUploadPct(50)
      await cloudSaveFile(id, base64)

      // 4. Aggiorna lista metadati
      setUploadPct(80)
      const updated = [item, ...meta]
      await cloudSaveMeta(updated)

      // 5. Aggiorna stato locale
      setMeta(updated)
      lsSet(LS_META, updated)
      setLastUpdate('Caricato · ' + new Date().toLocaleString('it-IT'))
      setNome(''); setNote(''); setFile(null); setCategoria('Nazionali FIN')
      if (fileRef.current) fileRef.current.value = ''
    } catch (e) {
      setError('Errore upload: ' + e.message)
    } finally {
      setUploading(false); setUploadPct(0)
    }
  }

  // Visualizza PDF: scarica base64 da RTDB on-demand
  async function handleView(item) {
    if (viewer?.id === item.id) { setViewer(null); return }
    setViewLoading(true); setError('')
    try {
      const base64 = await cloudLoadFile(item.id)
      if (!base64) { setError('File non trovato: elimina questo documento e ricarica il PDF con il pulsante ⬆ Carica PDF.'); return }
      setViewer({ id: item.id, nome: item.nome, base64 })
    } catch (e) {
      setError('Errore caricamento PDF: ' + e.message)
    } finally {
      setViewLoading(false)
    }
  }

  // Visualizza programma gare: parsa il PDF e mostra il risultato
  async function handleViewProgramma(item, e) {
    e.stopPropagation()
    if (programma?.id === item.id) { setProgramma(null); return }
    setProgLoading(item.id); setError('')
    try {
      const base64 = await cloudLoadFile(item.id)
      if (!base64) { setError('File non trovato.'); return }
      const text   = await extractPdfText(base64)
      const giorni = parseProgramma(text)
      setProgramma({ id: item.id, nome: item.nome, giorni }); setProgGiornata(0)
    } catch (e) {
      setError('Errore parsing: ' + e.message)
    } finally {
      setProgLoading(null)
    }
  }

  // Elimina: rimuove da RTDB (file + meta) e localStorage
  async function handleDelete(item) {
    if (!confirm('Eliminare "' + item.nome + '"?')) return
    setDeleting(item.id)
    try {
      await cloudDeleteFile(item.id)
      const updated = meta.filter(d => d.id !== item.id)
      await cloudSaveMeta(updated)
      setMeta(updated)
      lsSet(LS_META, updated)
      if (viewer?.id === item.id) setViewer(null)
      setLastUpdate('Eliminato · ' + new Date().toLocaleString('it-IT'))
    } catch (e) {
      setError('Errore eliminazione: ' + e.message)
    } finally {
      setDeleting(null)
    }
  }

  const filtered = meta.filter(d => {
    const matchCat    = catFilter === 'Tutti' || d.categoria === catFilter
    const q           = search.toLowerCase()
    const matchSearch = !q || d.nome.toLowerCase().includes(q) || (d.note || '').toLowerCase().includes(q)
    return matchCat && matchSearch
  })

  return (
    <>
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      {/* Form caricamento PDF */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-green" />
        <div className="px-5 py-4">
          <p className="text-sm font-bold text-sb-text mb-3">Carica Regolamento PDF</p>
          <div className="flex flex-wrap gap-3 items-end">

            <div className="flex-1 min-w-44">
              <label className="block text-xs text-sb-muted font-medium mb-1">Nome</label>
              <input value={nome} onChange={e => setNome(e.target.value)}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                placeholder="Es. Regolamento Campionati 2025" />
            </div>

            <div>
              <label className="block text-xs text-sb-muted font-medium mb-1">Categoria</label>
              <select value={categoria} onChange={e => setCategoria(e.target.value)}
                className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
                {CATEGORIE.filter(c => c !== 'Tutti').map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            <div className="flex-1 min-w-32">
              <label className="block text-xs text-sb-muted font-medium mb-1">Note (opzionale)</label>
              <input value={note} onChange={e => setNote(e.target.value)}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                placeholder="Es. tempi limite, criteri..." />
            </div>

            <div className="flex-1 min-w-48">
              <label className="block text-xs text-sb-muted font-medium mb-1">File PDF</label>
              <input ref={fileRef} type="file" accept="application/pdf"
                onChange={e => { setFile(e.target.files[0] || null); setError('') }}
                className="w-full border border-sb-sep rounded-lg px-3 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue
                  file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-sb-blue file:text-white file:cursor-pointer" />
              {file && <p className="text-xs text-sb-muted mt-0.5">{file.name} · {formatSize(file.size)}</p>}
            </div>

            <button onClick={handleUpload} disabled={uploading}
              className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 whitespace-nowrap">
              {uploading ? `Caricamento ${uploadPct}%` : '⬆ Carica PDF'}
            </button>
          </div>

          {/* Barra progresso */}
          {uploading && (
            <div className="mt-3 h-1.5 bg-sb-sep rounded-full overflow-hidden">
              <div className="h-full bg-sb-green transition-all duration-300 rounded-full"
                style={{ width: uploadPct + '%' }} />
            </div>
          )}

          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      </div>

      {/* Filtri + stato cloud */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm px-5 py-3 flex flex-wrap gap-3 items-center">
        <div className="flex gap-1.5 flex-wrap">
          {CATEGORIE.map(c => (
            <button key={c} onClick={() => setCatFilter(c)}
              className={
                'px-3 py-1 rounded-full text-xs font-medium transition-colors ' +
                (catFilter === c ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep')
              }>{c}</button>
          ))}
        </div>
        <div className="flex-1 min-w-40">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Cerca per nome o note..."
            className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
        </div>
        <div className="flex items-center gap-3 text-xs text-sb-muted">
          {lastUpdate && <span>{lastUpdate}</span>}
          <button onClick={handleCloudLoad} disabled={cloudLoading}
            className="text-sb-blue hover:underline disabled:opacity-50 font-medium">
            {cloudLoading ? '⏳' : '☁'} Da cloud
          </button>
          <span>{filtered.length} doc</span>
        </div>
      </div>

      <div className="flex gap-3" style={{ minHeight: 0, flex: 1 }}>

        {/* Lista */}
        <div className="flex flex-col gap-2" style={{ width: viewer ? '380px' : '100%', flexShrink: 0 }}>
          {filtered.length === 0 ? (
            <div className="bg-sb-panel rounded-2xl border border-sb-sep p-8 text-center">
              <p className="text-sb-muted text-sm">
                {meta.length === 0
                  ? '📂 Carica il primo regolamento PDF usando il form sopra'
                  : 'Nessun risultato per i filtri selezionati.'}
              </p>
            </div>
          ) : filtered.map(item => (
            <div key={item.id}
              className={
                'bg-sb-panel rounded-2xl border shadow-sm px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ' +
                (viewer?.id === item.id ? 'border-sb-blue bg-blue-50/30' : 'border-sb-sep hover:border-sb-blue')
              }
              onClick={() => handleView(item)}>

              <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-red-500">PDF</span>
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-sb-text truncate">{item.nome}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (CAT_COLORS[item.categoria] || 'bg-gray-100 text-gray-600')}>
                    {item.categoria}
                  </span>
                  <span className="text-xs text-sb-muted">{formatDate(item.caricato)}</span>
                  {item.size && <span className="text-xs text-sb-muted">{formatSize(item.size)}</span>}
                </div>
                {item.note && <p className="text-xs text-sb-muted mt-0.5 truncate">{item.note}</p>}
              </div>

              <div className="flex gap-1 items-center">
                {viewLoading && viewer === null && (
                  <span className="text-xs text-sb-muted">⏳</span>
                )}
                <button onClick={e => handleViewProgramma(item, e)}
                  disabled={progLoading === item.id}
                  className={'px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 ' +
                    (programma?.id === item.id
                      ? 'bg-sb-blue text-white'
                      : 'text-sb-blue hover:bg-blue-50')}>
                  {progLoading === item.id ? '⏳' : 'Programma'}
                </button>
                <button onClick={e => { e.stopPropagation(); handleDelete(item) }}
                  disabled={deleting === item.id}
                  className="px-2 py-1.5 rounded-lg text-xs text-sb-muted hover:text-red-500 hover:bg-red-50 disabled:opacity-40">
                  {deleting === item.id ? '...' : 'Elimina'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Viewer PDF */}
        {viewer && (
          <div className="flex-1 bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden flex flex-col" style={{ minHeight: '500px' }}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-sb-sep">
              <p className="text-sm font-semibold text-sb-text truncate">{viewer.nome}</p>
              <button onClick={() => setViewer(null)} className="text-sb-muted hover:text-sb-text text-xl leading-none px-1">×</button>
            </div>
            <iframe
              src={'data:application/pdf;base64,' + viewer.base64}
              className="flex-1 w-full"
              title={viewer.nome}
              style={{ minHeight: '480px' }} />
          </div>
        )}

        {/* Loading viewer */}
        {viewLoading && !viewer && (
          <div className="flex-1 bg-sb-panel rounded-2xl border border-sb-sep flex items-center justify-center" style={{ minHeight: '200px' }}>
            <p className="text-sb-muted text-sm">⏳ Caricamento PDF...</p>
          </div>
        )}
      </div>

    </div>

      {/* Modal Programma Gare */}
      {programma && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setProgramma(null)}>
          <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-xl flex flex-col"
            style={{ width: '100%', maxWidth: '680px', maxHeight: '80vh' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-sb-sep flex-shrink-0">
              <div>
                <p className="text-sm font-semibold text-sb-text">{programma.nome}</p>
                <p className="text-xs text-sb-muted mt-0.5">
                  {programma.giorni.length} giornate &middot;{' '}
                  {programma.giorni.reduce((acc, g) => acc + g.sessioni.reduce((a, s) => a + s.gare.length, 0), 0)} gare totali
                </p>
              </div>
              <button onClick={() => setProgramma(null)}
                className="text-sb-muted hover:text-sb-text text-xl px-2 py-0.5 rounded-lg hover:bg-sb-sep transition-colors">×</button>
            </div>

            {/* Tabs giornate */}
            <div className="flex border-b border-sb-sep px-4 flex-shrink-0 overflow-x-auto gap-1">
              {programma.giorni.map((g, i) => (
                <button key={i} onClick={() => setProgGiornata(i)}
                  className={'whitespace-nowrap px-3 py-2.5 text-xs font-medium transition-colors border-b-2 ' +
                    (progGiornata === i
                      ? 'border-sb-blue text-sb-blue'
                      : 'border-transparent text-sb-muted hover:text-sb-text')}>
                  Giornata {g.giornata} — {g.data}
                </button>
              ))}
              {programma.giorni.length === 0 && (
                <span className="px-3 py-2.5 text-xs text-sb-muted">Nessuna giornata estratta</span>
              )}
            </div>

            {/* Contenuto giornata */}
            <div className="overflow-y-auto px-5 py-4 flex flex-col gap-4 flex-1">
              {programma.giorni.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-sm text-sb-muted">Il parser non ha trovato il formato atteso nel PDF.</p>
                  <p className="text-xs text-sb-muted mt-1">Righe attese: &ldquo;I giornata – 1 agosto&rdquo; e &ldquo;Batterie 100 m stile libero F J/C/S&rdquo;</p>
                </div>
              ) : programma.giorni[progGiornata]?.sessioni.map(sess => (
                <div key={sess.nome}>
                  <p className="text-xs font-semibold text-sb-muted uppercase tracking-wider mb-2">{sess.nome}</p>
                  <div className="flex flex-col gap-1.5">
                    {sess.gare.map((gara, i) => {
                      const isStaff    = typeof gara.dist === 'string' && gara.dist.includes('x')
                      const distLabel  = gara.dist + 'm'
                      const noSesso    = !gara.sesso
                      return (
                        <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-sb-bg border border-sb-sep/60">
                          {/* Badge/i sesso */}
                          <span className="flex gap-1 flex-shrink-0">
                            {(noSesso || gara.sesso === 'Female') && (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded"
                                style={{ background: '#FBEAF0', color: '#993556' }}>F</span>
                            )}
                            {(noSesso || gara.sesso === 'Male') && (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded"
                                style={{ background: '#E6F1FB', color: '#185FA5' }}>M</span>
                            )}
                          </span>
                          {/* Gara */}
                          <span className="text-sm text-sb-text flex-1">
                            {distLabel} {gara.spec}
                            {isStaff && <span className="ml-1.5 text-xs text-sb-blue font-medium">staffetta</span>}
                          </span>
                          {/* Categoria */}
                          {gara.catRaw && (
                            <span className="text-xs text-sb-muted border border-sb-sep rounded px-2 py-0.5 flex-shrink-0">
                              {gara.catRaw}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="flex justify-end px-5 py-3 border-t border-sb-sep flex-shrink-0">
              <button onClick={() => setProgramma(null)}
                className="px-4 py-1.5 text-sm rounded-lg border border-sb-sep hover:bg-sb-sep text-sb-text transition-colors">
                Chiudi
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  )
}
