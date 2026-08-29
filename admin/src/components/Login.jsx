import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Lock, Stethoscope } from 'lucide-react';
import { api } from '../api.js';

const cardVariants = {
  initial: { opacity: 0, scale: 0.96, y: 16 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

const shakeVariants = {
  shake: {
    x: [0, -12, 12, -8, 8, -4, 0],
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
};

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      onLogin();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      {/* Left hero panel — desktop only */}
      <div className="login-hero">
        <div className="login-hero-content">
          <div className="login-hero-icon">
            <Stethoscope size={36} strokeWidth={1.5} />
          </div>
          <h2>Manage your clinic, effortlessly.</h2>
          <p>Book appointments, configure schedules, and keep your practice running smoothly — all from one place.</p>
        </div>
      </div>

      {/* Right form side */}
      <div className="login-form-side">
        <motion.form
          className="card login-card"
          onSubmit={submit}
          variants={cardVariants}
          initial="initial"
          animate="animate"
          {...(error ? { animate: 'shake' } : {})}
          key={error ? 'shake' : 'idle'}
          custom={shakeVariants}
        >
          <div className="login-logo">
            <div className="login-logo-icon">
              <Stethoscope size={24} strokeWidth={2} />
            </div>
            <div>
              <motion.h1
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.3 }}
              >
                Clinic Admin
              </motion.h1>
              <p className="login-subtitle">Sign in to your dashboard</p>
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">Username</span>
            <div className="login-input-wrap">
              <User size={16} className="login-input-icon" />
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                autoFocus
              />
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">Password</span>
            <div className="login-input-wrap">
              <Lock size={16} className="login-input-icon" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
              />
            </div>
          </div>

          {error && (
            <motion.div
              className="error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.2 }}
            >
              {error}
            </motion.div>
          )}

          <motion.button
            type="submit"
            disabled={busy}
            whileTap={{ scale: 0.97 }}
            whileHover={{ scale: 1.01 }}
            style={{ width: '100%', padding: '12px 18px' }}
          >
            {busy ? (
              <span className="btn-loading"><span className="spinner sm" /> Signing in…</span>
            ) : 'Sign in'}
          </motion.button>

          <a className="link" href="#/forgot-password">
            Forgot password?
          </a>
        </motion.form>
      </div>
    </div>
  );
}
