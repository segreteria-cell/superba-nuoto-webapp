import { NavLink, useLocation } from 'react-router-dom'

const GROUPS = [
  {
    label: 'DATI',
    items: [
      { path: '/download',   icon: '⬇', label: 'Download' },
      { path: '/estrazione', icon: '⚙', label: 'Estrazione' },
    ],
  },
  {
    label: 'ANALISI',
    items: [
      { path: '/graduatorie',    icon: '🏅', label: 'Graduatorie' },
      { path: '/regolamenti',    icon: '📄', label: 'Regolamenti' },
      { path: '/classifiche',    icon: '📊', label: 'Classifiche' },
      { path: '/qualifiche',     icon: '🏆', label: 'Qualifiche' },
      { path: '/grad-posizioni', icon: '📋', label: 'Grad. posizioni' },
      { path: '/storico',        icon: '📈', label: 'Storico' },
    ],
  },
  {
    label: 'GESTIONE',
    items: [
      { path: '/dashboard',    icon: '🔲', label: 'Dashboard' },
      { path: '/incentivante', icon: '💰', label: 'Incentivante' },
    ],
  },
]

function SidebarItem({ path, icon, label }) {
  return (
    <NavLink
      to={path}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2.5 mx-1 rounded-lg transition-all duration-150 group relative
         ${isActive
           ? 'bg-sb-blue text-white'
           : 'text-[#7aafd0] hover:bg-sb-hover hover:text-[#c8e4f5]'
         }`
      }
    >
      {({ isActive }) => (
        <>
          {/* accent bar sinistra */}
          <span className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-full transition-all
            ${isActive ? 'bg-sb-aqua' : 'bg-transparent'}`} />
          <span className="text-base w-5 text-center flex-shrink-0">{icon}</span>
          <span className="text-[13px] font-medium truncate">{label}</span>
        </>
      )}
    </NavLink>
  )
}

export default function Sidebar() {
  return (
    <aside className="w-44 flex-shrink-0 bg-sb-dark flex flex-col h-screen sticky top-0 overflow-y-auto">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3 py-4 border-b border-white/10">
        <div className="w-8 h-8 rounded-lg bg-sb-blue flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          SN
        </div>
        <div>
          <div className="text-white text-sm font-bold leading-tight">Superba</div>
          <div className="text-[#5a8aaa] text-[10px]">Nuoto</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 space-y-4">
        {GROUPS.map(({ label, items }) => (
          <div key={label}>
            <p className="px-4 mb-1 text-[10px] font-semibold tracking-widest text-[#2a4a5e] uppercase">
              {label}
            </p>
            <div className="space-y-0.5">
              {items.map(item => (
                <SidebarItem key={item.path} {...item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/10">
        <p className="text-[10px] text-[#2a4a5e]">v4.0</p>
      </div>
    </aside>
  )
}
