import React from 'react';
import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore.js';
import { 
  LayoutDashboard, 
  MessageSquare, 
  Users, 
  Kanban, 
  Settings, 
  LogOut 
} from 'lucide-react';

export default function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navItems = [
    { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    { name: 'Inbox', path: '/inbox', icon: MessageSquare },
    { name: 'Contacts', path: '/contacts', icon: Users },
    { name: 'Pipeline', path: '/pipeline', icon: Kanban },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];

  return (
    <div className="flex h-screen bg-neutral-50 overflow-hidden w-full text-left">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-neutral-200 flex flex-col shrink-0">
        {/* Logo */}
        <div className="h-16 px-6 border-b border-neutral-200 flex items-center space-x-3">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center text-white font-bold">
            W
          </div>
          <span className="text-lg font-semibold tracking-tight text-neutral-950">WaCRM</span>
        </div>

        {/* Nav Links */}
        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.name}
                to={item.path}
                className={`flex items-center space-x-3 px-3 py-2 text-sm font-medium rounded-md transition duration-150 ${
                  isActive
                    ? 'bg-emerald-50 text-primary'
                    : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800'
                }`}
              >
                <Icon className={`h-5 w-5 ${isActive ? 'text-primary' : 'text-neutral-500'}`} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        {/* User Card & Logout */}
        <div className="p-4 border-t border-neutral-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 overflow-hidden">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-primary font-semibold shrink-0">
                {user?.name?.slice(0, 2).toUpperCase() || 'US'}
              </div>
              <div className="overflow-hidden">
                <p className="text-sm font-medium text-neutral-950 truncate">{user?.name}</p>
                <p className="text-xs text-neutral-500 capitalize">{user?.role}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-md hover:bg-rose-50 text-neutral-500 hover:text-rose-600 transition cursor-pointer"
              title="Sign Out"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-neutral-200 px-8 flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-neutral-950">
            {navItems.find(item => item.path === location.pathname)?.name || 'Dashboard'}
          </h2>
        </header>

        {/* Scrollable Workspace */}
        <main className="flex-1 overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
