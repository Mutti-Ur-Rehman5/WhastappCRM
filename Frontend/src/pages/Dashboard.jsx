import React from 'react';
import { useAuthStore } from '../store/authStore.js';

export default function Dashboard() {
  const { user } = useAuthStore();
  
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-950">Hello, {user?.name}!</h1>
        <p className="text-neutral-500 text-sm mt-1">Welcome to your WaCRM workspace. You are logged in as an <span className="font-semibold capitalize text-primary">{user?.role}</span>.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider">Total Leads</h3>
          <p className="text-3xl font-bold text-neutral-950 mt-2">0</p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider">Active Deals</h3>
          <p className="text-3xl font-bold text-neutral-950 mt-2">0</p>
        </div>
        <div className="bg-white rounded-lg border border-neutral-200 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider">Total Messages</h3>
          <p className="text-3xl font-bold text-neutral-950 mt-2">0</p>
        </div>
      </div>
    </div>
  );
}
