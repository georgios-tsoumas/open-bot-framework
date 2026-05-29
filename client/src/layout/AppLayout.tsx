import React from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { Bot, KeyRound, MessageSquare, LogOut, Moon, Sun, ChevronRight } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

const Sidebar: React.FC = () => {
  const { botId } = useParams();
  const navBase =
    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors';
  const inactive = 'text-content-muted hover:bg-surface-muted hover:text-content';
  const active = 'bg-primary-600 text-white shadow-sm';

  const items = [
    { to: '/bots', label: 'Bots', icon: Bot, end: false },
  ];

  const botScoped = botId
    ? [
        { to: `/bots/${botId}/credentials`, label: 'Credentials', icon: KeyRound },
        { to: `/bots/${botId}/webchat`, label: 'WebChat', icon: MessageSquare },
      ]
    : [];

  return (
    <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-border bg-surface-raised">
      <div className="h-16 flex items-center gap-2 px-5 border-b border-border">
        <div className="h-8 w-8 rounded-lg bg-primary-600 flex items-center justify-center text-white">
          <Bot className="h-4 w-4" />
        </div>
        <span className="text-lg font-semibold tracking-tight">OpenBot</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `${navBase} ${isActive ? active : inactive}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
        {botScoped.length > 0 && (
          <>
            <div className="pt-4 pb-1 px-3 text-xs font-semibold uppercase tracking-wider text-content-subtle">
              Current bot
            </div>
            {botScoped.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `${navBase} ${isActive ? active : inactive}`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </>
        )}
      </nav>
      <div className="px-3 pb-4 text-xs text-content-subtle">v1.0</div>
    </aside>
  );
};

function useBreadcrumbs() {
  const location = useLocation();
  const parts = location.pathname.split('/').filter(Boolean);
  const crumbs: { label: string; to: string }[] = [];
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    path += '/' + seg;
    let label = seg;
    if (seg === 'bots') label = 'Bots';
    else if (parts[i - 1] === 'bots' && i === 1) label = seg.slice(0, 8); // bot id short
    else if (seg === 'credentials') label = 'Credentials';
    else if (seg === 'webchat') label = 'WebChat';
    crumbs.push({ label, to: path });
  }
  return crumbs;
}

const TopBar: React.FC = () => {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const crumbs = useBreadcrumbs();

  return (
    <header className="h-16 shrink-0 border-b border-border bg-surface-raised/80 backdrop-blur sticky top-0 z-10">
      <div className="h-full flex items-center justify-between px-6">
        <nav className="flex items-center gap-2 text-sm">
          {crumbs.length === 0 && <span className="text-content-muted">Home</span>}
          {crumbs.map((c, i) => (
            <React.Fragment key={c.to}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-content-subtle" />}
              <Link
                to={c.to}
                className={`font-medium ${
                  i === crumbs.length - 1
                    ? 'text-content'
                    : 'text-content-muted hover:text-content'
                }`}
              >
                {c.label}
              </Link>
            </React.Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            className="p-2 rounded-lg text-content-muted hover:text-content hover:bg-surface-muted transition-colors"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-content-muted hover:text-content hover:bg-surface-muted transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
};

export const AppLayout: React.FC = () => {
  return (
    <div className="min-h-screen flex bg-surface text-content">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 px-6 py-8 max-w-6xl w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
