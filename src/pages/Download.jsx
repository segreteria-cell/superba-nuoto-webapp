import { useState, useRef, useCallback } from "react"
import { PDFDocument } from "pdf-lib"

// ─── CORS proxy con fallback automatico ────────────────────────────────────────
const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
]

async function fetchWithFallback(url, opts = {}) {
  let lastErr
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy(url), opts)
      if (res.status === 403 || res.status === 429) continue
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error("Tutti i proxy falliti")
}

// ─── Pattern di esclusione (come nell'app Python) ──────────────────────────────
const ESCLUDI = /elenco|iscrit|batterie|piano|vasca|classifica|riepilog|tabella|orari|^1\.pdf$|^2\.pdf$|^3\.pdf$/i
const STAFFETTA = /4x/i

function extractPdfLinks(html, pageUrl) {
  const base = pageUrl.substring(0, pageUrl.lastIndexOf("/") + 1)
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")

  let luogo = ""
  for (const tag of doc.querySelectorAll("h1,h2,h3")) {
    const t = tag.textContent.trim()
    if (t && /^[A-ZÀ-Ü]/.test(t)) {
      luogo = t.split(/\s+/)[0]
      break
    }
  }

  const links = {}
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")
    if (!href?.toLowerCase().endsWith(".pdf")) continue
    const filename = href.split("/").pop()
    if (ESCLUDI.test(filename)) continue
    const fullUrl = href.startsWith("http") ? href : base + href
    links[filename] = {
      url: fullUrl,
      label: a.textContent.trim() || filename,
      staffetta: STAFFETTA.test(filename),
      selected: true,
    }
  }
  return { links, luogo }
}

const TAG_COLORS = {
  ok:   "text-green-400",
  err:  "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-300",
  head: "text-white font-bold",
}

export default function Download() {
  const [url, setUrl]             = useState("")
  const [links, setLinks]         = useState({})
  const [mergeName, setMergeName] = useState("Risultati")
  const [log, setLog]             = useState([])
  const [analyzing, setAnalyzing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress]   = useState({ cur: 0, tot: 0, label: "Pronto" })
  const cancelRef = useRef(false)
  const logEndRef = useRef(null)

  const addLog = useCallback((msg, tag = "info") => {
    setLog(prev => {
      const next = [...prev, { msg, tag, id: Date.now() + Math.random() }]
      return next
    })
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50)
  }, [])

  async function handleAnalyze() {
    const trimmed = url.trim()
    if (!trimmed.startsWith("http")) {
      addLog("L'URL deve iniziare con http://", "warn")
      return
    }
    setLinks({})
    setAnalyzing(true)
    addLog(`Analisi: ${trimmed}`, "head")
    try {
      const res = await fetchWithFallback(trimmed)
      const html = await res.text()
      const { links: found, luogo } = extractPdfLinks(html, trimmed)
      const count = Object.keys(found).length
      if (count === 0) {
        addLog("Nessun PDF trovato nella pagina.", "warn")
      } else {
        addLog(`Trovati ${count} PDF${luogo ? ` — luogo: ${luogo}` : ""}`, "ok")
        const slug = trimmed.replace(/\/$/, "").split("/").at(-2) ?? "Risultati"
        setMergeName(`Risultati_${luogo || slug}`)
        Object.entries(found).forEach(([fn, info]) => {
          addLog(`  ${info.staffetta ? "🔀" : "📄"} ${info.label} (${fn})`, info.staffetta ? "warn" : "info")
        })
      }
      setLinks(found)
    } catch (e) {
      addLog(`Errore analisi: ${e.message}`, "err")
    } finally {
      setAnalyzing(false)
    }
  }

  function toggleLink(filename) {
    setLinks(prev => ({ ...prev, [filename]: { ...prev[filename], selected: !prev[filename].selected } }))
  }
  function selectAll()   { setLinks(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, selected: true }]))) }
  function deselectAll() { setLinks(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, selected: false }]))) }

  const selectedLinks = Object.entries(links).filter(([, v]) => v.selected)

  async function handleDownload() {
    if (selectedLinks.length === 0) { addLog("Nessun PDF selezionato.", "warn"); return }
    cancelRef.current = false
    setDownloading(true)
    setProgress({ cur: 0, tot: selectedLinks.length, label: "Inizio download…" })
    addLog(`─── Download di ${selectedLinks.length} PDF ───`, "head")

    const pdfBytes = []
    for (let i = 0; i < selectedLinks.length; i++) {
      if (cancelRef.current) { addLog("Download annullato.", "warn"); break }
      const [filename, info] = selectedLinks[i]
      setProgress({ cur: i + 1, tot: selectedLinks.length, label: `Scaricando ${filename}…` })
      addLog(`[${i + 1}/${selectedLinks.length}] ${filename}`, "info")
      try {
        const res = await fetchWithFallback(info.url)
        const buf = await res.arrayBuffer()
        pdfBytes.push({ filename, buf })
        addLog(`  ✓ ${(buf.byteLength / 1024).toFixed(0)} KB`, "ok")
      } catch (e) {
        addLog(`  ✗ ${e.message}`, "err")
      }
    }

    if (!cancelRef.current && pdfBytes.length > 0) {
      setProgress(p => ({ ...p, label: "Unione PDF…" }))
      addLog("Unione PDF in corso…", "info")
      try {
        const merged = await PDFDocument.create()
        for (const { filename, buf } of pdfBytes) {
          try {
            const src = await PDFDocument.load(buf, { ignoreEncryption: true })
            const pages = await merged.copyPages(src, src.getPageIndices())
            pages.forEach(p => merged.addPage(p))
          } catch (e) {
            addLog(`  ⚠ Impossibile unire ${filename}: ${e.message}`, "warn")
          }
        }
        const finalBytes = await merged.save()
        const blob = new Blob([finalBytes], { type: "application/pdf" })
        const a = document.createElement("a")
        a.href = URL.createObjectURL(blob)
        a.download = `${mergeName || "Risultati"}.pdf`
        a.click()
        URL.revokeObjectURL(a.href)
        addLog(`✓ Salvato: ${mergeName || "Risultati"}.pdf (${(finalBytes.byteLength / 1024).toFixed(0)} KB)`, "ok")
      } catch (e) {
        addLog(`Errore unione: ${e.message}`, "err")
      }
    }

    setDownloading(false)
    setProgress({ cur: 0, tot: 0, label: cancelRef.current ? "Annullato" : "Completato" })
  }

  const progressPct = progress.tot > 0 ? Math.round((progress.cur / progress.tot) * 100) : 0

  return (
    <div className="flex flex-col h-full gap-3">

      {/* URL row */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl p-4">
        <p className="text-xs font-bold text-sb-aqua mb-2 uppercase tracking-wider">🌐 URL Pagina Risultati</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !analyzing && handleAnalyze()}
            placeholder="https://genovagare.it/manifestazioni/…"
            className="flex-1 bg-sb-dark border border-sb-sep rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-sb-muted focus:outline-none focus:border-sb-blue"
          />
          <button
            onClick={handleAnalyze}
            disabled={analyzing || downloading}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-sb-green text-white disabled:opacity-50 hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            {analyzing ? "⏳ Analisi…" : "🔍 Analizza Pagina"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex gap-3 flex-1 min-h-0">

        {/* Lista gare */}
        <div className="w-72 flex-shrink-0 bg-sb-panel border border-sb-sep rounded-xl flex flex-col">
          <div className="px-4 pt-3 pb-2 border-b border-sb-sep">
            <p className="text-xs font-bold text-sb-aqua uppercase tracking-wider">Gare Trovate</p>
            {Object.keys(links).length > 0 && (
              <div className="flex items-center gap-3 mt-2">
                <button onClick={selectAll}   className="text-xs text-sb-aqua hover:underline">Seleziona tutto</button>
                <button onClick={deselectAll} className="text-xs text-sb-muted hover:underline">Deseleziona tutto</button>
                <span className="ml-auto text-xs text-sb-muted">{selectedLinks.length}/{Object.keys(links).length}</span>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {Object.keys(links).length === 0 ? (
              <p className="text-sb-muted text-sm text-center mt-8 leading-relaxed">
                Inserisci l'URL e clicca<br/>"Analizza Pagina"
              </p>
            ) : (
              <div className="space-y-0.5">
                {Object.entries(links).map(([filename, info]) => (
                  <label key={filename} className="flex items-start gap-2 cursor-pointer hover:bg-sb-hover rounded-lg px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={info.selected}
                      onChange={() => toggleLink(filename)}
                      className="mt-0.5 accent-sb-blue flex-shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-white leading-snug">
                        {info.staffetta ? "🔀 " : "📄 "}{info.label}
                      </p>
                      <p className="text-xs text-sb-muted truncate">{filename}</p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Destra: impostazioni + log */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <div className="bg-sb-panel border border-sb-sep rounded-xl p-4">
            <p className="text-xs font-bold text-sb-aqua mb-3 uppercase tracking-wider">⚙ Impostazioni</p>
            <label className="text-xs text-sb-muted block mb-1">Nome PDF unificato</label>
            <input
              type="text"
              value={mergeName}
              onChange={e => setMergeName(e.target.value)}
              className="w-full bg-sb-dark border border-sb-sep rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-sb-blue"
            />
            <p className="text-xs text-sb-muted mt-1.5">
              Salvato come <span className="text-sb-aqua">{mergeName || "Risultati"}.pdf</span> nella cartella Download
            </p>
          </div>

          <div className="flex-1 bg-sb-panel border border-sb-sep rounded-xl flex flex-col min-h-0">
            <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-sb-sep">
              <p className="text-xs font-bold text-sb-aqua uppercase tracking-wider">Log Download</p>
              <button onClick={() => setLog([])} className="text-xs text-sb-muted hover:text-white transition-colors">Pulisci</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
              {log.length === 0
                ? <p className="text-sb-muted">—</p>
                : log.map(entry => (
                    <p key={entry.id} className={TAG_COLORS[entry.tag] ?? "text-sb-muted"}>{entry.msg}</p>
                  ))
              }
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-sb-panel border border-sb-sep rounded-xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs text-sb-muted w-48 truncate">{progress.label}</span>
          <div className="flex-1 h-2 bg-sb-dark rounded-full overflow-hidden">
            <div
              className="h-full bg-sb-blue rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-xs text-sb-muted w-10 text-right">{progressPct > 0 ? `${progressPct}%` : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLog([])}
            disabled={downloading}
            className="px-4 py-2 rounded-lg text-xs text-sb-muted bg-sb-dark hover:text-white transition-colors disabled:opacity-40"
          >
            Pulisci Log
          </button>
          {downloading && (
            <button
              onClick={() => { cancelRef.current = true }}
              className="px-4 py-2 rounded-lg text-xs text-red-400 bg-sb-dark hover:bg-red-950 transition-colors"
            >
              ✕ Annulla
            </button>
          )}
          <button
            onClick={handleDownload}
            disabled={downloading || analyzing || selectedLinks.length === 0}
            className="ml-auto px-8 py-2.5 rounded-lg text-sm font-bold bg-sb-blue text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {downloading
              ? "⏳ Download in corso…"
              : `⬇  Scarica e Unisci PDF${selectedLinks.length > 0 ? ` (${selectedLinks.length})` : ""}`
            }
          </button>
        </div>
      </div>
    </div>
  )
}
