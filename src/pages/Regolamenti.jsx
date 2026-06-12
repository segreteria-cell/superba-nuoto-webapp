import { useState, useEffect } from 'react'
import { db } from '../lib/firebase'
import {
  collection, addDoc, getDocs, deleteDoc, doc, query, orderBy,
} from 'firebase/firestore'

const CATEGORIE = ['Tutti', 'Nazionali FIN', 'Regionali', 'CSI', 'Master', 'Altro']

const CAT_COLORS = {
  'Nazionali FIN': 'bg-blue-100 text-blue-700',
  'Regionali':     'bg-purple-100 text-purple-700',
  'CSI':           'bg-green-100 text-green-700',
  'Master':        'bg-orange-100 text-orange-700',
  'Altro':         'bg-gray-100 text-gray-600',
}

// Converte link Google Drive share -> embed per iframe
function toEmbedUrl(url) {
  if (!url) return url
  const m = url.match(/\/file\/d\/([^/]+)/)
  if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview'
  return url
}

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('it-IT')
}

export default function Regolamenti() {
  const [docs, setDocs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [catFilter, setCatFilter] = useState('Tutti')
  const [search, setSearch]       = useState('')
  const [viewer, setViewer]       = useState(null)
  const [deleting, setDeleting]   = useState(null)
  const [form, setForm]           = useState({ nome: '', categoria: 'Nazionali FIN', url: '', note: '' })
  const [error, setError]         = useState('')

  async function fetchDocs() {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'regolamenti'), orderBy('caricato', 'desc')))
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    } catch (e) { setError('Errore caricamento: ' + e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchDocs() }, [])

  async function handleSave() {
    if (!form.nome.trim()) { setError('Inserisci un nome.'); return }
    if (!form.url.trim())  { setError('Inserisci il link Google Drive.'); return }
    setSaving(true); setError('')
    try {
      await addDoc(collection(db, 'regolamenti'), {
        nome:      form.nome.trim(),
        categoria: form.categoria,
        url:       form.url.trim(),
        note:      form.note.trim(),
        caricato:  new Date(),
      })
      setForm({ nome: '', categoria: 'Nazionali FIN', url: '', note: '' })
      await fetchDocs()
    } catch (e) { setError('Errore salvataggio: ' + e.message) }
    finally { setSaving(false) }
  }

  async function handleDelete(item) {
    if (!confirm('Eliminare "' + item.nome + '"?')) return
    setDeleting(item.id)
    try {
      await deleteDoc(doc(db, 'regolamenti', item.id))
      setDocs(prev => prev.filter(d => d.id !== item.id))
      if (viewer && viewer.id === item.id) setViewer(null)
    } catch (e) { setError('Errore eliminazione: ' + e.message) }
    finally { setDeleting(null) }
  }

  const filtered = docs.filter(d => {
    const matchCat = catFilter === 'Tutti' || d.categoria === catFilter
    const q = search.toLowerCase()
    const matchSearch = !q || d.nome.toLowerCase().includes(q) || (d.note || '').toLowerCase().includes(q)
    return matchCat && matchSearch
  })

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>

      {/* Form aggiunta */}
      <div className="bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden">
        <div className="h-0.5 bg-sb-green" />
        <div className="px-5 py-4">
          <p className="text-sm font-bold text-sb-text mb-3">Aggiungi Regolamento</p>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-48">
              <label className="block text-xs text-sb-muted font-medium mb-1">Nome</label>
              <input value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                placeholder="Es. Campionati Italiani 2025" />
            </div>
            <div>
              <label className="block text-xs text-sb-muted font-medium mb-1">Categoria</label>
              <select value={form.categoria} onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}
                className="border border-sb-sep rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sb-blue">
                {CATEGORIE.filter(c => c !== 'Tutti').map(c => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-64">
              <label className="block text-xs text-sb-muted font-medium mb-1">Link Google Drive</label>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                placeholder="https://drive.google.com/file/d/..." />
            </div>
            <div className="flex-1 min-w-32">
              <label className="block text-xs text-sb-muted font-medium mb-1">Note (opzionale)</label>
              <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue"
                placeholder="Es. tempi limite, criteri..." />
            </div>
            <button onClick={handleSave} disabled={saving}
              className="px-5 py-2 bg-sb-green text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50">
              {saving ? 'Salvataggio...' : '+ Aggiungi'}
            </button>
          </div>
          <p className="text-xs text-sb-muted mt-2">
            Su Google Drive: tasto destro sul PDF &rarr; <strong>Condividi</strong> &rarr; <strong>Chiunque abbia il link</strong> &rarr; copia il link.
          </p>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      </div>

      {/* Filtri */}
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
            placeholder="Cerca per nome o note..."
            className="w-full border border-sb-sep rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sb-blue" />
        </div>
        <span className="text-xs text-sb-muted">
          {filtered.length} documento{filtered.length !== 1 ? 'i' : ''}
        </span>
      </div>

      <div className="flex gap-3" style={{ minHeight: 0, flex: 1 }}>
        {/* Lista */}
        <div className="flex flex-col gap-2" style={{ width: viewer ? '360px' : '100%', flexShrink: 0 }}>
          {loading ? (
            <div className="bg-sb-panel rounded-2xl border border-sb-sep p-8 text-center text-sb-muted text-sm">
              Caricamento...
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-sb-panel rounded-2xl border border-sb-sep p-8 text-center">
              <p className="text-sb-muted text-sm">
                {docs.length === 0 ? 'Nessun regolamento aggiunto' : 'Nessun risultato'}
              </p>
            </div>
          ) : (
            filtered.map(item => (
              <div key={item.id}
                className={
                  'bg-sb-panel rounded-2xl border shadow-sm px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ' +
                  (viewer && viewer.id === item.id ? 'border-sb-blue bg-blue-50/30' : 'border-sb-sep hover:border-sb-blue')
                }
                onClick={() => setViewer(viewer && viewer.id === item.id ? null : { id: item.id, url: toEmbedUrl(item.url), nome: item.nome })}>
                <span className="text-xl font-bold text-sb-muted select-none">PDF</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-sb-text truncate">{item.nome}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className={
                      'text-xs px-2 py-0.5 rounded-full font-medium ' +
                      (CAT_COLORS[item.categoria] || 'bg-gray-100 text-gray-600')
                    }>{item.categoria}</span>
                    <span className="text-xs text-sb-muted">{formatDate(item.caricato)}</span>
                  </div>
                  {item.note && (
                    <p className="text-xs text-sb-muted mt-0.5 truncate">{item.note}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <a href={item.url} target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="px-2 py-1.5 rounded-lg text-xs text-sb-muted hover:text-sb-blue hover:bg-sb-bg">
                    Apri
                  </a>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(item) }}
                    disabled={deleting === item.id}
                    className="px-2 py-1.5 rounded-lg text-xs text-sb-muted hover:text-red-500 hover:bg-red-50 disabled:opacity-40">
                    Elimina
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Viewer PDF */}
        {viewer && (
          <div className="flex-1 bg-sb-panel rounded-2xl border border-sb-sep shadow-sm overflow-hidden flex flex-col" style={{ minHeight: '500px' }}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-sb-sep">
              <p className="text-sm font-semibold text-sb-text truncate">{viewer.nome}</p>
              <button onClick={() => setViewer(null)}
                className="text-sb-muted hover:text-sb-text text-xl leading-none px-1">x</button>
            </div>
            <iframe src={viewer.url} className="flex-1 w-full" title={viewer.nome}
              allow="autoplay" style={{ minHeight: '480px' }} />
          </div>
        )}
      </div>

    </div>
  )
}
