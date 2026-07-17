import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api.js';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const role = searchParams.get('role') || 'agent';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      await api.post('/auth/register', { name, email, password, role });
      navigate('/login');
    } catch (error) {
      setErr(error.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-neutral-200 shadow-sm p-8">
        <div className="flex items-center space-x-3 mb-8 justify-center">
          <div className="w-9 h-9 rounded-md bg-primary flex items-center justify-center text-white font-bold text-xl">
            W
          </div>
          <span className="text-2xl font-bold tracking-tight text-neutral-950">WaCRM</span>
        </div>

        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold text-neutral-950">Create Account</h1>
          <p className="text-neutral-500 text-sm mt-1">
            Register as an <span className="capitalize font-semibold text-primary">{role}</span> in this workspace.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 text-left">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5" htmlFor="reg-name">
              Full Name
            </label>
            <input
              id="reg-name"
              type="text"
              required
              className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
              placeholder="John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5" htmlFor="reg-email">
              Email Address
            </label>
            <input
              id="reg-email"
              type="email"
              required
              className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
              placeholder="john@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1.5" htmlFor="reg-password">
              Password
            </label>
            <input
              id="reg-password"
              type="password"
              required
              className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {err && (
            <div className="p-3 bg-rose-50 border border-rose-100 text-rose-700 text-xs rounded-md">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-md transition duration-200 flex items-center justify-center disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Creating Account...' : 'Register'}
          </button>
        </form>
      </div>
    </div>
  );
}
