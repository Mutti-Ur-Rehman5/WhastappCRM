import { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, ArrowLeft, Stethoscope, Send } from 'lucide-react';
import { api } from '../api.js';

const cardVariants = {
  initial: { opacity: 0, scale: 0.96, y: 16 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/admin/forgot-password', { method: 'POST', body: { email } });
      setNotice('If this email is registered, an OTP has been sent.');
    } catch (err) {
      setError(err.message || 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <div className="login-hero">
        <div className="login-hero-content">
          <div className="login-hero-icon">
            <Stethoscope size={36} strokeWidth={1.5} />
          </div>
          <h2>Reset your password</h2>
          <p>We&apos;ll send a one-time code to your registered email so you can set a new password.</p>
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
              <Mail size={24} strokeWidth={2} />
            </div>
            <div>
              <h1>Forgot password?</h1>
              <p className="login-subtitle">Enter the admin email — we&apos;ll send you a 6-digit code.</p>
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
              <span className="btn-loading"><span className="spinner sm" /> Sending…</span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Send size={15} /> Send OTP</span>
            )}
          </motion.button>

          {notice && (
            <a className="link" href={`#/reset-password?email=${encodeURIComponent(email)}`}>
              I have a code — enter it
            </a>
          )}

          <a className="link" href="#/login">
            <ArrowLeft size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
            Back to sign in
          </a>
        </motion.form>
      </div>
    </div>
  );
}
