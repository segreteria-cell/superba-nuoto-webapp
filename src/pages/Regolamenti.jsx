import { useState, useRef, useCallback, useEffect } from 'react'
import { db, storage } from '../lib/firebase'
import {
  collection, addDoc, getDocs, deleteDoc, doc, query, orderBy,
} from 'firebase/firestore'
import {
  ref, uploadBytesResumable, getDownloadURL, deleteObject,
} from 'firebase/storage'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

const CATEGORIE = ['Tutti', 'Nazionali FIN', 'Regionali', 'CSI', 'Master', 'Altro']

async function extractTextFromPDF(arrayBuffer) {
  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    const parts = []
    for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      parts.push(content.items.map(i => i.str).join(' '))
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 50000)
  } catch (_) { return '' }
}

function formatBytes(b) {
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('it-IT')
}

const CAT_COLORS = {
  'Nazionali FIN': 'bg-blue-100 text-blue-700',
  'Regionali':     'bg-purple-100 text-purple-700',
  'CSI':           'bg-green-100 text-green-700',
  'Master':        'bg-orange-100 text-orange-700',
  'Altro':         'bg-gray-100 text-gray-600',
}

function getSnippet(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return ''
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + query.length + 40)
  return text.slice(start, end)
}

export default function Regolamenti() {
  const [docs, setDocs]             = useState([])
  const [loading, setLoading]       = useState(true)
  const [uploading, setUploading]   = useState(false)
  const [progress, setProgress]     = useState(0)
  const [dragging, setDragging]     = useState(false)
  const [catFilter, setCatFilter]   = useState('Tutti')
  const [search, setSearch]         = useState('')
  const [viewer, setViewer]         = useState(null)
  const [deleting, setDeleting]     = useState(null)
  const [uploadForm, setUploadForm] = useState({ nome: '', categoria: 'Nazionali FIN' })
  const [pendingFile, setPendingFile] = useState(null)
  const [error, setError]           = useState('')
  const fileRef = useRef()

  async function fetchDocs() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'regolamenti'), orderBy('caricato', 'desc')))
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch (e) { setError('Errore caricamento: ' + e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchDocs() }, [])

  function handleFileSelect(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Seleziona un file PDF.'); return
    }
    setError('')
    setPendingFile(file)
    setUploadForm(f => ({ ...f, nome: file.name.replace(/\.pdf$/i, '') }))
  }

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false)
    handleFileSelect(e.dataTransfer.files[0])
  }, [])

  async function handleUpload() {
    if (!pendingFile) return
    if (!uploadForm.nome.trim()) { setError('Inserisci un nome.'); return }
    setUploading(true); setProgress(0); setError('')
    try {
      const buf = await pendingFile.arrayBuffer()
      const testo = await extractTextFromPDF(buf.slice(0))
      const storageRef = ref(storage, 'regolamenti/' + Date.now() + '_' + pendingFile.name)
      await new Promise((resolve, reject) => {
        const task = uploadBytesResumable(storageRef, pendingFile, { contentType: 'application/pdf' })
        task.on('state_changed',
          snap => setProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
          reject, resolve)
      })
      const url = await getDownloadURL(storageRef)
      await addDoc(collection(db, 'regolamenti'), {
        nome:        uploadForm.nome.trim(),
        categoria:   uploadForm.categoria,
        filename:    pendingFile.name,
        size:        pendingFile.size,
        storagePath: storageRef.fullPath,
        url, testo,
        caricato:    new Date(),
      })
      setPendingFile(null)
      setUploadForm({ nome: '', categoria: 'Nazionali FIN' })
      await fetchDocs()
    } catch (e) { setError('Errore upload: ' + e.message) }
    finally { setUploading(false); setProgress(0) }
  }

  async function handleDelete(item) {
    if (!confirm('Eliminare "' + item.nome + '"?')) return
    setDeleting(item.id)
    try {
      await deleteObject(ref(storage, item.storagePath))
      await deleteDoc(doc(db, 'regolamenti', item.id))
      setDocs(prev => prev.filter(d => d.id !== item.id))
      if (viewer && viewer.id === item.id) setViewer(null)
    } catch (e) { setError('Errore eliminazione: ' + e.message) }
    finally { setDeleting(null) }
  }

  const filtered = docs.filter(d => {
    const matchCat = catFilter === 'Tutti' || d.categoria === catFilter
    const q = search.toLowerCase()
    const matchSearch = !q || d.nome.toLowerCase().includes(q) || (d.testo || '').toLowerCase().includes(q)
    return matchCat && matchSearch
  })

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-green" />
        <div className="px-5 py-4">
          <p className="text-sm font-bold text-sb-text mb-3">Carica Regolamento</p>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !pendingFile && fileRef.current && fileRef.current.click()}
            className={
              'border-2 border-dashed rounded-xl px-4 py-5 text-center transition-colors cursor-pointer ' +
              (dragging ? 'border-sb-green bg-green-50' :
               pendingFile ? 'border-sb-blue bg-blue-50 cursor-default' :
               'border-sb-sep hover:border-sb-blue hover:bg-sb-bg')
            }
          >
            {pendingFile ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl">PDF</span>
                <div className="text-left">
                  <p className="text-sm font-semibold text-sb-text">{pendingFile.name}</p>
                  <p className="text-xs text-sb-muted">{formatBytes(pendingFile.size)}</p>
                </div>
                <button onClick={e => { e.stopPropagation(); setPendingFile(null) }}
                  className="ml-2 text-sb-muted hover:text-red-500 text-lg leading-none">x</button>
              </div>
            ) : (
              <div>
                <p className="text-3xl mb-1 opacity-40">PDF</p>
                <p className="text-sm text-sb-muted">
                  Trascina un PDF o <span className="text-sb-blue font-medium">clicca per scegliere</span>
                </p>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".pdf" className="hidden"
            onChange={e => handleFileSelect(e.target.files[0])} />

          {pendingFile && (
            <div className="mt-3 flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-40">
                <label className="block text-xs text-sb-muted font-medium mb-1">Nome</label>
                <input value={uploadForm.nome}
                  onChange={e => setUploadForm(f => ({ ...f, nome: e.target.value }))}
                  className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                  placeholder="Es. Campionati Italiani 2025" />
              </div>
              <div>
                <label className="block text-xs text-sb-muted font-medium mb-1">Categoria</label>
                <select value={uploadForm.categoria}
                  onChange={e => setUploadForm(f => ({ ...f, categoria: e.target.value }))}
                  className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
                  {CATEGORIE.filter(c => c !== 'Tutti').map(c => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <button onClick={handleUpload} disabled={uploading}
                className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                {uploading ? ('Caricamento ' + progress + '%') : 'Carica'}
              </button>
            </div>
          )}

          {uploading && (
            <div className="mt-2 h-1.5 bg-sb-dark rounded-full overflow-hidden">
              <div className="h-full bg-sb-green rounded-full transition-all" style={{ width: progress + '%' }} />
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      </div>

      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm px-5 py-3 flex flex-wrap gap-3 items-center">
        <div className="flex gap-1.5 flex-wrap">
          {CATEGORIE.map(c => (
            <button key={c} onClick={() => setCatFilter(c)}
              className={
                'px-3 py-1 rounded-full text-xs font-medium transition-colors ' +
                (catFilter === c ? 'bg-sb-blue text-white' : 'bg-sb-bg text-sb-muted hover:bg-sb-sep')
              }>
              {c}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-40">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Cerca nel testo dei regolamenti..."
            className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
        </div>
        <span className="text-xs text-sb-muted">
          {filtered.length} documento{filtered.length !== 1 ? 'i' : ''}
        </span>
      </div>

      <div className="flex gap-3" style={{ minHeight: 0, flex: 1 }}>
        <div className="flex flex-col gap-2" style={{ width: viewer ? '340px' : '100%', flexShrink: 0 }}>
          {loading ? (
            <div className="bg-sb-panel rounded-2xl border border-sb-sep p-8 text-center text-sb-muted text-sm">
              Caricamento...
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-sb-panel rounded-2xl border border-sb-sep p-8 text-center">
              <p className="text-3xl mb-2 opacity-30">PDF</p>
              <p className="text-sb-muted text-sm">
                {docs.length === 0 ? 'Nessun regolamento caricato' : 'Nessun risultato'}
              </p>
            </div>
          ) : (
            filtered.map(item => (
              <div key={item.id}
                className={
                  'bg-sb-panel rounded-2xl border shadow-sm px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ' +
                  (viewer && viewer.id === item.id ? 'border-sb-blue bg-blue-50/30' : 'border-sb-sep hover:border-sb-blue')
                }
                onClick={() => setViewer(viewer && viewer.id === item.id ? null : { id: item.id, url: item.url, nome: item.nome })}>
                <span className="text-xl font-bold text-sb-muted">PDF</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-sb-text truncate">{item.nome}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className={
                      'text-xs px-2 py-0.5 rounded-full font-medium ' +
                      (CAT_COLORS[item.categoria] || 'bg-gray-100 text-gray-600')
                    }>{item.categoria}</span>
                    <span className="text-xs text-sb-muted">{formatDate(item.caricato)}</span>
                    <span className="text-xs text-sb-muted">{formatBytes(item.size)}</span>
                  </div>
                  {search && item.testo && item.testo.toLowerCase().includes(search.toLowerCase()) && (
                    <p className="text-xs text-sb-blue mt-1 truncate">
                      ...{getSnippet(item.testo, search)}...
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <a href={item.url} target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="px-2 py-1.5 rounded-lg text-xs text-sb-muted hover:text-sb-blue hover:bg-sb-bg"
                    title="Scarica">DL</a>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(item) }}
                    disabled={deleting === item.id}
                    className="px-2 py-1.5 rounded-lg text-xs text-sb-muted hover:text-red-500 hover:bg-red-50 disabled:opacity-40"
                    title="Elimina">X</button>
                </div>
              </div>
            ))
          )}
        </div>

        {viewer && (
          <div className="flex-1 bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden flex flex-col" style={{ minHeight: '500px' }}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-sb-sep">
              <p className="text-sm font-semibold text-sb-text truncate">{viewer.nome}</p>
              <button onClick={() => setViewer(null)}
                className="text-sb-muted hover:text-sb-text text-xl leading-none px-1">x</button>
            </div>
            <iframe src={viewer.url} className="flex-1 w-full" title={viewer.nome} style={{ minHeight: '480px' }} />
          </div>
        )}
      </div>

    </div>
  )
}
