import { useLocation } from 'react-router-dom'

const TITLES = {
  '/download':      'Download',
  '/estrazione':    'Estrazione',
  '/graduatorie':   'Graduatorie',
  '/regolamenti':   'Regolamenti',
  '/classifiche':   'Classifiche',
  '/qualifiche':    'Qualifiche',
  '/grad-posizioni':'Grad. posizioni',
  '/storico':       'Storico',
  '/dashboard':     'Dashboard',
  '/incentivante':  'Incentivante',
}

export default function TopBar() {
  const { pathname } = useLocation()
  const title = TITLES[pathname] ?? 'Superba Nuoto'

  return (
    <header className="h-14 flex-shrink-0 bg-sb-panel border-b border-sb-sep flex items-center px-6 gap-4">
      {/* Accent line top */}
      <div className="absolute top-0 left-44 right-0 h-0.5 bg-sb-aqua" />

      <div className="flex items-center gap-3 flex-1 min-w-0">
        <h1 className="text-sb-text font-bold text-lg truncate">{title}</h1>
        <span className="text-sb-muted text-sm hidden sm:block">·</span>
        <span className="text-sb-muted text-sm hidden sm:block">Gestione Risultati</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold bg-sb-blue text-white px-2.5 py-1 rounded-md">
          SUPERBA TOOLS
        </span>
      </div>
    </header>
  )
}
