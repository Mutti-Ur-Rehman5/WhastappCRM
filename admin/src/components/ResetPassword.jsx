import { useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, ArrowLeft, KeyRound, Mail, Hash, Lock } from 'lucide-react';
import { api } from '../api.js';

const cardVariants = {
  initial: { opacity: 0, scale: 0.96, y: 16 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

export default function ResetPassword() {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const [email, setEmail] = useState(params.get('email') || '');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/admin/reset-password', {
        method: 'POST',
        body: { email, otp, newPassword },
      });
      setNotice('Password updated. Redirecting to sign in…');
      setTimeout(() => {
        window.location.hash = '#/login';
      }, 1500);
    } catch (err) {
      setError(err.message || 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <div className="login-hero">
        <div className="login-hero-content">
          <div className="login-hero-icon">
            <Shield size={36} strokeWidth={1.5} />
          </div>
          <h2>Create a new password</h2>
          <p>Enter the 6-digit code from your email and choose a strong new password for your account.</p>
        </div>
      </div>

      <div className="login-form-side">
        <motion.form
          className="card login-card"
          onSubmit={submit}
          variants={cardVariants}
          initial="initial"
          animate="animate"
        >
          <div className="login-logo">
            <div className="login-logo-icon">
              <KeyRound size={24} strokeWidth={2} />
            </div>
            <div>
              <h1>Reset password</h1>
              <p className="login-subtitle">Verify your identity and set a new password.</p>
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">Email address</span>
            <div className="login-input-wrap">
              <Mail size={16} className="login-input-icon" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@clinic.com"
                autoFocus
              />
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">6-digit code</span>
            <div className="login-input-wrap">
              <Hash size={16} className="login-input-icon" />
              <input
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">New password</span>
            <div className="login-input-wrap">
              <Lock size={16} className="login-input-icon" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters"
              />
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">Confirm new password</span>
            <div className="login-input-wrap">
              <Lock size={16} className="login-input-icon" />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
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
          {notice && (
            <motion.div
              className="notice"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.2 }}
            >
              {notice}
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
              <span className="btn-loading"><span className="spinner sm" /> Resetting…</span>
            ) : 'Reset password'}
          </motion.button>

          <a className="link" href="#/login">
            <ArrowLeft size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
            Back to sign in
          </a>
        </motion.form>
      </div>
    </div>
  );
}
