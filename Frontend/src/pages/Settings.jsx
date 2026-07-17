import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore.js';
import api from '../services/api.js';
import { UserPlus, Copy, Check, Users } from 'lucide-react';

export default function Settings() {
  const { user } = useAuthStore();
  const [copied, setCopied] = useState(false);
  const [team, setTeam] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const isAdmin = user?.role === 'admin';

  const fetchUsers = async () => {
    if (!isAdmin) return;
    try {
      const response = await api.get('/auth/users');
      setTeam(response.data.data.users);
    } catch (error) {
      console.error('Failed to fetch team members:', error);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [user]);

  const handleCopyLink = () => {
    const link = `${window.location.origin}/register?role=agent`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateAgent = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    setErr(null);
    try {
      await api.post('/auth/register', { name, email, password, role: 'agent' });
      setMsg(`Agent ${name} registered successfully!`);
      setName('');
      setEmail('');
      setPassword('');
      fetchUsers();
    } catch (error) {
      setErr(error.response?.data?.message || 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl text-left">
      {/* Profile Section */}
      <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
        <h3 className="text-base font-semibold text-neutral-950 mb-4">My Account</h3>
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-primary font-bold text-lg">
            {user?.name?.slice(0, 2).toUpperCase() || 'US'}
          </div>
          <div>
            <h4 className="text-sm font-semibold text-neutral-950">{user?.name}</h4>
            <p className="text-xs text-neutral-500">{user?.email}</p>
            <span className="inline-block mt-1 px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-primary capitalize">
              {user?.role}
            </span>
          </div>
        </div>
      </div>

      {/* Admin Team Invitation Section */}
      {isAdmin && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Create Agent Form */}
          <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
            <h3 className="text-base font-semibold text-neutral-950 mb-1.5 flex items-center space-x-2">
              <UserPlus className="h-5 w-5 text-neutral-500" />
              <span>Add New Agent</span>
            </h3>
            <p className="text-xs text-neutral-500 mb-4">Directly register a new agent in the workspace.</p>

            <form onSubmit={handleCreateAgent} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1" htmlFor="agent-name">
                  Full Name
                </label>
                <input
                  id="agent-name"
                  type="text"
                  required
                  className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                  placeholder="John Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1" htmlFor="agent-email">
                  Email Address
                </label>
                <input
                  id="agent-email"
                  type="email"
                  required
                  className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                  placeholder="john@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-500 mb-1" htmlFor="agent-password">
                  Temporary Password
                </label>
                <input
                  id="agent-password"
                  type="password"
                  required
                  className="w-full px-3 py-2 text-sm bg-white border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {msg && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-primary text-xs rounded-md">
                  {msg}
                </div>
              )}
              {err && (
                <div className="p-2.5 bg-rose-50 border border-rose-100 text-rose-700 text-xs rounded-md">
                  {err}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 px-4 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-md transition duration-200 flex items-center justify-center disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Creating...' : 'Create Agent Account'}
              </button>
            </form>

            <div className="border-t border-neutral-200 mt-6 pt-6">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">Or Share Invitation Link</h4>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  className="flex-1 px-3 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md focus:outline-none text-neutral-500"
                  value={`${window.location.origin}/register?role=agent`}
                />
                <button
                  onClick={handleCopyLink}
                  className="p-1.5 border border-neutral-200 hover:bg-neutral-50 rounded-md transition cursor-pointer"
                  title="Copy Signup Link"
                >
                  {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4 text-neutral-500" />}
                </button>
              </div>
            </div>
          </div>

          {/* Active Users List */}
          <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm flex flex-col">
            <h3 className="text-base font-semibold text-neutral-950 mb-1.5 flex items-center space-x-2">
              <Users className="h-5 w-5 text-neutral-500" />
              <span>Workspace Members</span>
            </h3>
            <p className="text-xs text-neutral-500 mb-4">View and monitor active workspace accounts.</p>

            <div className="flex-1 overflow-y-auto max-h-96 space-y-4">
              {team.map((member) => (
                <div key={member._id} className="flex items-center justify-between p-3 bg-neutral-50 rounded-md border border-neutral-200">
                  <div className="flex items-center space-x-3 overflow-hidden">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 text-primary font-bold flex items-center justify-center text-xs shrink-0">
                      {member.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="overflow-hidden">
                      <h4 className="text-xs font-semibold text-neutral-900 truncate">{member.name}</h4>
                      <p className="text-[10px] text-neutral-500 truncate">{member.email}</p>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full capitalize shrink-0 ${
                    member.role === 'admin' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-primary'
                  }`}>
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
