import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Pencil, X, CalendarX, AlertCircle, Users, CalendarCheck, TrendingUp, Search, Calendar, Phone, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api.js';

const PAGE_SIZE = 20;

const STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'no-show': 'No-show',
  rescheduled: 'Rescheduled',
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nextDayStr() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const listVariants = {
  animate: { transition: { staggerChildren: 0.03 } },
};

const rowVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, x: -20, height: 0, paddingTop: 0, paddingBottom: 0, borderBottomWidth: 0, transition: { duration: 0.3, ease: 'easeIn' } },
};

const statCardVariants = {
  initial: { opacity: 0, y: 12, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
};

function AnimatedNumber({ value, duration = 600 }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const start = display;
    const diff = value - start;
    if (diff === 0) return;
    const startTime = performance.now();
    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(start + diff * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [value, duration]);
  return <span className="counter-value">{display}</span>;
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <tr key={i} className="skeleton-row">
          <td><div className="skeleton" style={{ width: 30, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 120, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 90, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 90, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 50, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 70, height: 14, borderRadius: 999 }} /></td>
          <td><div className="skeleton" style={{ width: 100, height: 14 }} /></td>
          <td><div className="skeleton" style={{ width: 80, height: 14 }} /></td>
        </tr>
      ))}
    </>
  );
}

export default function Appointments() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState({ date: '', status: '', patientName: '', patientPhone: '' });
  const [showPast, setShowPast] = useState(false);
  const [rescheduling, setRescheduling] = useState(null);
  const [dailyCount, setDailyCount] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (showPast) params.set('showPast', 'true');
      if (filters.date) params.set('date', filters.date);
      if (filters.status) params.set('status', filters.status);
      if (filters.patientName) params.set('patientName', filters.patientName);
      if (filters.patientPhone) params.set('patientPhone', filters.patientPhone);
      const body = await api(`/api/appointments?${params.toString()}`);
      setRows(body.data);
      setTotal(body.pagination.total);
      setDailyCount(body.dailyCount || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, filters, showPast]);

  useEffect(() => {
    load();
  }, [load]);

  function applyFilter(patch) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  }

  async function doCancel(row) {
    setCancelling(null);
    setError('');
    setNotice('');
    try {
      await api(`/api/appointments/${row._id}`, { method: 'DELETE' });
      setNotice(`Cancelled appointment for ${row.patientName}.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilterCount = [filters.date, filters.status, filters.patientName, filters.patientPhone].filter(Boolean).length;

  return (
    <motion.div
      className="appt"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* ── Page Header ──────────────────────────────────────────────── */}
      <div className="appt-hero">
        <div className="appt-hero-content">
          <motion.div
            className="appt-hero-badge"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, duration: 0.3 }}
          >
            <CalendarCheck size={14} />
            <span>Appointments</span>
          </motion.div>
          <motion.h1
            className="appt-hero-title"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.3 }}
          >
            Appointment Dashboard
          </motion.h1>
          <motion.p
            className="appt-hero-sub"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.3 }}
          >
            Manage patient visits, track bookings, and keep your clinic schedule running smoothly.
          </motion.p>
        </div>
        <div className="appt-hero-pattern" aria-hidden="true">
          <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="100" cy="100" r="80" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="55" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="30" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5" />
            <path d="M100 20 L100 180 M20 100 L180 100" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          </svg>
        </div>
      </div>

      {/* ── Stat Cards ───────────────────────────────────────────────── */}
      {dailyCount && (
        <motion.div
          className="appt-stats"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <motion.div
            className="appt-stat"
            variants={statCardVariants}
            initial="initial"
            animate="animate"
            transition={{ delay: 0.05, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="appt-stat-icon appt-stat-icon--brand">
              <CalendarCheck size={18} />
            </div>
            <div className="appt-stat-body">
              <span className="appt-stat-label">Booked Today</span>
              <span className="appt-stat-value">
                <AnimatedNumber value={dailyCount.booked} />
                <span className="appt-stat-total"> / {dailyCount.maxTokensPerDay}</span>
              </span>
            </div>
            <div className="appt-stat-bar">
              <div
                className="appt-stat-bar-fill"
                style={{ width: `${Math.min(100, (dailyCount.booked / dailyCount.maxTokensPerDay) * 100)}%` }}
              />
            </div>
          </motion.div>

          <motion.div
            className="appt-stat"
            variants={statCardVariants}
            initial="initial"
            animate="animate"
            transition={{ delay: 0.1, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="appt-stat-icon appt-stat-icon--green">
              <TrendingUp size={18} />
            </div>
            <div className="appt-stat-body">
              <span className="appt-stat-label">Available</span>
              <span className="appt-stat-value">
                <AnimatedNumber value={Math.max(0, dailyCount.maxTokensPerDay - dailyCount.booked)} />
              </span>
            </div>
          </motion.div>

          <motion.div
            className="appt-stat"
            variants={statCardVariants}
            initial="initial"
            animate="animate"
            transition={{ delay: 0.15, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="appt-stat-icon appt-stat-icon--amber">
              <Users size={18} />
            </div>
            <div className="appt-stat-body">
              <span className="appt-stat-label">Total Matches</span>
              <span className="appt-stat-value"><AnimatedNumber value={total} /></span>
            </div>
          </motion.div>

          {dailyCount.booked >= dailyCount.maxTokensPerDay && (
            <motion.div
              className="appt-stat appt-stat--full"
              variants={statCardVariants}
              initial="initial"
              animate="animate"
              transition={{ delay: 0.2, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="appt-stat-icon appt-stat-icon--red">
                <AlertCircle size={18} />
              </div>
              <div className="appt-stat-body">
                <span className="appt-stat-label">Status</span>
                <span className="appt-stat-value appt-stat-value--red">FULL</span>
              </div>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* ── Filter Bar ───────────────────────────────────────────────── */}
      <motion.div
        className="appt-filters"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.3 }}
      >
        <div className="appt-filters-row">
          <div className="appt-filter-field">
            <Calendar size={14} className="appt-filter-icon" />
            <input placeholder="Date (YYYY-MM-DD)" value={filters.date} onChange={(e) => applyFilter({ date: e.target.value })} />
          </div>
          <div className="appt-filter-field">
            <Search size={14} className="appt-filter-icon" />
            <input placeholder="Patient name" value={filters.patientName} onChange={(e) => applyFilter({ patientName: e.target.value })} />
          </div>
          <div className="appt-filter-field">
            <Phone size={14} className="appt-filter-icon" />
            <input placeholder="Phone number" value={filters.patientPhone} onChange={(e) => applyFilter({ patientPhone: e.target.value })} />
          </div>
          <select value={filters.status} onChange={(e) => applyFilter({ status: e.target.value })}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="appt-checkbox">
            <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
            <span>Show past</span>
          </label>
          {activeFilterCount > 0 && (
            <button className="appt-filter-clear ghost" type="button" onClick={() => { setFilters({ date: '', status: '', patientName: '', patientPhone: '' }); setPage(0); }}>
              <X size={13} /> Clear ({activeFilterCount})
            </button>
          )}
        </div>
        <p className="appt-filters-hint">
          Cancelled/completed and past-time appointments are hidden by default. Use &ldquo;Show past&rdquo; to include them.
        </p>
      </motion.div>

      {/* ── Alerts ───────────────────────────────────────────────────── */}
      <AnimatePresence>
        {notice && (
          <motion.div className="notice" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {notice}
          </motion.div>
        )}
      </AnimatePresence>
      {error && <div className="error">{error}</div>}

      {/* ── Table ────────────────────────────────────────────────────── */}
      <div className="appt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Patient</th>
              <th>Phone</th>
              <th>Date</th>
              <th>Time</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <SkeletonRows />
            ) : (
              <AnimatePresence mode="popLayout">
                {rows.map((r) => (
                  <motion.tr
                    key={r._id}
                    className="table-row"
                    variants={rowVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    layout
                  >
                    <td className="appt-td-token" data-label="Token"><span className="appt-token">#{r.tokenNo}</span></td>
                    <td className="appt-td-patient" data-label="Patient">
                      <span
                        className="patient-avatar"
                        style={{
                          background: `hsl(${(r.patientName || '').charCodeAt(0) * 7 % 360}, 55%, 92%)`,
                          color: `hsl(${(r.patientName || '').charCodeAt(0) * 7 % 360}, 55%, 35%)`,
                        }}
                      >
                        {getInitials(r.patientName)}
                      </span>
                      {r.patientName}
                    </td>
                    <td className="appt-td-phone" data-label="Phone">{r.patientPhone}</td>
                    <td className="appt-td-date" data-label="Date">{r.date}</td>
                    <td className="appt-td-time" data-label="Time">{r.time}</td>
                    <td className="appt-td-status" data-label="Status">
                      <motion.span
                        className={`badge ${r.status || ''}`}
                        key={r.status}
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                      >
                        <span className="badge-dot" />
                        {STATUS_LABELS[r.status] || r.status}
                      </motion.span>
                      {r.pendingReschedule && (
                        <motion.span
                          className="badge pending"
                          title={`Proposed: ${r.pendingReschedule.newDate} ${r.pendingReschedule.newTime}`}
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ type: 'spring', stiffness: 400, damping: 20, delay: 0.1 }}
                        >
                          <span className="badge-dot" />
                          Awaiting confirm
                        </motion.span>
                      )}
                    </td>
                    <td className="appt-td-reason muted" data-label="Reason">{r.reason || '\u2014'}</td>
                    <td className="appt-td-actions" data-label="Actions">
                      <motion.button
                        type="button"
                        className="action-icon-btn"
                        onClick={() => setRescheduling(r)}
                        disabled={r.status !== 'confirmed' || Boolean(r.pendingReschedule)}
                        title="Reschedule"
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.96 }}
                      >
                        <Pencil size={14} /> Reschedule
                      </motion.button>
                      <motion.button
                        type="button"
                        className="action-icon-btn danger"
                        onClick={() => setCancelling(r)}
                        disabled={r.status !== 'confirmed'}
                        title="Cancel"
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.96 }}
                      >
                        <X size={14} /> Cancel
                      </motion.button>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan="8">
                  <div className="empty-state">
                    <CalendarX size={48} strokeWidth={1.2} />
                    <p>No appointments match your filters.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ───────────────────────────────────────────────── */}
      <div className="pager">
        <motion.button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} whileHover={{ scale: page === 0 ? 1 : 1.02 }} whileTap={{ scale: 0.96 }}>
          <ChevronLeft size={15} /> Prev
        </motion.button>
        <span className="pager-info">
          Page {page + 1} of {pages} &middot; {total} total
        </span>
        <motion.button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} whileHover={{ scale: page + 1 >= pages ? 1 : 1.02 }} whileTap={{ scale: 0.96 }}>
          Next <ChevronRight size={15} />
        </motion.button>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────── */}
      <AnimatePresence>
        {rescheduling && <RescheduleModal row={rescheduling} onClose={() => setRescheduling(null)} onDone={() => { setRescheduling(null); load(); }} />}
        {cancelling && <CancelModal row={cancelling} onConfirm={() => doCancel(cancelling)} onClose={() => setCancelling(null)} />}
      </AnimatePresence>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Modal Helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const backdropVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

const modalVariants = {
  initial: { opacity: 0, scale: 0.95, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, scale: 0.95, y: 10, transition: { duration: 0.15 } },
};

function CancelModal({ row, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    await onConfirm();
    setBusy(false);
  }

  return (
    <motion.div className="modal-backdrop" onClick={onClose} variants={backdropVariants} initial="initial" animate="animate" exit="exit">
      <motion.div className="modal card" onClick={(e) => e.stopPropagation()} variants={modalVariants} initial="initial" animate="animate" exit="exit">
        <h3>Cancel Appointment</h3>
        <p style={{ margin: 0 }}>
          Are you sure you want to cancel the appointment for{' '}
          <strong>{row.patientName}</strong> (Token #{row.tokenNo}) on {row.date} at {row.time}?
        </p>
        <div className="modal-actions">
          <motion.button type="button" className="ghost" onClick={onClose} disabled={busy} whileTap={{ scale: 0.97 }}>Keep appointment</motion.button>
          <motion.button type="button" onClick={handleConfirm} disabled={busy} whileTap={{ scale: 0.97 }} style={{ background: 'var(--danger)' }}>
            {busy ? <span className="btn-loading"><span className="spinner sm" /> Cancelling…</span> : 'Yes, cancel'}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function RescheduleModal({ row, onClose, onDone }) {
  const [date, setDate] = useState(nextDayStr());
  const [slots, setSlots] = useState([]);
  const [time, setTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setTime('');
    api(`/api/appointments/${row._id}/available-slots?date=${date}`)
      .then((body) => {
        if (cancelled) return;
        setSlots(body.slots || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, row._id]);

  async function submit(e) {
    e.preventDefault();
    if (!time) return;
    setError('');
    try {
      const body = await api(`/api/appointments/${row._id}/reschedule`, { method: 'PATCH', body: { date, time } });
      if (body.reschedulePending) {
        setSent({ newDate: date, newTime: time, message: body.message });
      } else {
        onDone();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  if (sent) {
    return (
      <motion.div className="modal-backdrop" onClick={onClose} variants={backdropVariants} initial="initial" animate="animate" exit="exit">
        <motion.div className="modal card" onClick={(e) => e.stopPropagation()} variants={modalVariants} initial="initial" animate="animate" exit="exit">
          <h3>Reschedule — {row.patientName}</h3>
          <div className="notice">
            Proposal for {sent.newDate} at {sent.newTime} sent to the patient on WhatsApp.
            {sent.message ? ` ${sent.message}` : ''}
            The appointment will move only once they tap Yes.
          </div>
          <div className="modal-actions">
            <motion.button type="button" onClick={onDone} whileTap={{ scale: 0.97 }}>Done</motion.button>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div className="modal-backdrop" onClick={onClose} variants={backdropVariants} initial="initial" animate="animate" exit="exit">
      <motion.form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit} variants={modalVariants} initial="initial" animate="animate" exit="exit">
        <h3>Reschedule — {row.patientName}</h3>
        <p className="muted" style={{ margin: 0 }}>
          Token #{row.tokenNo} · currently {row.date} at {row.time}
        </p>
        <label>
          New date
          <input type="date" min={todayStr()} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          New time
          <select value={time} onChange={(e) => setTime(e.target.value)} disabled={loading || slots.length === 0}>
            <option value="">{loading ? 'Loading…' : slots.length === 0 ? 'No available slots' : 'Choose a time'}</option>
            {slots.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <motion.button type="button" className="ghost" onClick={onClose} whileTap={{ scale: 0.97 }}>Cancel</motion.button>
          <motion.button type="submit" disabled={!time} whileTap={{ scale: 0.97 }}>Propose reschedule</motion.button>
        </div>
      </motion.form>
    </motion.div>
  );
}
