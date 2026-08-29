import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Calendar, Clock, LogOut, Shield } from 'lucide-react';
import { api } from './api.js';
import Login from './components/Login.jsx';
import ForgotPassword from './components/ForgotPassword.jsx';
import ResetPassword from './components/ResetPassword.jsx';
import Appointments from './components/Appointments.jsx';
import Schedule from './components/Schedule.jsx';

const pageVariants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -12, transition: { duration: 0.2, ease: 'easeIn' } },
};

function PageWrap({ children }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{ width: '100%' }}
    >
      {children}
    </motion.div>
  );
}

function NavLink({ href, active, children }) {
  return (
    <a href={href} className={`nav-link ${active ? 'nav-link--active' : ''}`}>
      {children}
      {active && (
        <motion.span className="nav-indicator" layoutId="nav-indicator" transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
      )}
    </a>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [route, setRoute] = useState(window.location.hash || '#/appointments');

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/appointments');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api('/api/auth/me')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="page center">
        <div className="spinner" />
      </div>
    );
  }

  if (!authed) {
    const publicPage = (route.replace(/^#\//, '') || '').split('?')[0];
    if (publicPage === 'forgot-password') return <PageWrap><ForgotPassword /></PageWrap>;
    if (publicPage === 'reset-password') return <PageWrap><ResetPassword /></PageWrap>;
    return <PageWrap><Login onLogin={() => setAuthed(true)} /></PageWrap>;
  }

  const page = route.replace(/^#\//, '') || 'appointments';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Shield size={18} strokeWidth={2.5} />
          </span>
          Clinic Admin
        </div>
        <nav>
          <NavLink href="#/appointments" active={page === 'appointments'}>
            <Calendar size={15} />
            Appointments
          </NavLink>
          <NavLink href="#/schedule" active={page === 'schedule'}>
            <Clock size={15} />
            Schedule
          </NavLink>
        </nav>
        <button
          type="button"
          className="topbar-logout"
          onClick={async () => {
            await api('/api/auth/logout', { method: 'POST' });
            setAuthed(false);
          }}
        >
          <LogOut size={15} />
          <span>Logout</span>
        </button>
      </header>
      <main className="content">
        <AnimatePresence mode="wait">
          {page === 'schedule'
            ? <PageWrap key="schedule"><Schedule /></PageWrap>
            : <PageWrap key="appointments"><Appointments /></PageWrap>
          }
        </AnimatePresence>
      </main>
    </div>
  );
}
